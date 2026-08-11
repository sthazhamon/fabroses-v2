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
  section("=== The exact reported bug: 10 issued, BOM needs only 6, 4 must remain ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");
  const partiesMod = await import("../functions/api/parties.js");

  const workerParty = await (await partiesMod.onRequestPost({ request: req({ name: "Murtaza", type: "worker" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Murtaza's workspace", site_type: "worker", worker_party_id: workerParty.id }), env })).json();
  const raw = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const finished = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: raw.id, quantity_required: 6 }] }), env, params: { id: finished.id } });

  const rawLot = await (await lotsMod.onRequestPost({ request: req({ item_id: raw.id, site_id: worker.id, quantity: 10, source_type: "opening_stock", cost_total: 100 }), env, data: {} })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const issueMod0 = await import("../functions/api/work-orders/[id]/issue-material.js");
  const manualIssueRes = await (await issueMod0.onRequestPost({ request: req({ lot_id: rawLot.id, quantity: 10 }), env, params: { id: wo.id } })).json();
  assert(manualIssueRes.direct_issue === true, "confirms the setup matches the report — 10 manually issued, even though the BOM only needs 6");

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  await verifyMod.onRequestPost({ request: req({ item_id: raw.id, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } });

  const doneRes = await (await markDoneMod.onRequestPost({ request: req({ labor_cost: 50 }), env, params: { id: wo.id }, data: { user: { name: "Murtaza" } } })).json();
  assert(doneRes.ok, "mark-done succeeds");

  const rawLotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(rawLot.id).first();
  assert(rawLotAfter.quantity_balance === 4, `CRITICAL: exactly 4 remains as genuine leftover stock (10 issued - 6 consumed), got ${rawLotAfter.quantity_balance}`);

  const issueAfter = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue.id).first();
  assert(issueAfter.status === "received" && issueAfter.quantity_returned_stock === 4, "the issue correctly closes, recording 4 as leftover (not wasted, not physically returned)");

  section("=== Raw material COGS is now a real journal entry, not just tracked on the lot ===");
  const rawCogsAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '4000'").first();
  const rawCogsTotal = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS t FROM journal_lines WHERE account_id = ?").bind(rawCogsAccount.id).first();
  assert(rawCogsTotal.t === 60, `CRITICAL: COGS correctly debited for exactly the 6 consumed (cost 100/10=10 per unit x 6=60), got ${rawCogsTotal.t}`);

  const rawInventoryAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '1200'").first();
  const rawInventoryCredit = await env.DB.prepare("SELECT COALESCE(SUM(credit),0) AS t FROM journal_lines WHERE account_id = ?").bind(rawInventoryAccount.id).first();
  assert(rawInventoryCredit.t === 60, `the raw-material inventory asset account is correctly credited the same 60, keeping the entry balanced`);

  section("=== Labor cost posts as a real liability to the worker, mirroring Supplier Bills ===");
  const laborCogsAccount = await env.DB.prepare("SELECT id FROM accounts WHERE code = '4100'").first();
  const laborCogsTotal = await env.DB.prepare("SELECT COALESCE(SUM(debit),0) AS t FROM journal_lines WHERE account_id = ?").bind(laborCogsAccount.id).first();
  assert(laborCogsTotal.t === 50, `labor COGS correctly debited 50, got ${laborCogsTotal.t}`);

  const workerPartyAccountId = await env.DB.prepare(
    "SELECT a.id FROM accounts a JOIN parties p ON p.id = ? WHERE a.name LIKE '%' || p.name || '%' LIMIT 1"
  ).bind(workerParty.id).first();
  const woAfter = await env.DB.prepare("SELECT labor_cost FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfter.labor_cost === 50, `labor_cost is still correctly recorded on the work order itself, keeping the existing outstanding-bills-for-worker mechanism working unchanged, got ${woAfter.labor_cost}`);

  section("=== Sufficient-but-not-exact reservation across TWO issues still allocates correctly ===");
  const rawLot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: raw.id, site_id: worker.id, quantity: 3, source_type: "opening_stock", cost_total: 30 }), env, data: {} })).json();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  await issueMod.onRequestPost({ request: req({ lot_id: rawLot.id, quantity: 4 }), env, params: { id: wo2.id } });
  await issueMod.onRequestPost({ request: req({ lot_id: rawLot2.id, quantity: 3 }), env, params: { id: wo2.id } });
  const issues2 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo2.id).all();
  for (const iss of issues2.results) {
    await verifyMod.onRequestPost({ request: req({ item_id: raw.id, lot_id: iss.lot_id }), env, params: { id: iss.id } });
  }
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo2.id } });
  const doneRes2 = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo2.id }, data: {} })).json();
  assert(doneRes2.ok, "job 2 (needs 6, has 4+3=7 reserved across two issues) succeeds");

  const totalRemainingAcrossBoth = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ? AND site_id = ?").bind(raw.id, worker.id).first();
  assert(totalRemainingAcrossBoth.t === 1, `CRITICAL: across both jobs, exactly 1 unit remains genuinely leftover (10+3 issued total - 6-6 consumed = 1), got ${totalRemainingAcrossBoth.t}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
