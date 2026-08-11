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
  section("=== Setup: a job with a BOM, more raw material issued than actually needed ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }] }), env, params: { id: saree.id } }); // 5m needed per saree

  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: store.id, quantity: 20, source_type: "direct_intake", cost_total: 2000 }), env, data: {} });
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();

  // Deliberately issue MORE than the BOM needs (10m issued, only 5m actually required for 1 saree) — a buffer for wastage
  const issueRes = await (await issueMod.onRequestPost({ request: req({ lot_id: (await env.DB.prepare("SELECT id FROM item_lots WHERE item_id=?").bind(fabric.id).first()).id, quantity: 10 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, issueRes.dispatch_id, { item_id: fabric.id, lot_id: (await env.DB.prepare("SELECT id FROM item_lots WHERE item_id=?").bind(fabric.id).first()).id, scanned_quantity: 10 });
  await shipDispatch(env, issueRes.dispatch_id, {}, "store");
  const rawDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: rawDispItem.id, received_quantity: 10 }], "Zakir");

  section("=== Preview shows the correct BOM-expected consumption BEFORE confirming ===");
  const previewMod = await import("../functions/api/dispatches/[id]/reconciliation-preview.js");
  await env.DB.prepare("UPDATE work_orders SET stage='Work Started' WHERE id=?").bind(wo.id).run();
  const shipBackMod = await import("../functions/api/work-orders/[id]/ship-back.js");
  const shipBackRes = await (await shipBackMod.onRequestPost({ request: req({ quantity: 1 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, shipBackRes.dispatch_id, { item_id: saree.id, lot_id: null, scanned_quantity: 1 });
  await shipDispatch(env, shipBackRes.dispatch_id, {}, "worker");

  const previewRes = await (await previewMod.onRequestGet({ request: { url: "https://x/api/dispatches/" + shipBackRes.dispatch_id + "/reconciliation-preview?confirmed_quantity=1" }, env, params: { id: shipBackRes.dispatch_id } })).json();
  assert(previewRes.lines.length === 1, "preview correctly finds the one open raw material issue for this job");
  assert(previewRes.lines[0].bom_expected_consumption === 5, `BOM expects 5m consumed for 1 saree (5 x 1), got ${previewRes.lines[0].bom_expected_consumption}`);
  assert(previewRes.lines[0].suggested_quantity_returned_stock === 5, `suggested return correctly computed as issued(10) - expected(5) = 5, got ${previewRes.lines[0].suggested_quantity_returned_stock}`);

  section("=== Confirming the finished good AND reconciling raw material happen in ONE action ===");
  const rawIssue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  const finishedDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(shipBackRes.dispatch_id).first();
  const combinedRes = await confirmReceive(env, shipBackRes.dispatch_id, [{ dispatch_item_id: finishedDispItem.id, received_quantity: 1 }], "Store", {
    labor_cost: 200,
    material_reconciliation: [{ material_issue_id: rawIssue.id, quantity_returned_stock: 5, quantity_wasted: 0 }],
  });
  assert(combinedRes.work_order_closed, "the work order correctly closes from this single action");
  assert(combinedRes.material_reconciliation_results.length === 1 && combinedRes.material_reconciliation_results[0].fully_reconciled,
    "the raw material issue is ALSO fully reconciled, from the exact same request — no separate visit to another screen needed");

  const rawIssueAfter = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(rawIssue.id).first();
  assert(rawIssueAfter.status === "received" && rawIssueAfter.quantity_returned_stock === 5, "the raw material issue's own record correctly shows the reconciliation happened");

  const fabricStockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(fabric.id).first();
  assert(fabricStockAfter.t === 15, `stock correctly reflects: 20 total - 10 issued + 5 returned = 15 (got ${fabricStockAfter.t})`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
