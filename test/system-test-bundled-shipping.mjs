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
  section("=== Setup: two completed jobs (finished lots at worker's site) plus leftover raw material ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");
  const shipMyStockMod = await import("../functions/api/ship-my-stock.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const shawl = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Shawl" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }] }), env, params: { id: saree.id } });
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 3 }] }), env, params: { id: shawl.id } });
  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: worker.id, quantity: 20, source_type: "opening_stock" }), env, data: {} });

  async function completeJob(intendedItemId) {
    const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: intendedItemId, target_quantity: 1 }), env, data: {} })).json();
    const issues = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).all();
    for (const issue of issues.results) {
      const itemId = (await env.DB.prepare("SELECT item_id FROM item_lots WHERE id=?").bind(issue.lot_id).first()).item_id;
      await verifyMod.onRequestPost({ request: req({ item_id: itemId, lot_id: issue.lot_id }), env, params: { id: issue.id } });
    }
    await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } });
    const doneRes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo.id }, data: {} })).json();
    return { wo, finishedLotId: doneRes.finished_lot_id };
  }

  const job1 = await completeJob(saree.id);
  const job2 = await completeJob(shawl.id);
  assert(job1.finishedLotId && job2.finishedLotId, "both jobs completed, each with its own finished-good lot at the worker's site");

  section("=== Bundling both finished goods AND leftover raw material into ONE dispatch ===");
  const remainingFabricLot = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ?").bind(fabric.id, worker.id).first();
  const bundleRes = await (await shipMyStockMod.onRequestPost({
    request: req({ from_site_id: worker.id, items: [
      { lot_id: job1.finishedLotId, quantity: 1 },
      { lot_id: job2.finishedLotId, quantity: 1 },
      { lot_id: remainingFabricLot.id, quantity: remainingFabricLot.quantity_balance },
    ] }), env,
  })).json();
  assert(bundleRes.dispatch_id && bundleRes.item_count === 3, "one dispatch correctly bundles all three selected items together");

  const dispatchItemsCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM dispatch_items WHERE dispatch_id = ?").bind(bundleRes.dispatch_id).first();
  assert(dispatchItemsCount.c === 3, "the dispatch genuinely has 3 separate line items, not merged into one");

  section("=== Confirming the bundle correctly credits EACH work order independently ===");
  for (const lotId of [job1.finishedLotId, job2.finishedLotId, remainingFabricLot.id]) {
    const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ? AND lot_id = ?").bind(bundleRes.dispatch_id, lotId).first();
    await confirmPick(env, bundleRes.dispatch_id, { item_id: dItem.item_id, lot_id: lotId, scanned_quantity: dItem.expected_quantity });
  }
  await shipDispatch(env, bundleRes.dispatch_id, {}, "Zakir");

  const dItems = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(bundleRes.dispatch_id).all();
  const confirmations = dItems.results.map((d) => ({ dispatch_item_id: d.id, received_quantity: d.expected_quantity }));
  const receiveRes = await confirmReceive(env, bundleRes.dispatch_id, confirmations, "Store staff");
  assert(receiveRes.ok, "the whole bundle confirms successfully in one action");

  const wo1After = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(job1.wo.id).first();
  const wo2After = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(job2.wo.id).first();
  assert(wo1After.closed_at && wo1After.received_quantity_total === 1, "CRITICAL: job 1's work order is correctly closed, credited independently, despite being bundled with job 2's output");
  assert(wo2After.closed_at && wo2After.received_quantity_total === 1, "CRITICAL: job 2's work order is ALSO correctly closed independently — bundling didn't cross-contaminate the two");

  assert(receiveRes.created_lot_ids.length === 3, `three new lots correctly created at the store, one per bundled item, got ${receiveRes.created_lot_ids.length}`);

  const sareeStock = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(saree.id).first();
  const shawlStock = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(shawl.id).first();
  assert(sareeStock.t === 1 && shawlStock.t === 1, "each finished good correctly landed as real, sellable stock at the store");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
