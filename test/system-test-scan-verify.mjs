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
  section("=== Setup: a job with TWO raw materials via BOM, both auto-fulfilled from the store ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const thread = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Thread" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Applique Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }, { raw_material_item_id: thread.id, quantity_required: 2 }] }), env, params: { id: saree.id } });
  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} });

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  const fabricLot = await env.DB.prepare("SELECT id FROM item_lots WHERE item_id = ? AND site_id = ?").bind(fabric.id, store.id).first();
  const threadLot = await env.DB.prepare("SELECT id FROM item_lots WHERE item_id = ? AND site_id = ?").bind(thread.id, store.id).first();
  await issueMod.onRequestPost({ request: req({ lot_id: fabricLot.id, quantity: 5 }), env, params: { id: wo.id } });
  await issueMod.onRequestPost({ request: req({ lot_id: threadLot.id, quantity: 2 }), env, params: { id: wo.id } });

  // Ship and confirm both dispatches created by the explicit material issues
  const dispatches = await env.DB.prepare("SELECT * FROM dispatches WHERE related_work_order_id = ?").bind(wo.id).all();
  for (const d of dispatches.results) {
    const item = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(d.id).first();
    await confirmPick(env, d.id, { item_id: item.item_id, lot_id: item.lot_id, scanned_quantity: item.expected_quantity });
    await shipDispatch(env, d.id, {}, "store staff");
    const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(d.id).first();
    await confirmReceive(env, d.id, [{ dispatch_item_id: shippedItem.id, received_quantity: shippedItem.expected_quantity }], "store staff");
  }

  const issues = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).all();
  assert(issues.results.length === 2, "both raw material lines correctly created their own material issue");

  section("=== Starting work is blocked until BOTH lines are verified, not just one ===");
  const blockedNoVerify = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } })).json();
  assert(blockedNoVerify.error, "with zero lines verified, starting work is correctly blocked");

  const fabricIssue = issues.results.find((i) => i.lot_id && true) && await (async () => {
    for (const i of issues.results) { const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id=?").bind(i.lot_id).first(); if (lot.item_id === fabric.id) return i; }
  })();
  const threadIssue = issues.results.find((i) => i.id !== fabricIssue.id);

  await verifyMod.onRequestPost({ request: req({ item_id: fabric.id, lot_id: fabricIssue.lot_id }), env, params: { id: fabricIssue.id } });
  const blockedOneVerified = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } })).json();
  assert(blockedOneVerified.error, "CRITICAL: with only ONE of two lines verified, starting work is still correctly blocked");

  section("=== Verifying against the wrong item is rejected with a clear message ===");
  const wrongItemAttempt = await (await verifyMod.onRequestPost({ request: req({ item_id: fabric.id, lot_id: threadIssue.lot_id }), env, params: { id: threadIssue.id } })).json();
  assert(wrongItemAttempt.error && wrongItemAttempt.error.toLowerCase().includes("wrong"), `verifying the thread line with the fabric item is correctly rejected (got: "${wrongItemAttempt.error}")`);

  section("=== Once BOTH lines are verified, work can finally start ===");
  await verifyMod.onRequestPost({ request: req({ item_id: thread.id, lot_id: threadIssue.lot_id }), env, params: { id: threadIssue.id } });
  const startRes = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } })).json();
  assert(startRes.ok, "with both lines now correctly verified, starting work succeeds");

  section("=== A rework job with no raw material issues at all is never blocked ===");
  const reworkLot = await (await lotsMod.onRequestPost({ request: req({ item_id: saree.id, site_id: store.id, quantity: 1, source_type: "work_order_output" }), env, data: {} })).json();
  const reworkWO = await (await woMod.onRequestPost({ request: req({ description: "Fix it", worker_site_id: worker.id, intended_item_id: saree.id, job_type: "rework", rework_lot_id: reworkLot.id, target_quantity: 1 }), env, data: {} })).json();
  const reworkStart = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: reworkWO.id } })).json();
  assert(reworkStart.ok, "a rework job with zero material_issues is never blocked by the verification gate — nothing to verify");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
