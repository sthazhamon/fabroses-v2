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
  section("=== Setup: a finished item with a two-raw-material BOM ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const thread = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Thread" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Applique Saree" }), env })).json();

  const bomRes = await (await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }, { raw_material_item_id: thread.id, quantity_required: 2 }] }), env, params: { id: saree.id } })).json();
  assert(bomRes.ok, "multi-line BOM saved");

  const bomList = await (await bomMod.onRequestGet({ env, params: { id: saree.id } })).json();
  assert(bomList.length === 2, "BOM correctly shows both raw materials");

  section("=== WO creation without an intended item is still rejected ===");
  const noItemAttempt = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, target_quantity: 1 }), env, data: {} })).json();
  assert(noItemAttempt.error, "the finished item is still mandatory");

  section("=== CRITICAL: WO creation now only SUGGESTS material - nothing is reserved or dispatched ===");
  await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} });

  const wo1 = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 2 }), env, data: { user: { name: "Admin" } } })).json();

  const threadSuggestion = wo1.material_suggestions.find((r) => r.raw_material_item_id === thread.id);
  assert(threadSuggestion.quantity === 4, `thread suggestion correctly reflects the BOM (2 per unit x 2 units = 4), got ${JSON.stringify(threadSuggestion)}`);
  const fabricSuggestion = wo1.material_suggestions.find((r) => r.raw_material_item_id === fabric.id);
  assert(fabricSuggestion.quantity === 10, `fabric suggestion correctly reflects the BOM (5 per unit x 2 units = 10), got ${JSON.stringify(fabricSuggestion)}`);

  const noIssueYet = await env.DB.prepare("SELECT COUNT(*) AS c FROM material_issues WHERE work_order_id = ?").bind(wo1.id).first();
  assert(noIssueYet.c === 0, "CRITICAL: no material_issue record exists yet - creation alone doesn't reserve anything");

  const noDispatchYet = await env.DB.prepare("SELECT COUNT(*) AS c FROM dispatches WHERE related_work_order_id = ?").bind(wo1.id).first();
  assert(noDispatchYet.c === 0, "CRITICAL: no dispatch was auto-created - the store's fabric was never touched");

  const threadStockUntouched = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(thread.id, worker.id).first();
  assert(threadStockUntouched.quantity_balance === 10, "worker's thread stock is completely untouched at creation time");

  const fabricStockUntouched = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(fabric.id, store.id).first();
  assert(fabricStockUntouched.quantity_balance === 20, "store's fabric stock is completely untouched at creation time");

  section("=== The explicit issue-material step is what actually attaches material, requiring a real lot choice ===");
  const threadLot = await env.DB.prepare("SELECT id FROM item_lots WHERE item_id = ? AND site_id = ?").bind(thread.id, worker.id).first();
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const issueRes = await issueMod.onRequestPost({ request: req({ lot_id: threadLot.id, quantity: threadSuggestion.quantity }), env, params: { id: wo1.id } });
  const issueJson = await issueRes.json();
  assert(issueJson.direct_issue === true && !issueJson.error, "explicitly issuing from the worker's own lot, using the suggested quantity, succeeds directly");

  const issueNow = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo1.id).first();
  assert(issueNow && issueNow.lot_id === threadLot.id && issueNow.quantity_issued === 4, "CRITICAL: the material issue now exists, tied to the SPECIFIC lot that was explicitly chosen");

  section("=== Rework jobs correctly have no material suggestions at all ===");
  const reworkLot = await (await lotsMod.onRequestPost({ request: req({ item_id: saree.id, site_id: store.id, quantity: 1, source_type: "opening_stock" }), env, data: {} })).json();
  const reworkWO = await (await woMod.onRequestPost({ request: req({ description: "Rework it", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1, job_type: "rework", rework_lot_id: reworkLot.id }), env, data: {} })).json();
  assert(reworkWO.material_suggestions.length === 0, "rework jobs correctly have zero material suggestions");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
