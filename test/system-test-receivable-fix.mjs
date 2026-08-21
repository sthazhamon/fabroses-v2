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
function getReq(qs) { return { url: "https://x/api/payments" + qs }; }

async function run() {
  section("=== Setup: a customer, a reseller, a supplier ===");
  const partiesMod = await import("../functions/api/parties.js");
  const paymentsMod = await import("../functions/api/payments.js");

  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  const supplier = await (await partiesMod.onRequestPost({ request: req({ name: "Cotton Threads", type: "supplier" }), env })).json();

  section("=== Payments GET correctly filters by direction ===");
  await paymentsMod.onRequestPost({ request: req({ party_id: customer.id, direction: "receivable", amount: 500, allocations: [] }), env, data: {} });
  await paymentsMod.onRequestPost({ request: req({ party_id: reseller.id, direction: "receivable", amount: 300, allocations: [] }), env, data: {} });
  await paymentsMod.onRequestPost({ request: req({ party_id: supplier.id, direction: "payable", amount: 200, allocations: [] }), env, data: {} });

  const receivablePayments = await (await paymentsMod.onRequestGet({ request: getReq("?direction=receivable"), env })).json();
  assert(receivablePayments.length === 2, "CRITICAL: filtering by direction=receivable correctly returns exactly the 2 receivable payments, not the payable one too");
  assert(receivablePayments.every((p) => p.party_name), "each payment record correctly includes the party's name");

  const payablePayments = await (await paymentsMod.onRequestGet({ request: getReq("?direction=payable"), env })).json();
  assert(payablePayments.length === 1 && payablePayments[0].party_name === "Cotton Threads", "filtering by direction=payable correctly returns only the supplier payment");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
