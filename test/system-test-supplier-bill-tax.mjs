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
  section("=== Supplier Bill with tax — cash purchase, no PO ===");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const partiesMod = await import("../functions/api/parties.js");

  const supplier = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy", type: "supplier" }), env })).json();
  const res = await (await sbMod.onRequestPost({
    request: req({ supplier_party_id: supplier.id, supplier_name: "Cozy", bill_date: "2026-08-01", lines: [{ quantity: 10, rate: 100, tax_rate: 12 }] }),
    env, data: { user: { name: "Admin" } },
  })).json();

  assert(res.pre_tax_amount === 1000, `pre-tax amount correctly computed as 10x100=1000, got ${res.pre_tax_amount}`);
  assert(res.tax_amount === 120, `tax correctly computed as 12% of 1000=120, got ${res.tax_amount}`);
  assert(res.amount === 1120, `total amount correctly includes tax (1000+120=1120), got ${res.amount}`);

  section("=== The journal entry correctly splits base expense from tax input credit ===");
  const expenseAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '5000'").first();
  const taxAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '1300'").first();
  const supplierAccountId = await env.DB.prepare("SELECT a.id FROM accounts a WHERE a.name LIKE '%Cozy%'").first();

  const expenseDebit = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS t FROM journal_lines WHERE account_id = ?").bind(expenseAccount.id).first();
  const taxDebit = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS t FROM journal_lines WHERE account_id = ?").bind(taxAccount.id).first();
  const supplierCredit = await env.DB.prepare("SELECT COALESCE(SUM(credit),0) AS t FROM journal_lines WHERE account_id = ?").bind(supplierAccountId.id).first();

  assert(expenseDebit.t === 1000, `CRITICAL: expense account debited exactly the pre-tax amount (1000), got ${expenseDebit.t}`);
  assert(taxDebit.t === 120, `CRITICAL: tax input credit debited exactly the tax portion (120), got ${taxDebit.t}`);
  assert(supplierCredit.t === 1120, `the supplier's own account is credited the full tax-inclusive amount (1120), got ${supplierCredit.t}`);

  section("=== A bill with zero tax doesn't touch the tax account at all ===");
  const noTaxRes = await (await sbMod.onRequestPost({
    request: req({ supplier_name: "Cash Vendor", lines: [{ quantity: 5, rate: 50, tax_rate: 0 }] }), env, data: {},
  })).json();
  assert(noTaxRes.tax_amount === 0 && noTaxRes.amount === 250, "a bill with no tax correctly shows zero tax, plain amount");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
