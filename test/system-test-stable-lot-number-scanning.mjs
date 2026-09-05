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
  section("=== Setup: a lot printed once at the store, then moved TWICE since - simulating a QR label that's now 'stale' by lot_id but should still work ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const workerA = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const workerB = await (await sitesMod.onRequestPost({ request: req({ name: "Anwar", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota Fabric" }), env })).json();

  // This is the ORIGINAL lot - imagine a QR was printed for this the day it arrived.
  const originalLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const stableLotNumber = originalLot.id; // This is what the printed QR encodes - forever.

  // Move 1: store -> worker A
  const dispatch1 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: workerA.id, items: [{ item_id: item.id, lot_id: originalLot.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatch1, { item_id: item.id, lot_id: originalLot.id, scanned_quantity: 5 });
  await shipDispatch(env, dispatch1, {}, "staff");
  const item1 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch1).first();
  await confirmReceive(env, dispatch1, [{ dispatch_item_id: item1.id, received_quantity: 5 }], "Zakir");
  const lotAtWorkerA = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, workerA.id).first();

  // Move 2: worker A -> worker B (a completely different lot_id by now)
  const dispatch2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: workerA.id, to_site_id: workerB.id, items: [{ item_id: item.id, lot_id: lotAtWorkerA.id, expected_quantity: 5 }] });
  await confirmPick(env, dispatch2, { item_id: item.id, lot_id: lotAtWorkerA.id, scanned_quantity: 5 });
  await shipDispatch(env, dispatch2, {}, "Zakir");
  const item2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch2).first();
  await confirmReceive(env, dispatch2, [{ dispatch_item_id: item2.id, received_quantity: 5 }], "Anwar");
  const lotAtWorkerB = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, workerB.id).first();

  assert(lotAtWorkerB.id !== stableLotNumber, `confirmed the material's per-site lot_id has genuinely changed twice since the original QR was printed (now ${lotAtWorkerB.id}, was ${stableLotNumber})`);

  section("=== CRITICAL: a THIRD move (worker B ships it onward) - scanning the ORIGINAL, once-printed number still works ===");
  const dispatch3 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: workerB.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: lotAtWorkerB.id, expected_quantity: 5 }] });

  // This is the actual test: scanning with the STABLE number from the
  // original label - printed potentially weeks ago, two moves back -
  // must still correctly match this dispatch's current expectation.
  const pickResult = await confirmPick(env, dispatch3, { item_id: item.id, lot_id: stableLotNumber, scanned_quantity: 5 });
  assert(!pickResult.error, `CRITICAL: scanning the ORIGINAL, stable lot number (from a QR printed two moves ago) correctly matches, got error: ${pickResult.error}`);
  assert(!pickResult.mismatch, "correctly not flagged as a mismatch");

  section("=== A genuinely different, unrelated item's stable number is still correctly rejected ===");
  const otherItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Unrelated Thread" }), env })).json();
  const otherLot = await (await lotsMod.onRequestPost({ request: req({ item_id: otherItem.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const dispatch4 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: workerA.id, items: [{ item_id: item.id, lot_id: originalLot.id, expected_quantity: 1 }] });
  const wrongScanResult = await confirmPick(env, dispatch4, { item_id: otherItem.id, lot_id: otherLot.id, scanned_quantity: 1 });
  assert(wrongScanResult.mismatch === true, "scanning a genuinely unrelated item's stable number is still correctly rejected as a mismatch");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
