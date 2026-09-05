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
  section("=== Setup ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const woDetailMod = await import("../functions/api/work-orders/[id].js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const raw = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Fabric" }), env })).json();
  const finished = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: raw.id, quantity_required: 5 }] }), env, params: { id: finished.id } });
  await lotsMod.onRequestPost({ request: req({ item_id: raw.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1 }), env, data: {} })).json();

  section("=== Stage 1: freshly created, nothing assigned ===");
  let detail = await (await woDetailMod.onRequestGet({ env, params: { id: wo.id } })).json();
  assert(detail.material_status === "not_assigned", `correctly not_assigned, got ${detail.material_status}`);

  section("=== Stage 2: material explicitly issued from the store - a dispatch now exists, still pending pick ===");
  const storeLot = await env.DB.prepare("SELECT id FROM item_lots WHERE item_id = ? AND site_id = ?").bind(raw.id, store.id).first();
  const issueRes = await (await issueMod.onRequestPost({ request: req({ lot_id: storeLot.id, quantity: 5 }), env, params: { id: wo.id } })).json();
  detail = await (await woDetailMod.onRequestGet({ env, params: { id: wo.id } })).json();
  assert(detail.material_status === "assigned", `CRITICAL: correctly shows 'assigned' now that a dispatch exists, even though work hasn't started - got ${detail.material_status}`);

  section("=== Stage 3: picked and shipped - in transit ===");
  await confirmPick(env, issueRes.dispatch_id, { item_id: raw.id, lot_id: storeLot.id, scanned_quantity: 5 });
  await shipDispatch(env, issueRes.dispatch_id, {}, "staff");
  detail = await (await woDetailMod.onRequestGet({ env, params: { id: wo.id } })).json();
  assert(detail.material_status === "in_transit", `CRITICAL: correctly shows 'in_transit', got ${detail.material_status}`);

  section("=== Stage 4: received at the worker's site, but not yet verified by the worker ===");
  const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: shippedItem.id, received_quantity: 5 }], "Zakir");
  detail = await (await woDetailMod.onRequestGet({ env, params: { id: wo.id } })).json();
  assert(detail.material_status === "at_worker_unverified", `CRITICAL: correctly shows 'at_worker_unverified' - material has physically arrived, but the worker hasn't confirmed it yet - got ${detail.material_status}`);

  section("=== Stage 5: worker verifies it - fully ready ===");
  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  await verifyMod.onRequestPost({ request: req({ item_id: raw.id, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  detail = await (await woDetailMod.onRequestGet({ env, params: { id: wo.id } })).json();
  assert(detail.material_status === "verified", `CRITICAL: correctly shows 'verified' once the worker has confirmed it, got ${detail.material_status}`);

  section("=== A direct issue (material already at the worker's own site) correctly skips straight to unverified ===");
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1 }), env, data: {} })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: raw.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} });
  const workerLot = await env.DB.prepare("SELECT id FROM item_lots WHERE item_id = ? AND site_id = ?").bind(raw.id, worker.id).first();
  await issueMod.onRequestPost({ request: req({ lot_id: workerLot.id, quantity: 5 }), env, params: { id: wo2.id } });
  const detail2 = await (await woDetailMod.onRequestGet({ env, params: { id: wo2.id } })).json();
  assert(detail2.material_status === "at_worker_unverified", `a direct issue (already at the worker's site) correctly goes straight to 'at_worker_unverified', got ${detail2.material_status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
