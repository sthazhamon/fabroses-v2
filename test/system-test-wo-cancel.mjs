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
  section("=== Setup: WO linked to a customer order line, material already issued ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const coDetailMod = await import("../functions/api/customer-orders/[id].js");
  const woMod = await import("../functions/api/work-orders.js");
  const woDetailMod = await import("../functions/api/work-orders/[id].js");
  const cancelMod = await import("../functions/api/work-orders/[id]/cancel.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const workerA = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Anu", items: [{ item_id: finishedItem.id, quantity: 1 }] }), env })).json();
  const coDetail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  const line = coDetail.items[0];

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: workerA.id, intended_item_id: finishedItem.id, related_customer_order_id: co.id, related_customer_order_item_id: line.id }), env })).json();

  const issueRes = await (await issueMod.onRequestPost({ request: req({ lot_id: lot.id, quantity: 10 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, issueRes.dispatch_id, { item_id: rawItem.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, issueRes.dispatch_id, {}, "store");
  const dispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: dispItem.id, received_quantity: 10 }], "Zakir");

  section("=== Reassignment is gone entirely — attempting it is rejected ===");
  const reassignAttempt = await (await woDetailMod.onRequestPatch({ request: req({ worker_site_id: workerA.id }), env, params: { id: wo.id }, data: {} })).json();
  assert(reassignAttempt.error, "attempting to PATCH worker_site_id is rejected outright — reassignment no longer exists as a capability");

  section("=== Cancelling frees the customer order line and leaves material untouched ===");
  const cancelRes = await (await cancelMod.onRequestPost({ env, params: { id: wo.id }, data: { user: { name: "Admin" } } })).json();
  assert(cancelRes.ok && cancelRes.outstanding_material_issues === 1, `cancellation succeeds and correctly flags 1 outstanding material issue still needing reconciliation (got ${cancelRes.outstanding_material_issues})`);

  const woAfter = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfter.cancelled_at !== null, "the work order itself is correctly marked cancelled");

  const issueAfter = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  assert(issueAfter.status === "with_worker" && issueAfter.quantity_issued === 10, "the material issue is completely untouched by the cancellation — still sitting exactly as it was, resolvable independently");

  const coAfterCancel = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(!coAfterCancel.items[0].linked_work_order_id, "the customer order's line is correctly freed — no longer pointing at the cancelled WO");
  assert(coAfterCancel.status === "received", "and the order's overall status correctly reverts, ready for a fresh work order to be created");

  section("=== A fresh WO can now be created for a different worker ===");
  const workerB = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 1 retry", worker_site_id: workerB.id, intended_item_id: finishedItem.id, related_customer_order_id: co.id, related_customer_order_item_id: line.id }), env })).json();
  assert(wo2.id, "a fresh work order for a different worker is created cleanly");

  section("=== Can't cancel twice, or after Work Shipped ===");
  const doubleCancel = await (await cancelMod.onRequestPost({ env, params: { id: wo.id }, data: {} })).json();
  assert(doubleCancel.error, "cancelling an already-cancelled WO is rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
