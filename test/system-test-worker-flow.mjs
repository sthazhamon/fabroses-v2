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
  const woMod = await import("../functions/api/work-orders.js");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota", unit_of_measure: "metre" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree A", price: 5000 }), env })).json();
  const wrongItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree B", price: 4000 }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: store.id, quantity: 20, source_type: "direct_intake", cost_total: 4000 }), env, data: {} })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env })).json();

  section("=== Material Received sets automatically on confirm, not on ship ===");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const issueRes = await (await issueMod.onRequestPost({ request: req({ lot_id: lot.id, quantity: 10 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, issueRes.dispatch_id, { item_id: rawItem.id, lot_id: lot.id, scanned_quantity: 10 });
  await shipDispatch(env, issueRes.dispatch_id, {}, "store staff");

  const woAfterShip = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfterShip.stage === "Order Placed", "shipping material to the worker does NOT yet set Material Received — still in transit");

  const dispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(issueRes.dispatch_id).first();
  await confirmReceive(env, issueRes.dispatch_id, [{ dispatch_item_id: dispItem.id, received_quantity: 10 }], "Zakir");

  const woAfterConfirm = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfterConfirm.stage === "Material Received", "confirming receipt at the worker's end correctly auto-advances the stage");

  section("=== Work Started is the one genuinely manual stage ===");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const blockedAttempt = await (await stageMod.onRequestPost({ request: req({ stage: "Material Received", changed_by: "Zakir" }), env, params: { id: wo.id } })).json();
  assert(blockedAttempt.error, "trying to manually set Material Received directly is rejected — only the dispatch engine sets it");

  const startRes = await (await stageMod.onRequestPost({ request: req({ stage: "Work Started", changed_by: "Zakir" }), env, params: { id: wo.id } })).json();
  assert(startRes.ok, "Work Started IS manually settable — this is the one real manual step");

  section("=== Ship back with a mismatch warning (overridable) ===");
  const shipBackMod = await import("../functions/api/work-orders/[id]/ship-back.js");
  const wrongShipBack = await (await shipBackMod.onRequestPost({ request: req({ output_item_id: wrongItem.id, quantity: 1 }), env, params: { id: wo.id } })).json();
  assert(wrongShipBack.mismatch === true, "shipping back the WRONG item (not the WO's intended item) is flagged as a mismatch");
  assert(wrongShipBack.dispatch_id, "but it's a warning, not a block — the dispatch still gets created");

  const forceBlocked = await (await shipBackMod.onRequestPost({ request: req({ output_item_id: wrongItem.id, quantity: 1, force: false }), env, params: { id: wo.id } })).json();
  assert(forceBlocked.error, "explicitly passing force:false DOES hard-block a mismatch, for when that's actually wanted");

  section("=== Correct ship-back, full two-step, closes the work order and credits everything ===");
  const correctShipBack = await (await shipBackMod.onRequestPost({ request: req({ output_item_id: finishedItem.id, quantity: 1 }), env, params: { id: wo.id } })).json();
  assert(correctShipBack.mismatch === false, "shipping back the CORRECT intended item has no mismatch");

  const woBeforeShipConfirm = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woBeforeShipConfirm.received_quantity_total === 0, "creating the return dispatch alone does NOT yet credit anything");

  await confirmPick(env, correctShipBack.dispatch_id, { item_id: finishedItem.id, lot_id: null, scanned_quantity: 1 });
  const shipResult = await shipDispatch(env, correctShipBack.dispatch_id, { courier: "DTDC" }, "Zakir");
  assert(shipResult.ok, "picking and shipping the return dispatch succeeds");

  const woAfterShipBackShipped = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfterShipBackShipped.stage === "Work Shipped", "shipping the return dispatch correctly auto-advances to Work Shipped");
  assert(woAfterShipBackShipped.closed_at === null, "but the work order is NOT closed yet — only shipped, not confirmed received at the store");

  const finishedStockBeforeConfirm = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(finishedItem.id).first();
  assert(finishedStockBeforeConfirm.t === 0, "CRITICAL: finished stock is still zero — nothing credited until the store actually confirms");

  const returnDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(correctShipBack.dispatch_id).first();
  const finalConfirm = await confirmReceive(env, correctShipBack.dispatch_id, [{ dispatch_item_id: returnDispItem.id, received_quantity: 1 }], "Store staff", { labor_cost: 300 });
  assert(finalConfirm.ok && finalConfirm.work_order_closed === true, "store's confirmation correctly closes the work order (target 1, received 1)");

  const finishedStockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(finishedItem.id).first();
  assert(finishedStockAfter.t === 1, "and NOW, only now, the finished good actually shows up in stock");

  const finalLot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(finalConfirm.lot_id).first();
  // Lot cost basis: 4000 total / 20m original = 200/m. 10m consumed on this WO = 2000 raw cost. + 300 labor = 2300.
  assert(finalLot.cost_total === 2300, `cost correctly combines raw material (200/m x 10m = 2000) plus labor (300) = 2300 (got ${finalLot.cost_total})`);

  section("=== Worker Place shows correctly scoped info ===");
  const workerPlaceMod = await import("../functions/api/worker-place.js");
  const wp = await (await workerPlaceMod.onRequestGet({ env, data: { user: { siteId: worker.id } } })).json();
  assert(Array.isArray(wp.incoming_to_confirm) && Array.isArray(wp.outgoing_to_ship), "worker-place now exposes both incoming and outgoing dispatch queues");

  section("=== WIP photo upload (previously completely missing) ===");
  const photoMod = await import("../functions/api/work-orders/[id]/photo.js");
  const fakeForm = { formData: async () => { const fd = new FormData(); fd.append("photo", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "wip.jpg"); return fd; } };
  const photoRes = await (await photoMod.onRequestPost({ request: fakeForm, env, params: { id: wo.id } })).json();
  assert(photoRes.ok, "WIP photo upload now actually works");

  const woDetailMod = await import("../functions/api/work-orders/[id].js");
  const woDetail = await (await woDetailMod.onRequestGet({ params: { id: wo.id }, env })).json();
  assert(woDetail.photos.length === 1, "the uploaded WIP photo now actually shows up on the work order's detail — the read path finally has something to read");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("TEST HARNESS CRASHED:", e); process.exit(1); });
