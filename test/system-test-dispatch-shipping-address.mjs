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
  section("=== A stock_transfer dispatch resolves the destination site's own address ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch } = await import("../functions/api/_dispatch.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  await env.DB.prepare("UPDATE sites SET address = ? WHERE id = ?").bind("Zakir's Workshop, Fort Kochi", worker.id).run();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const transferDispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 5 }] });
  const transferDetail = await (await dispatchDetailMod.onRequestGet({ params: { id: transferDispatchId }, env })).json();
  assert(transferDetail.shipping_address === "Zakir's Workshop, Fort Kochi", "CRITICAL: a stock transfer correctly resolves the destination site's own address");

  section("=== A customer_shipment resolves the CO's own delivery address, not the party's default ===");
  const partiesMod = await import("../functions/api/parties.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const salesMod = await import("../functions/api/sales.js");

  const finished = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: finished.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer", address: "12 MG Road, Kochi" }), env })).json();
  const co = await (await coMod.onRequestPost({ request: req({ customer_party_id: customer.id, customer_name: "Susan", delivery_address: "Gift address: 5 Beach Road, Kovalam", items: [{ item_id: finished.id, quantity: 1 }] }), env })).json();
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: finished.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null, fulfills_customer_order_id: co.id }), env, data: {} });

  const shipmentDispatch = await env.DB.prepare("SELECT id FROM dispatches WHERE related_customer_order_id = ?").bind(co.id).first();
  const shipmentDetail = await (await dispatchDetailMod.onRequestGet({ params: { id: shipmentDispatch.id }, env })).json();
  assert(shipmentDetail.shipping_address === "Gift address: 5 Beach Road, Kovalam", "CRITICAL: the CO's own override delivery address is used, not the party's default");
  assert(shipmentDetail.shipping_name === "Susan", "the customer's name is correctly included for the label");

  section("=== With no override, the customer's own party address is used as a fallback ===");
  const co2 = await (await coMod.onRequestPost({ request: req({ customer_party_id: customer.id, customer_name: "Susan", items: [{ item_id: finished.id, quantity: 1 }] }), env })).json();
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: finished.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null, fulfills_customer_order_id: co2.id }), env, data: {} });
  const shipmentDispatch2 = await env.DB.prepare("SELECT id FROM dispatches WHERE related_customer_order_id = ?").bind(co2.id).first();
  const shipmentDetail2 = await (await dispatchDetailMod.onRequestGet({ params: { id: shipmentDispatch2.id }, env })).json();
  assert(shipmentDetail2.shipping_address === "12 MG Road, Kochi", "CRITICAL: with no delivery address override, the customer's own party address is correctly used as the fallback");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
