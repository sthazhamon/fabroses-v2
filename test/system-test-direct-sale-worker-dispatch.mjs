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
  section("=== Setup: an item only in stock at a worker's own site, not the store at all ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const workerPlaceMod = await import("../functions/api/worker-place.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 3, source_type: "work_order_output" }), env, data: {} });
  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer", address: "12 MG Road, Kochi" }), env })).json();

  section("=== CRITICAL: a direct, cash-style sale (no CO) against the worker's stock now creates a real dispatch ===");
  const saleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null }), env, data: {},
  })).json();
  assert(saleRes.shipment_dispatch_id, "CRITICAL: the direct sale from worker stock now correctly creates a shipment dispatch - previously none was ever created here at all");

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(saleRes.shipment_dispatch_id).first();
  assert(dispatch.dispatch_type === "customer_shipment" && dispatch.from_site_id === worker.id, "the dispatch correctly originates from the worker's own site");
  assert(dispatch.related_sale_id === saleRes.id && !dispatch.related_customer_order_id, "the dispatch correctly links back to the sale directly, since there's no CO behind it at all");

  section("=== CRITICAL: the worker can now actually see this in their own login ===");
  const workerPlaceRes = await (await workerPlaceMod.onRequestGet({ env, data: { user: { siteId: worker.id } } })).json();
  assert(workerPlaceRes.outgoing_to_ship.some((d) => d.id === saleRes.shipment_dispatch_id), "CRITICAL: the dispatch correctly appears in the worker's own 'outgoing to pick/ship' list - this was the exact reported gap");

  section("=== CRITICAL: the customer's own address correctly resolves as the ship-to, with no CO to pull it from ===");
  const dispatchDetail = await (await dispatchDetailMod.onRequestGet({ params: { id: saleRes.shipment_dispatch_id }, env })).json();
  assert(dispatchDetail.shipping_address === "12 MG Road, Kochi", `CRITICAL: the customer's own address is correctly resolved directly from the sale, with no CO involved at all - got "${dispatchDetail.shipping_address}"`);
  assert(dispatchDetail.shipping_name === "Susan", "the customer's name is correctly resolved too");

  section("=== A sale from the STORE's own stock still correctly needs no dispatch at all ===");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const storeLotRes = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const storeSaleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, lot_id: storeLotRes.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null }), env, data: {},
  })).json();
  assert(!storeSaleRes.shipment_dispatch_id, "CRITICAL: a sale explicitly from the store's own stock correctly still creates no dispatch - the item can just be handed over directly, no physical transport needed");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
