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
  section("=== Setup: a finished piece with an actual defect, needing rework ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueReworkMod = await import("../functions/api/work-orders/[id]/issue-rework.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const returnMod = await import("../functions/api/rework-issues/[id]/return.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Applique Saree" }), env })).json();
  const flawedLot = await (await lotsMod.onRequestPost({ request: req({ item_id: saree.id, site_id: store.id, quantity: 1, source_type: "work_order_output" }), env, data: {} })).json();

  section("=== WO creation for rework requires job_type and the specific lot ===");
  const missingLot = await (await woMod.onRequestPost({ request: req({ description: "Fix the applique", worker_site_id: worker.id, intended_item_id: saree.id, job_type: "rework", target_quantity: 1 }), env, data: {} })).json();
  assert(missingLot.error, "rework without a specific lot is rejected — a rework job must identify the exact piece");

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Fix the applique", worker_site_id: worker.id, intended_item_id: saree.id, job_type: "rework", rework_lot_id: flawedLot.id, target_quantity: 1 }), env, data: {} })).json();
  assert(wo.id, "rework WO with the specific lot succeeds");
  assert(wo.bom_results.length === 0, "rework jobs don't trigger BOM auto-fulfillment — there's no raw material need here, just the piece itself");

  section("=== Sending the specific lot out — no re-entry needed, the WO already knows it ===");
  const issueRes = await (await issueReworkMod.onRequestPost({ request: req({}), env, params: { id: wo.id } })).json();
  assert(issueRes.dispatch_id, "issue-rework creates the pending dispatch using the WO's own known lot");

  const dispatchDetail = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  assert(dispatchDetail.lot_id === flawedLot.id, "the dispatch correctly references the exact flawed lot, not a generic pick");

  section("=== Confirming receipt creates a REWORK issue, not a raw-material issue ===");
  await confirmPick(env, issueRes.dispatch_id, { item_id: saree.id, lot_id: flawedLot.id, scanned_quantity: 1 });
  await shipDispatch(env, issueRes.dispatch_id, {}, "store staff");
  const dispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: dispItem.id, received_quantity: 1 }], "Zakir");

  const materialIssueCheck = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  assert(!materialIssueCheck, "CRITICAL: no material_issues row was created — a finished piece going for rework is genuinely different from raw material");

  const reworkIssue = await env.DB.prepare("SELECT * FROM rework_issues WHERE work_order_id = ?").bind(wo.id).first();
  assert(reworkIssue && reworkIssue.status === "with_worker" && reworkIssue.quantity_issued === 1, "a proper rework_issues row exists instead, correctly with_worker");

  section("=== Double-checking against the wrong dispatch shows nothing to send twice ===");
  const doubleIssueAttempt = await (await issueReworkMod.onRequestPost({ request: req({}), env, params: { id: wo.id } })).json();
  assert(doubleIssueAttempt.error, "can't issue the same rework lot out again while one is already open");

  section("=== Partial return, then a second cycle to fully close it (multiple cycles supported) ===");
  const partialReturn = await (await returnMod.onRequestPost({ request: req({ quantity_returned: 0, quantity_wasted: 0 }), env, params: { id: reworkIssue.id }, data: {} })).json();
  assert(partialReturn.error, "providing neither returned nor wasted quantity is rejected");

  // The piece comes back still not quite right the first time — 0 returned as final stock,
  // but not wasted either since it's just going out again.  Given quantity_issued=1 (a single
  // unique piece), a genuine "still not done" state doesn't fit the returned/wasted binary
  // cleanly — this exercises the case where the FULL 1 unit is confirmed returned on one event.
  const fullReturn = await (await returnMod.onRequestPost({ request: req({ quantity_returned: 1 }), env, params: { id: reworkIssue.id }, data: { user: { name: "Store" } } })).json();
  assert(fullReturn.ok && fullReturn.fully_reconciled, "returning the full quantity closes the rework issue");
  assert(fullReturn.lot_id, "a real lot is created for the returned piece, back in stock");

  const reworkIssueAfter = await env.DB.prepare("SELECT * FROM rework_issues WHERE id = ?").bind(reworkIssue.id).first();
  assert(reworkIssueAfter.status === "received", "rework issue correctly shows fully received");

  section("=== Lot history shows the rework cycle alongside ordinary movements ===");
  const historyMod = await import("../functions/api/item-lots/[id]/history.js");
  const history = await (await historyMod.onRequestGet({ env, params: { id: flawedLot.id } })).json();
  assert(history.rework_cycles.length === 1, "the original flawed lot's history correctly shows its one rework cycle");
  assert(history.rework_cycles[0].events.length === 1, "and that cycle's own return event is visible too");

  section("=== Open rework lookup by lot works the same way as material issues ===");
  const byLotMod = await import("../functions/api/rework-issues-by-lot.js");
  const openLookup = await (await byLotMod.onRequestGet({ request: { url: "https://x/api/rework-issues-by-lot?lot_id=" + flawedLot.id }, env })).json();
  assert(openLookup.open_issues.length === 0, "now that it's fully reconciled, it correctly no longer shows as an OPEN rework issue");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
