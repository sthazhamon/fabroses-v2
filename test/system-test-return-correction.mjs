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
  section("=== Setup: a worker returns 50 when they meant to return 5 ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const woMod = await import("../functions/api/work-orders.js");
  const returnEventsMod = await import("../functions/api/material-issues/[id]/return-events.js");
  const correctMod = await import("../functions/api/material-return-events/[id]/correct.js");
  const returnEndpointMod = await import("../functions/api/material-issues/[id]/return.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finished = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const storeLot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 100, source_type: "direct_intake" }), env, data: {} })).json();

  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const dispatchRes = await (await issueMod.onRequestPost({ request: req({ lot_id: storeLot.id, quantity: 50 }), env, params: { id: wo.id } })).json();
  await confirmPick(env, dispatchRes.dispatch_id, { item_id: item.id, lot_id: storeLot.id, scanned_quantity: 50 });
  await shipDispatch(env, dispatchRes.dispatch_id, {}, "store staff");
  const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchRes.dispatch_id).first();
  await confirmReceive(env, dispatchRes.dispatch_id, [{ dispatch_item_id: dItem.id, received_quantity: 50 }], "Zakir");

  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  const wrongReturnRes = await (await returnEndpointMod.onRequestPost({ request: req({ quantity_returned_stock: 50, quantity_wasted: 0 }), env, params: { id: issue.id }, data: {} })).json();
  assert(wrongReturnRes.ok, "the (mistaken) return of 50 succeeds");

  section("=== Past return events are now visible for the first time ===");
  const events = await (await returnEventsMod.onRequestGet({ env, params: { id: issue.id } })).json();
  assert(events.length === 1 && events[0].quantity_returned_stock === 50 && events[0].created_lot_id, "the past event is correctly listed, showing what it recorded and which lot it created");

  section("=== Correcting it while untouched succeeds cleanly ===");
  const correctRes = await (await correctMod.onRequestPost({ request: req({ corrected_returned_stock: 5, corrected_wasted: 0 }), env, params: { id: events[0].id }, data: { user: { name: "Admin" } } })).json();
  assert(correctRes.ok && correctRes.delta_returned === -45, `the correction correctly computes the delta itself (5-50=-45), got ${correctRes.delta_returned}`);

  const lotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(events[0].created_lot_id).first();
  assert(lotAfter.quantity_balance === 5, `CRITICAL: the lot that was created is correctly reduced from 50 to 5, got ${lotAfter.quantity_balance}`);

  const issueAfterCorrection = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue.id).first();
  assert(issueAfterCorrection.quantity_returned_stock === 5, `the issue's own running total is correctly adjusted to 5, got ${issueAfterCorrection.quantity_returned_stock}`);

  section("=== The original event stays on record, untouched — a new correction entry sits alongside it ===");
  const eventsAfter = await (await returnEventsMod.onRequestGet({ env, params: { id: issue.id } })).json();
  assert(eventsAfter.length === 2, `there are now 2 entries — the original untouched plus the correction, got ${eventsAfter.length}`);
  const original = eventsAfter.find((e) => e.id === events[0].id);
  assert(original.quantity_returned_stock === 50 && original.corrected_at, "the ORIGINAL entry still shows its original figure of 50, now marked as corrected — never rewritten");

  section("=== Double-correcting the same entry is correctly rejected ===");
  const doubleAttempt = await (await correctMod.onRequestPost({ request: req({ corrected_returned_stock: 10, corrected_wasted: 0 }), env, params: { id: events[0].id }, data: {} })).json();
  assert(doubleAttempt.error, "attempting to correct the same entry a second time is correctly rejected");

  section("=== CRITICAL: correction is refused once the returned stock has already been used elsewhere ===");
  const item2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const storeLot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item2.id, site_id: store.id, quantity: 100, source_type: "direct_intake" }), env, data: {} })).json();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const dispatchRes2 = await (await issueMod.onRequestPost({ request: req({ lot_id: storeLot2.id, quantity: 20 }), env, params: { id: wo2.id } })).json();
  await confirmPick(env, dispatchRes2.dispatch_id, { item_id: item2.id, lot_id: storeLot2.id, scanned_quantity: 20 });
  await shipDispatch(env, dispatchRes2.dispatch_id, {}, "store staff");
  const dItem2 = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchRes2.dispatch_id).first();
  await confirmReceive(env, dispatchRes2.dispatch_id, [{ dispatch_item_id: dItem2.id, received_quantity: 20 }], "Zakir");

  const issue2 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo2.id).first();
  const return2Res = await (await returnEndpointMod.onRequestPost({ request: req({ quantity_returned_stock: 10, quantity_wasted: 0 }), env, params: { id: issue2.id }, data: {} })).json();
  const events2 = await (await returnEventsMod.onRequestGet({ env, params: { id: issue2.id } })).json();

  await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - 7 WHERE id = ?").bind(return2Res.lot_id).run();

  const blockedCorrection = await (await correctMod.onRequestPost({ request: req({ corrected_returned_stock: 2, corrected_wasted: 0 }), env, params: { id: events2[0].id }, data: {} })).json();
  assert(blockedCorrection.error, "CRITICAL: correcting downward is correctly refused once part of that returned stock has already been consumed elsewhere — taking it back would go negative");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
