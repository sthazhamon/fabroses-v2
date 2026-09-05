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
  section("=== Setup: the exact reported scenario - a raw material received via PO, then transferred between sites ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const historyMod = await import("../functions/api/item-lots/[id]/history.js");

  const supplierWarehouse = await (await sitesMod.onRequestPost({ request: req({ name: "FB Store 1", site_type: "store" }), env })).json();
  const otherStore = await (await sitesMod.onRequestPost({ request: req({ name: "Second Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Peacock Applique Green" }), env })).json();

  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 10, rate: 400 }] }), env })).json();
  const poLine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];
  const receiveRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 10, site_id: otherStore.id }), env, params: { id: poLine.id } })).json();
  const originalLotId = receiveRes.lot_id;

  // A partial transfer: 4 of the 10 units move, 6 stay behind - the exact
  // real-world case that makes "one lot, one current site" impossible, and
  // exactly why the origin ID (not a single mutable site field) is the
  // right stable identifier.
  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: otherStore.id, to_site_id: supplierWarehouse.id, items: [{ item_id: item.id, lot_id: originalLotId, expected_quantity: 4 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: originalLotId, scanned_quantity: 4 });
  await shipDispatch(env, dispatchId, {}, "staff");
  const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  await confirmReceive(env, dispatchId, [{ dispatch_item_id: shippedItem.id, received_quantity: 4 }], "Fab Roses");

  const newLot = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, supplierWarehouse.id).first();
  assert(newLot.origin_lot_id === originalLotId, "the transferred lot correctly retains a link back to the original, stable PO-received lot number");

  section("=== CRITICAL: looking up history by the STABLE (origin) number now shows the FULL journey in one place ===");
  const historyRes = await (await historyMod.onRequestGet({ env, params: { id: originalLotId } })).json();

  assert(historyRes.movements.some((m) => m.event_type === "received"), "CRITICAL: the original PO receipt event is visible");
  assert(historyRes.movements.some((m) => m.event_type === "transferred_out"), "CRITICAL: the transfer-out from the original site is visible");
  assert(historyRes.movements.some((m) => m.event_type === "transferred_in"), "CRITICAL: the transfer-in at the destination is visible - all in ONE combined view, not split across separate lookups");

  section("=== CRITICAL: the split is correctly shown - the same stable number sits at TWO sites at once ===");
  assert(historyRes.current_sites.length === 2, `CRITICAL: the material correctly shows as sitting at 2 sites simultaneously under the same stable number, got ${historyRes.current_sites.length}`);
  const atOriginal = historyRes.current_sites.find((s) => s.site_name === "Second Store");
  const atDestination = historyRes.current_sites.find((s) => s.site_name === "FB Store 1");
  assert(atOriginal && atOriginal.quantity_balance === 6, `CRITICAL: 6 units correctly remain at the original site, got ${atOriginal?.quantity_balance}`);
  assert(atDestination && atDestination.quantity_balance === 4, `CRITICAL: 4 units correctly show at the destination site, got ${atDestination?.quantity_balance}`);
  assert(historyRes.total_balance === 10, `the combined total across all sites correctly still adds up to the original 10, got ${historyRes.total_balance}`);

  section("=== Looking up by the per-site (transferred) lot's own ID still correctly resolves to the same, full picture ===");
  const historyByChildId = await (await historyMod.onRequestGet({ env, params: { id: newLot.id } })).json();
  assert(historyByChildId.movements.length === historyRes.movements.length, "looking up by either the origin or any per-site child lot gives the identical, complete journey");

  section("=== A raw material correctly has no BOM consumption of its own, since nothing was made to create it ===");
  assert(historyRes.bom_consumption.length === 0, "correctly empty - a PO-received raw material was never produced from anything");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
