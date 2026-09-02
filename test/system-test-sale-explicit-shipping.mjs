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
  section("=== Setup: an item in the STORE's own stock ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });

  section("=== A plain store sale, with no shipping requested, still creates no dispatch ===");
  const plainSaleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }], customer_name: "Walk-in" }), env, data: {},
  })).json();
  assert(!plainSaleRes.shipment_dispatch_id, "a plain store sale, with shipping not requested, correctly still creates no dispatch");

  section("=== CRITICAL: a store sale that EXPLICITLY requests shipping now creates a dispatch ===");
  const shippedSaleRes = await (await salesMod.onRequestPost({
    request: req({
      lines: [{ item_id: item.id, quantity: 1, description: "Peacock Applique", sale_price: 5000 }],
      customer_name: "Susan", ship_requested: true, shipping_address: "12 MG Road, Kochi",
    }), env, data: {},
  })).json();
  assert(shippedSaleRes.shipment_dispatch_id, "CRITICAL: explicitly requesting shipping on a store sale now correctly creates a dispatch, previously impossible regardless of intent");

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(shippedSaleRes.shipment_dispatch_id).first();
  assert(dispatch.from_site_id === store.id, "the dispatch correctly originates from the store, not a worker site");
  assert(dispatch.related_sale_id === shippedSaleRes.id, "the dispatch correctly links back to this sale directly");

  section("=== CRITICAL: the explicit shipping address is correctly used, not any saved party address ===");
  const detail = await (await dispatchDetailMod.onRequestGet({ params: { id: shippedSaleRes.shipment_dispatch_id }, env })).json();
  assert(detail.shipping_address === "12 MG Road, Kochi", `CRITICAL: the one-off shipping address explicitly provided at sale time is correctly used, got "${detail.shipping_address}"`);
  assert(detail.shipping_name === "Susan", "the customer name is correctly resolved too");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
