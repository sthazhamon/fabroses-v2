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
  section("=== Sales GET includes customer_name and sale_date directly on each record ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const salesMod = await import("../functions/api/sales.js");
  const sbMod = await import("../functions/api/supplier-bills.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 5000 }], customer_name: "Susan", sale_date: "2026-08-10" }), env, data: {} });

  const salesList = await (await salesMod.onRequestGet({ env })).json();
  assert(salesList[0].customer_name === "Susan", "CRITICAL: the sale record directly includes customer_name");
  assert(salesList[0].sale_date === "2026-08-10", "the sale record directly includes sale_date");

  section("=== Supplier bills GET includes supplier_name and bill_date directly on each record ===");
  await sbMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", bill_date: "2026-08-05", lines: [{ quantity: 5, rate: 200 }] }), env, data: {} });
  const billsList = await (await sbMod.onRequestGet({ env })).json();
  assert(billsList[0].supplier_name === "Cotton Threads", "CRITICAL: the bill record directly includes supplier_name");
  assert(billsList[0].bill_date === "2026-08-05", "the bill record directly includes bill_date");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
