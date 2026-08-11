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
  section("=== A reseller order — previously impossible entirely ===");
  const itemsMod = await import("../functions/api/items.js");
  const coMod = await import("../functions/api/customer-orders.js");

  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const resellerOrder = await (await coMod.onRequestPost({ request: req({ reseller_name: "Cozy Resellers", items: [{ item_id: item.id, quantity: 3 }] }), env })).json();
  assert(resellerOrder.id, "an order with only reseller_name set (no customer_name) now succeeds");

  const orderRow = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(resellerOrder.id).first();
  assert(orderRow.reseller_name === "Cozy Resellers" && orderRow.customer_name === null, "the order correctly shows the reseller, not a customer");

  section("=== Neither name provided is still correctly rejected ===");
  const noNameAttempt = await (await coMod.onRequestPost({ request: req({ items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  assert(noNameAttempt.error, "an order with neither customer_name nor reseller_name is still correctly rejected");

  section("=== A normal customer order still works exactly as before ===");
  const customerOrder = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  assert(customerOrder.id, "a plain customer order is unaffected by any of this");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
