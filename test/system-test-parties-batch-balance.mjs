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
  section("=== Setup: a customer with a billed sale, a supplier with a bill, and a party with no activity ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const sbMod = await import("../functions/api/supplier-bills.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });

  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_party_id: customer.id, customer_name: null }), env, data: {} });

  const supplier = await (await partiesMod.onRequestPost({ request: req({ name: "Cotton Threads", type: "supplier" }), env })).json();
  await sbMod.onRequestPost({ request: req({ supplier_party_id: supplier.id, supplier_name: "Cotton Threads", lines: [{ quantity: 5, rate: 200 }] }), env, data: {} });

  const inactive = await (await partiesMod.onRequestPost({ request: req({ name: "No Activity Party", type: "customer", opening_balance: 100 }), env })).json();

  section("=== The batched list endpoint produces the correct balance for each party ===");
  const list = await (await partiesMod.onRequestGet({ env })).json();
  const customerEntry = list.find(function (p) { return p.id === customer.id; });
  const supplierEntry = list.find(function (p) { return p.id === supplier.id; });
  const inactiveEntry = list.find(function (p) { return p.id === inactive.id; });

  assert(customerEntry.balance === 5000, "CRITICAL: the customer with an unpaid 5000 sale correctly shows a 5000 balance (asset account)");
  assert(supplierEntry.balance === 1000, "CRITICAL: the supplier with an unpaid 1000 bill correctly shows a 1000 balance (liability account)");
  assert(inactiveEntry.balance === 100, "CRITICAL: a party with zero journal activity correctly falls back to their opening_balance");

  section("=== These match exactly what computeBalance would give for the same party individually ===");
  const customerRow = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(customer.id).first();
  const individualResult = await partiesMod.computeBalance(env, customerRow);
  assert(individualResult.balance === customerEntry.balance, "CRITICAL: the batched list computation matches the individual computeBalance function exactly");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch(function (e) { console.error("CRASHED:", e); process.exit(1); });
