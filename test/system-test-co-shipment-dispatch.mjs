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
  section("=== Setup: a customer order ready to bill, with a specific lot chosen ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const salesMod = await import("../functions/api/sales.js");
  const { confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Anu", items: [{ item_id: item.id, quantity: 2 }] }), env })).json();

  section("=== Billing (with a chosen lot, dropdown-style) auto-creates a real shipment dispatch ===");
  const saleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, lot_id: lot.id, quantity: 2, description: "Saree x2", sale_price: 5000 }], customer_name: "Anu", fulfills_customer_order_id: co.id }), env, data: { user: { name: "Admin" } },
  })).json();
  assert(saleRes.shipment_dispatch_id, "a real dispatch is created automatically, no manual 'Go ship' trigger needed");

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(saleRes.shipment_dispatch_id).first();
  assert(dispatch.dispatch_type === "customer_shipment" && dispatch.to_site_id === null && dispatch.related_customer_order_id === co.id,
    "the dispatch is correctly typed, has no internal destination site (the customer isn't one), and links back to the order");

  const dispatchItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatch.id).first();
  assert(dispatchItem.lot_id === lot.id, "the dispatch carries the EXACT lot chosen at billing — this is what the dispatcher will verify against");

  section("=== CRITICAL: billing already decremented stock — shipping must not decrement it again ===");
  const stockAfterBilling = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(stockAfterBilling.quantity_balance === 3, `billing correctly decremented 5 -> 3 immediately (got ${stockAfterBilling.quantity_balance})`);

  await confirmPick(env, dispatch.id, { item_id: item.id, lot_id: lot.id, scanned_quantity: 2 });
  await shipDispatch(env, dispatch.id, { courier: "BlueDart", tracking_id: "BD123" }, "dispatcher");

  const stockAfterShipping = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(stockAfterShipping.quantity_balance === 3, `CRITICAL: stock is STILL 3 after shipping — no double-decrement (got ${stockAfterShipping.quantity_balance})`);

  section("=== Shipping IS the final step — the order flips straight to shipped ===");
  const coAfterShip = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(coAfterShip.status === "shipped" && coAfterShip.courier === "BlueDart" && coAfterShip.tracking_id === "BD123",
    "the order correctly shows shipped with the courier/tracking captured at the dispatch's ship step");

  section("=== There's no confirm-receive stage for this dispatch type — attempting one is rejected ===");
  const { confirmReceive } = await import("../functions/api/_dispatch.js");
  const receiveAttempt = await confirmReceive(env, dispatch.id, [{ dispatch_item_id: dispatchItem.id, received_quantity: 2 }], "someone");
  assert(receiveAttempt.error, "attempting to confirm-receive a customer shipment is correctly rejected — it already finished at ship time");

  section("=== The old direct shortcut is genuinely gone ===");
  const fs = await import("fs");
  const shipFileExists = fs.existsSync(new URL("../functions/api/customer-orders/[id]/ship.js", import.meta.url));
  assert(!shipFileExists, "the retired ship.js endpoint file no longer exists");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
