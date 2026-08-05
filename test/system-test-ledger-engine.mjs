import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${label}`); }
}
function section(title) { console.log(`\n${title}`); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };

async function run() {
  const { postJournalEntry, getOrCreatePartyAccount, accountFixedId } = await import("../functions/api/_ledger.js");

  section("=== Balance enforcement ===");
  const cashId = await accountFixedId(env, "1000");
  const salesId = await accountFixedId(env, "3000");

  let threw = false;
  try {
    await postJournalEntry(env, { date: "2026-08-01", lines: [{ account_id: cashId, debit: 100 }, { account_id: salesId, credit: 99 }] });
  } catch (e) { threw = true; }
  assert(threw, "an unbalanced entry (debit 100 / credit 99) is correctly rejected, not silently saved");

  const jeId = await postJournalEntry(env, { date: "2026-08-01", description: "Test sale", lines: [{ account_id: cashId, debit: 500 }, { account_id: salesId, credit: 500 }] });
  const lines = await env.DB.prepare("SELECT * FROM journal_lines WHERE journal_entry_id = ?").bind(jeId).all();
  assert(lines.results.length === 2, "a balanced entry saves both lines");

  section("=== Party sub-accounts ===");
  await env.DB.prepare("INSERT INTO parties (id, name, type) VALUES ('PTY-000001', 'Anu', 'customer')").run();
  await env.DB.prepare("INSERT INTO parties (id, name, type) VALUES ('PTY-000002', 'Neelam Fabrics', 'supplier')").run();
  await env.DB.prepare("INSERT INTO parties (id, name, type) VALUES ('PTY-000003', 'Zakir', 'worker')").run();

  const anuAccountId = await getOrCreatePartyAccount(env, "PTY-000001");
  const anuAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(anuAccountId).first();
  assert(anuAccount.account_type === "asset", "a customer's sub-account is correctly filed as an asset (Accounts Receivable)");

  const supplierAccountId = await getOrCreatePartyAccount(env, "PTY-000002");
  const supplierAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(supplierAccountId).first();
  assert(supplierAccount.account_type === "liability", "a supplier's sub-account is correctly filed as a liability (Accounts Payable)");

  const workerAccountId = await getOrCreatePartyAccount(env, "PTY-000003");
  const workerAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(workerAccountId).first();
  assert(workerAccount.account_type === "liability" && workerAccount.parent_account_id === (await env.DB.prepare("SELECT id FROM accounts WHERE code='2050'").first()).id,
    "a worker's sub-account is correctly filed under Wages Payable, not generic Accounts Payable");

  const anuAccountAgain = await getOrCreatePartyAccount(env, "PTY-000001");
  assert(anuAccountAgain === anuAccountId, "asking for the same party's account twice returns the SAME account, doesn't create a duplicate");

  section("=== Summary ===");
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("TEST HARNESS CRASHED:", e); process.exit(1); });
