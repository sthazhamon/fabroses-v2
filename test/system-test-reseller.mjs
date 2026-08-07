import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const perfMod = await import("../functions/api/reports/reseller-performance.js");

  const shimi = await (await partiesMod.onRequestPost({ request: req({ name: "SHIMI", type: "reseller", discount_tier: 2, target_amount: 5000, target_period: "monthly" }), env })).json();
  await salesMod.onRequestPost({ request: req({ lines: [{ description: "Reseller sale", sale_price: 6000 }], customer_party_id: shimi.id, reseller_name: "SHIMI" }), env, data: {} });

  const perf = await (await perfMod.onRequestGet({ request: { url: "https://x/api/reports/reseller-performance?period=monthly" }, env })).json();
  const row = perf.resellers.find((r) => r.party_id === shimi.id);
  assert(row && row.sales_total === 6000 && row.target_met === true, `reseller sale correctly attributed via customer_party_id (got total=${row && row.sales_total})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
