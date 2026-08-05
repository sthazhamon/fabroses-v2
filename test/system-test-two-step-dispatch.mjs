import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }
function section(t) { console.log(`\n${t}`); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== Setup ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota", unit_of_measure: "metre" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();

  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  section("=== Step 1: creating a dispatch doesn't move anything yet ===");
  const dispId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 10 }] });
  const lotAfterCreate = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfterCreate.quantity_balance === 20, "creating the dispatch alone doesn't touch the source lot at all yet");

  section("=== Step 2: confirming the pick, with mismatch detection ===");
  const mismatchPick = await confirmPick(env, dispId, { item_id: "ITM-999999", lot_id: lot.id, scanned_quantity: 10 });
  assert(mismatchPick.error, "scanning the WRONG item is caught as a mismatch, not silently accepted");

  const goodPick = await confirmPick(env, dispId, { item_id: item.id, lot_id: lot.id, scanned_quantity: 10 });
  assert(goodPick.ok && !goodPick.mismatch, "scanning the correct item at the correct quantity succeeds cleanly");

  section("=== Step 3: shipping decrements the SOURCE but does NOT credit the destination yet ===");
  const shipRes = await shipDispatch(env, dispId, { courier: "DTDC", tracking_id: "T1" }, "tester");
  assert(shipRes.ok, "shipping succeeds once picked");

  const lotAfterShip = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfterShip.quantity_balance === 10, "source lot correctly dropped from 20 to 10 — it genuinely left the store");

  const workerStockAfterShip = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE site_id = ?").bind(worker.id).first();
  assert(workerStockAfterShip.t === 0, "CRITICAL: the worker's site shows ZERO stock while it's still in transit — nothing landed prematurely, unlike the old one-shot behavior");

  const dispatchRow = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispId).first();
  assert(dispatchRow.status === "shipped", "dispatch status correctly shows 'shipped', not 'received' — it's genuinely in an intermediate state");

  section("=== Step 4: confirming receipt at the destination is what actually credits stock ===");
  const dispatchItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispId).first();
  const receiveRes = await confirmReceive(env, dispId, [{ dispatch_item_id: dispatchItem.id, received_quantity: 10 }], "tester");
  assert(receiveRes.ok, "confirming receipt succeeds");

  const workerStockAfterReceive = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE site_id = ?").bind(worker.id).first();
  assert(workerStockAfterReceive.t === 10, "NOW, and only now, the worker's stock shows the 10m — confirmed at the receiving end, not assumed at ship time");

  section("=== Partial receipt: shortage in transit is representable ===");
  const dispId2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 10 }] });
  await confirmPick(env, dispId2, { item_id: item.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, dispId2, {}, "tester");
  const dispatchItem2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispId2).first();
  await confirmReceive(env, dispId2, [{ dispatch_item_id: dispatchItem2.id, received_quantity: 8 }], "tester"); // 2 went missing in transit
  const workerStockFinal = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE site_id = ?").bind(worker.id).first();
  assert(workerStockFinal.t === 18, `receiving only 8 of the 10 shipped correctly credits just 8 (10 already there + 8 = 18, got ${workerStockFinal.t})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
