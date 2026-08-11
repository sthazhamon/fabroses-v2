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
  section("=== Setup: a job with two BOM raw materials, both already at the worker's site ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const thread = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Thread" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }, { raw_material_item_id: thread.id, quantity_required: 2 }] }), env, params: { id: saree.id } });

  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: worker.id, quantity: 8, source_type: "opening_stock" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: worker.id, quantity: 3, source_type: "opening_stock" }), env, data: {} });

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();

  section("=== Can't mark done before Work Started ===");
  const tooEarly = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo.id }, data: {} })).json();
  assert(tooEarly.error, "correctly blocked before Work Started");

  const issues = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).all();
  for (const issue of issues.results) {
    await verifyMod.onRequestPost({ request: req({ item_id: (await env.DB.prepare("SELECT item_id FROM item_lots WHERE id=?").bind(issue.lot_id).first()).item_id, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  }
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } });

  section("=== Mark Job Done consumes BOM-expected raw material and creates the finished lot ===");
  const doneRes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo.id }, data: { user: { name: "Zakir" } } })).json();
  assert(doneRes.ok && doneRes.finished_lot_id, "mark-done succeeds, returns the new finished lot's ID");

  const fabricAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ?").bind(fabric.id).first();
  const threadAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ?").bind(thread.id).first();
  assert(fabricAfter.quantity_balance === 3, `fabric correctly dropped 8 -> 3 (BOM needs 5 x 1), got ${fabricAfter.quantity_balance}`);
  assert(threadAfter.quantity_balance === 1, `thread correctly dropped 3 -> 1 (BOM needs 2 x 1), got ${threadAfter.quantity_balance}`);

  const finishedLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(doneRes.finished_lot_id).first();
  assert(finishedLot.site_id === worker.id && finishedLot.quantity_balance === 1 && finishedLot.source_type === "work_order_output",
    "the finished-good lot correctly sits at the worker's OWN site, not shipped anywhere yet");
  assert(finishedLot.source_reference === wo.id, "the lot correctly remembers which WO it came from, needed later for crediting at ship/confirm time");

  const woAfter = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfter.stage === "Work Done", "the work order's stage correctly advances to Work Done");

  section("=== Can't mark done twice ===");
  const doubleAttempt = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo.id }, data: {} })).json();
  assert(doubleAttempt.error, "attempting to mark done a second time is correctly rejected");

  section("=== Blocked when there genuinely isn't enough raw material at the worker's site ===");
  const worker2 = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: worker2.id, quantity: 2, source_type: "opening_stock" }), env, data: {} }); // only 2, needs 5
  await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: worker2.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker2.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  const issues2 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo2.id).all();
  for (const issue of issues2.results) {
    await verifyMod.onRequestPost({ request: req({ item_id: (await env.DB.prepare("SELECT item_id FROM item_lots WHERE id=?").bind(issue.lot_id).first()).item_id, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  }
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo2.id } });

  const insufficientAttempt = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo2.id }, data: {} })).json();
  assert(insufficientAttempt.error, "correctly blocked — only 2 fabric at the worker's site, BOM needs 5");

  const fabricAt2Unchanged = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(fabric.id, worker2.id).first();
  const threadAt2Unchanged = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(thread.id, worker2.id).first();
  assert(fabricAt2Unchanged.quantity_balance === 2 && threadAt2Unchanged.quantity_balance === 5,
    "CRITICAL: since fabric failed the check, thread (which WAS sufficient) was correctly untouched too — no partial consumption on a failed attempt");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
