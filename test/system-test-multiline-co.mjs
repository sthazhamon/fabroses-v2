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
  section("=== Setup ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree", price: 5000 }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Blouse", price: 800 }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: itemA.id, site_id: store.id, quantity: 3, source_type: "opening_stock" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: itemB.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const anu = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();

  section("=== Creating a multi-item customer order ===");
  const coMod = await import("../functions/api/customer-orders.js");
  const co = await (await coMod.onRequestPost({
    request: req({ customer_party_id: anu.id, customer_name: "Anu", items: [{ item_id: itemA.id, quantity: 1, tax_rate: 12 }, { item_id: itemB.id, quantity: 2, tax_rate: 5 }] }), env,
  })).json();
  assert(co.id === "CO-000001", "created a two-line customer order");

  const coDetailMod = await import("../functions/api/customer-orders/[id].js");
  const detail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(detail.items.length === 2 && detail.items[0].current_stock !== null, "both lines present, each showing its own current stock as pure information");

  section("=== Billing ALL lines at once through the normal Sales path creates one multi-line sale ===");
  const salesModForBill = await import("../functions/api/sales.js");
  const itemALine = detail.items.find((i) => i.item_id === itemA.id);
  const itemBLine = detail.items.find((i) => i.item_id === itemB.id);

  const billRes = await (await salesModForBill.onRequestPost({
    request: req({
      lines: [
        { item_id: itemA.id, quantity: itemALine.quantity, description: "Item A", sale_price: 5000, tax_rate: itemALine.tax_rate },
        { item_id: itemB.id, quantity: itemBLine.quantity, description: "Item B", sale_price: 800, tax_rate: itemBLine.tax_rate },
      ],
      customer_name: "Anu", fulfills_customer_order_id: co.id,
    }), env, data: {},
  })).json();
  assert(billRes.id, "billing both lines through the normal Sales endpoint succeeds");

  const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(billRes.id).first();
  const saleLines = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(sale.id).all();
  assert(saleLines.results.length === 2, "the resulting sale has exactly 2 lines, matching the order's 2 lines");

  const coAfter = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(coAfter.status === "billed" && coAfter.sale_id === billRes.id, "the customer order correctly links to the resulting multi-line sale");

  const itemAStockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(itemA.id).first();
  const itemBStockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(itemB.id).first();
  assert(itemAStockAfter.t === 2 && itemBStockAfter.t === 3, `both items' stock dropped correctly and independently (A: 3-1=2, B: 5-2=3, got A=${itemAStockAfter.t}, B=${itemBStockAfter.t})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
