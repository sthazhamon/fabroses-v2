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
  section("=== Setup: a customer order ready to bill ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const salesMod = await import("../functions/api/sales.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: item.id, quantity: 2 }] }), env })).json();

  section("=== Billing now goes through the normal Sales creation endpoint, with FULL tax control ===");
  const saleRes = await (await salesMod.onRequestPost({
    request: req({
      lines: [{ item_id: item.id, quantity: 2, description: "Saree x2", sale_price: 2500, tax_rate: 12 }], // tax_rate freely set here — the old shortcut never allowed this
      customer_name: "Susan", fulfills_customer_order_id: co.id,
    }), env, data: { user: { name: "Admin" } },
  })).json();
  assert(saleRes.id, "sale created successfully through the normal path");
  assert(saleRes.lines[0].tax_amount === 300, `full tax control confirmed working — 12% of the line's 2500 = 300 (got ${saleRes.lines[0].tax_amount})`);

  section("=== The customer order correctly gets marked billed, exactly like the old shortcut used to do ===");
  const coDetailMod = await import("../functions/api/customer-orders/[id].js");
  const coAfter = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(coAfter.status === "billed" && coAfter.sale_id === saleRes.id, "customer order correctly shows billed, linked to the real sale");

  section("=== Can't bill an already-billed order a second time this way ===");
  const doubleAttempt = await (await salesMod.onRequestPost({
    request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Again", sale_price: 2500 }], customer_name: "Susan", fulfills_customer_order_id: co.id }), env, data: {},
  })).json();
  assert(doubleAttempt.error, "attempting to fulfill an already-billed order again is rejected");

  section("=== A normal sale with NO customer order link still works exactly as before ===");
  const plainSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Walk-in", sale_price: 2500 }], customer_name: "Walk-in" }), env, data: {} })).json();
  assert(plainSale.id, "a plain walk-in sale with no CO link works unaffected by any of this");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
