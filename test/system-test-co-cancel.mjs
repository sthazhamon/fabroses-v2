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
  section("=== Cancelling an unactioned order succeeds ===");
  const itemsMod = await import("../functions/api/items.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const coDetailMod = await import("../functions/api/customer-orders/[id].js");

  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();

  const cancelRes = await (await coDetailMod.onRequestPatch({ request: req({ status: "cancelled" }), env, params: { id: co.id } })).json();
  assert(cancelRes.ok !== false && !cancelRes.error, "cancelling an unactioned order succeeds");

  const coAfter = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(coAfter.status === "cancelled", "the order is correctly marked cancelled");

  section("=== Cancelling an already-billed order is correctly blocked ===");
  const billedCo = await (await coMod.onRequestPost({ request: req({ customer_name: "Anu", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  await env.DB.prepare("UPDATE customer_orders SET status = 'billed' WHERE id = ?").bind(billedCo.id).run();

  const blockedAttempt = await (await coDetailMod.onRequestPatch({ request: req({ status: "cancelled" }), env, params: { id: billedCo.id } })).json();
  assert(blockedAttempt.error, "cancelling an already-billed order is correctly rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
