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

  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 1, rate: 400 }] }), env })).json();
  const poLine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];
  const receiveRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 1, site_id: otherStore.id }), env, params: { id: poLine.id } })).json();
  const originalLotId = receiveRes.lot_id;

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: otherStore.id, to_site_id: supplierWarehouse.id, items: [{ item_id: item.id, lot_id: originalLotId, expected_quantity: 1 }] });
  await confirmPick(env, dispatchId, { item_id: item.id, lot_id: originalLotId, scanned_quantity: 1 });
  await shipDispatch(env, dispatchId, {}, "staff");
  const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  await confirmReceive(env, dispatchId, [{ dispatch_item_id: shippedItem.id, received_quantity: 1 }], "Fab Roses");

  const newLot = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(item.id, supplierWarehouse.id).first();
  assert(newLot.origin_lot_id === originalLotId, "the transferred lot correctly retains a link back to the original PO-received lot");

  section("=== CRITICAL: the history of the transferred lot now surfaces the full origin chain, not just this one hop ===");
  const historyRes = await (await historyMod.onRequestGet({ env, params: { id: newLot.id } })).json();
  assert(historyRes.movements.length === 1 && historyRes.movements[0].event_type === "transferred_in", "this lot's own direct movement is still shown, exactly as before");
  assert(historyRes.origin_history !== null, "CRITICAL: origin_history is now populated - previously this was entirely absent from the response");
  assert(historyRes.origin_history.lot.id === originalLotId, "the origin history correctly points to the actual original PO-received lot");
  assert(historyRes.origin_history.movements.some((m) => m.event_type === "received"), "CRITICAL: the ORIGINAL receipt event from the PO is now visible - this is exactly what was reported missing");

  section("=== A raw material's origin correctly has no BOM consumption of its own, since nothing was made to create it ===");
  assert(historyRes.origin_history.bom_consumption.length === 0, "correctly empty - a PO-received raw material was never produced from anything");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
