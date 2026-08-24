import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log("  \x1b[32m\u2713\x1b[0m " + l); } else { failed++; console.log("  \x1b[31m\u2717 FAIL\x1b[0m " + l); } }
function section(t) { console.log("\n" + t); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== Setup: a shipped dispatch awaiting receipt ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const lotA = await (await lotsMod.onRequestPost({ request: req({ item_id: itemA.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: itemA.id, lot_id: lotA.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatchId, { item_id: itemA.id, lot_id: lotA.id, scanned_quantity: 5 });
  await shipDispatch(env, dispatchId, {}, "store staff");
  const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();

  section("=== CRITICAL: confirming with the WRONG scanned item is correctly rejected ===");
  const wrongItemRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 5, scanned_item_id: itemB.id }], "Zakir");
  assert(wrongItemRes.error && wrongItemRes.mismatch, "CRITICAL: scanning the wrong item at receive time is correctly rejected as a mismatch");

  const dItemAfterWrong = await env.DB.prepare("SELECT received_quantity FROM dispatch_items WHERE id = ?").bind(dItem.id).first();
  assert(dItemAfterWrong.received_quantity === null, "the mismatch is caught BEFORE anything is written");

  section("=== CRITICAL: confirming with the WRONG scanned lot is correctly rejected ===");
  const fakeLotId = "LOT-999999";
  const wrongLotRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 5, scanned_item_id: itemA.id, scanned_lot_id: fakeLotId }], "Zakir");
  assert(wrongLotRes.error && wrongLotRes.mismatch, "scanning the wrong lot at receive time is correctly rejected");

  section("=== The correct scanned item and lot succeed ===");
  const correctRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 5, scanned_item_id: itemA.id, scanned_lot_id: lotA.id }], "Zakir");
  assert(!correctRes.error, "confirming with the genuinely correct scanned item and lot succeeds");

  section("=== Backward compatibility: no scan provided still works, unchanged ===");
  const lotC = await (await lotsMod.onRequestPost({ request: req({ item_id: itemA.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();
  const dispatchId2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: itemA.id, lot_id: lotC.id, expected_quantity: 3 }] });
  await confirmPick(env, dispatchId2, { item_id: itemA.id, lot_id: lotC.id, scanned_quantity: 3 });
  await shipDispatch(env, dispatchId2, {}, "store staff");
  const dItem2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId2).first();
  const noScanRes = await confirmReceive(env, dispatchId2, [{ dispatch_item_id: dItem2.id, received_quantity: 3 }], "Zakir");
  assert(!noScanRes.error, "a confirmation with no scanned_item_id correctly still works, unchanged");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
