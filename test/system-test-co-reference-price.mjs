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
  section("=== Customer Order reference price ===");
  const itemsMod = await import("../functions/api/items.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const coDetailMod = await import("../functions/api/customer-orders/[id].js");
  const salesMod = await import("../functions/api/sales.js");

  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const sitesMod = await import("../functions/api/sites.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: item.id, quantity: 1, unit_price: 5000 }] }), env })).json();

  const detail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(detail.items[0].unit_price === 5000, "the reference price is correctly stored and returned on the order");

  section("=== It has zero effect on billing — Sales pricing stays completely independent ===");
  const saleRes = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 7500 }], customer_name: "Susan", fulfills_customer_order_id: co.id }), env, data: { user: { name: "Admin" } },
  })).json();
  assert(saleRes.total_amount === 7500, `CRITICAL: the sale correctly uses its own fresh price (7500), completely unaffected by the order's 5000 reference price, got ${saleRes.total_amount}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
