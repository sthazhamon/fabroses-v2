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
  section("=== A fresh PO delivery is its own origin ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const returnMaterialMod = await import("../functions/api/return-material.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: item.id, quantity_ordered: 20, rate: 100 }] }), env })).json();
  const line = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];
  const receiveRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 20 }), env, params: { id: line.id } })).json();

  const originalLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(receiveRes.lot_id).first();
  assert(originalLot.origin_lot_id === null, "a fresh PO delivery correctly has no origin recorded - it IS the origin");

  section("=== Hop 1: transferring it to a worker inherits that same origin ===");
  const dispatch1 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: receiveRes.lot_id, expected_quantity: 20 }] });
  await confirmPick(env, dispatch1, { item_id: item.id, lot_id: receiveRes.lot_id, scanned_quantity: 20 });
  await shipDispatch(env, dispatch1, {}, "store staff");
  const dItem1 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch1).first();
  const receive1 = await confirmReceive(env, dispatch1, [{ dispatch_item_id: dItem1.id, received_quantity: 20 }], "Zakir");

  const workerLotId = receive1.created_lot_ids[0].lot_id;
  const workerLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(workerLotId).first();
  assert(workerLot.origin_lot_id === receiveRes.lot_id, "CRITICAL: the lot at the worker's site correctly traces back to the ORIGINAL PO delivery, not a fresh identity, got " + workerLot.origin_lot_id);

  section("=== Hop 2: returning half of it to store ALSO keeps the same origin ===");
  const returnRes = await (await returnMaterialMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: workerLotId, quantity: 10 }), env })).json();
  await confirmPick(env, returnRes.dispatch_id, { item_id: item.id, lot_id: workerLotId, scanned_quantity: 10 });
  await shipDispatch(env, returnRes.dispatch_id, {}, "Zakir");
  const dItem2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(returnRes.dispatch_id).first();
  const receive2 = await confirmReceive(env, returnRes.dispatch_id, [{ dispatch_item_id: dItem2.id, received_quantity: 10 }], "Store staff");

  const returnedLotId = receive2.created_lot_ids[0].lot_id;
  const returnedLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(returnedLotId).first();
  assert(returnedLot.origin_lot_id === receiveRes.lot_id, "CRITICAL: after TWO hops (store->worker->store), the origin STILL correctly points to the very first PO delivery, got " + returnedLot.origin_lot_id);

  section("=== Hop 3: sending it back out to a SECOND worker preserves the SAME origin again ===");
  const worker2 = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  const dispatch3 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker2.id, items: [{ item_id: item.id, lot_id: returnedLotId, expected_quantity: 10 }] });
  await confirmPick(env, dispatch3, { item_id: item.id, lot_id: returnedLotId, scanned_quantity: 10 });
  await shipDispatch(env, dispatch3, {}, "store staff");
  const dItem3 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch3).first();
  const receive3 = await confirmReceive(env, dispatch3, [{ dispatch_item_id: dItem3.id, received_quantity: 10 }], "Mortaja");

  const worker2LotId = receive3.created_lot_ids[0].lot_id;
  const worker2Lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(worker2LotId).first();
  assert(worker2Lot.origin_lot_id === receiveRes.lot_id, "CRITICAL: after THREE full hops, the SAME original PO delivery is still correctly the recorded origin, got " + worker2Lot.origin_lot_id);

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
