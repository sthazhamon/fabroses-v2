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
  section("=== Setup: a lot received at the worker, then transferred to the store - a NEW lot id at the destination ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique Green" }), env })).json();
  const originLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 2, source_type: "work_order_output" }), env, data: {} })).json();

  // The material physically moves from worker to store - this creates a
  // brand new lot id at the destination, exactly as reported.
  const dispatchId = await createDispatch(env, { dispatch_type: "return_shipment", from_site_id: worker.id, to_site_id: store.id, items: [{ item_id: item.id, lot_id: originLot.id, expected_quantity: 2 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: originLot.id, scanned_quantity: 2 });
  await shipDispatch(env, dispatchId, {}, "Zakir");
  const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  await confirmReceive(env, dispatchId, [{ dispatch_item_id: shippedItem.id, received_quantity: 2 }], "Store staff");

  const newLot = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, store.id).first();
  assert(newLot.id !== originLot.id, `confirmed the destination genuinely has a DIFFERENT lot id, got ${newLot.id} vs original ${originLot.id}`);
  assert(newLot.origin_lot_id === originLot.id, "the new lot correctly traces its origin back to the original one");

  section("=== CRITICAL: a QR printed for the ORIGINAL lot still correctly scans against a later dispatch of the NEW lot ===");
  const dispatch2Id = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: newLot.id, expected_quantity: 1 }] });

  // Scanning the ORIGINAL lot id (as printed on a QR from before the
  // transfer ever happened) against a dispatch that actually expects the
  // NEW lot id.
  const pickRes = await confirmPick(env, dispatch2Id, { item_id: item.id, lot_id: originLot.id, scanned_quantity: 1 });
  assert(!pickRes.error, `CRITICAL: the pick correctly succeeds even though the scanned lot id (${originLot.id}) differs from the dispatch's own current lot id (${newLot.id}) - they share the same origin`);

  await shipDispatch(env, dispatch2Id, {}, "store staff");
  const shipped2Item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch2Id).first();
  const receiveRes = await confirmReceive(env, dispatch2Id, [{ dispatch_item_id: shipped2Item.id, received_quantity: 1, scanned_item_id: item.id, scanned_lot_id: originLot.id }], "Zakir");
  assert(!receiveRes.error, "CRITICAL: the receive-side scan verification also correctly accepts the original lot id via shared origin");

  section("=== A genuinely different, unrelated lot is still correctly rejected - this hasn't become overly lenient ===");
  const unrelatedLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const dispatch3Id = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: newLot.id, expected_quantity: 1 }] });
  const wrongPickRes = await confirmPick(env, dispatch3Id, { item_id: item.id, lot_id: unrelatedLot.id, scanned_quantity: 1 });
  assert(wrongPickRes.mismatch === true, "CRITICAL: an unrelated lot with no shared origin is still correctly rejected as a mismatch");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
