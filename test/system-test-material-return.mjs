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
  section("=== Setup: store, TWO workers, a raw material lot ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const woMod = await import("../functions/api/work-orders.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const workerA = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const workerB = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota", unit_of_measure: "metre" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 30, source_type: "direct_intake", cost_total: 6000 }), env, data: {} })).json();

  const woA = await (await woMod.onRequestPost({ request: req({ description: "Job A", worker_site_id: workerA.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();
  const woB = await (await woMod.onRequestPost({ request: req({ description: "Job B", worker_site_id: workerB.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();

  section("=== The SAME lot split across two workers via issue-material + full dispatch flow ===");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const dispA = await (await issueMod.onRequestPost({ request: req({ lot_id: lot.id, quantity: 12 }), env, params: { id: woA.id } })).json();
  await confirmPick(env, dispA.dispatch_id, { item_id: item.id, lot_id: lot.id, scanned_quantity: 12 });
  await shipDispatch(env, dispA.dispatch_id, {}, "tester");
  const dispAItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispA.dispatch_id).first();
  await confirmReceive(env, dispA.dispatch_id, [{ dispatch_item_id: dispAItem.id, received_quantity: 12 }], "tester");

  const dispB = await (await issueMod.onRequestPost({ request: req({ lot_id: lot.id, quantity: 8 }), env, params: { id: woB.id } })).json();
  await confirmPick(env, dispB.dispatch_id, { item_id: item.id, lot_id: lot.id, scanned_quantity: 8 });
  await shipDispatch(env, dispB.dispatch_id, {}, "tester");
  const dispBItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispB.dispatch_id).first();
  await confirmReceive(env, dispB.dispatch_id, [{ dispatch_item_id: dispBItem.id, received_quantity: 8 }], "tester");

  const lotAfterBothIssues = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot.id).first();
  assert(lotAfterBothIssues.quantity_balance === 10, `30 - 12 - 8 = 10 remaining at the store (got ${lotAfterBothIssues.quantity_balance})`);

  section("=== Scanning the ORIGINAL lot id finds BOTH open issues, correctly disambiguated ===");
  const byLotMod = await import("../functions/api/material-issues-by-lot.js");
  const openIssues = await (await byLotMod.onRequestGet({ request: { url: `https://x/api/material-issues-by-lot?lot_id=${lot.id}` }, env })).json();
  assert(openIssues.open_issues.length === 2, `both open issues (to workerA and workerB) are found by scanning the SAME original lot id (got ${openIssues.open_issues.length})`);
  const issueA = openIssues.open_issues.find((i) => i.worker_site_name === "Zakir");
  const issueB = openIssues.open_issues.find((i) => i.worker_site_name === "Mortaja");
  assert(issueA.quantity_issued === 12 && issueB.quantity_issued === 8, "each open issue correctly shows its own quantity, not mixed up with the other");

  section("=== Partial return with wastage: some back, some wasted, rest implicitly used ===");
  const returnMod = await import("../functions/api/material-issues/[id]/return.js");
  const return1 = await (await returnMod.onRequestPost({
    request: req({ quantity_returned_stock: 3, quantity_wasted: 1 }), env, params: { id: issueA.id }, data: { user: {} },
  })).json();
  assert(return1.ok && !return1.fully_reconciled, `first partial return (3 back + 1 wasted = 4 of 12) does NOT fully close the issue (got fully_reconciled=${return1.fully_reconciled})`);
  assert(return1.still_unaccounted === 8, `8 of the original 12 is still unaccounted for (used in the piece + not yet returned) (got ${return1.still_unaccounted})`);

  const issueAAfter = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issueA.id).first();
  assert(issueAAfter.status === "partially_returned", "issue A's status correctly shows partially_returned, not received");

  section("=== Over-reconciling beyond what's actually outstanding is rejected ===");
  const overReturn = await (await returnMod.onRequestPost({ request: req({ quantity_returned_stock: 20 }), env, params: { id: issueA.id }, data: {} })).json();
  assert(overReturn.error, "trying to return more than what's still unaccounted for (8) is rejected");

  section("=== Second return event closes it out completely ===");
  const return2 = await (await returnMod.onRequestPost({ request: req({ quantity_returned_stock: 8 }), env, params: { id: issueA.id }, data: {} })).json();
  assert(return2.ok && return2.fully_reconciled, "the second event, covering the remaining 8, fully closes the issue");
  const issueAFinal = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issueA.id).first();
  assert(issueAFinal.status === "received" && issueAFinal.quantity_returned_stock === 11 && issueAFinal.quantity_wasted === 1,
    `final state correct: 11 returned as stock, 1 wasted, 12 total accounted for (got returned=${issueAFinal.quantity_returned_stock}, wasted=${issueAFinal.quantity_wasted})`);

  section("=== Issue B is completely untouched by any of issue A's reconciliation ===");
  const issueBCheck = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issueB.id).first();
  assert(issueBCheck.status === "with_worker" && issueBCheck.quantity_returned_stock === 0, "workerB's issue is completely unaffected — no cross-contamination between the two split issues");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
