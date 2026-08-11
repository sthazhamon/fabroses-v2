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

  section("=== WO creation without an intended item is now rejected ===");
  const noItemAttempt = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, target_quantity: 1 }), env, data: {} })).json();
  assert(noItemAttempt.error, "the finished item is now mandatory, not optional");

  section("=== Case 1: worker already has enough thread from a previous job — no dispatch needed ===");
  await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} });

  const wo1 = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 2 }), env, data: { user: { name: "Admin" } } })).json();
  const threadResult = wo1.bom_results.find((r) => r.raw_material_item_id === thread.id);
  assert(threadResult.resolution === "already_at_worker" && threadResult.quantity === 4, `thread (needed 2x2=4) correctly resolved from the worker's own existing stock, no dispatch (got ${JSON.stringify(threadResult)})`);

  const threadIssue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ? AND lot_id IN (SELECT id FROM item_lots WHERE item_id = ?)").bind(wo1.id, thread.id).first();
  assert(threadIssue && threadIssue.quantity_issued === 4, "a real, reconcilable material issue was still created even though nothing physically moved");

  const threadStockAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(thread.id, worker.id).first();
  assert(threadStockAfter.quantity_balance === 10, `worker's thread stock correctly stays at 10 (reserved via the material issue, but NOT yet consumed — actual consumption is deferred to Mark Job Done), got ${threadStockAfter.quantity_balance}`);

  section("=== Case 2: fabric isn't at the worker, but the store has enough — auto-dispatch created ===");
  const fabricResult = wo1.bom_results.find((r) => r.raw_material_item_id === fabric.id);
  assert(fabricResult.resolution === "dispatch_created" && fabricResult.quantity === 10, `fabric (needed 5x2=10) correctly triggers an auto-dispatch from the store (got ${JSON.stringify(fabricResult)})`);

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(fabricResult.dispatch_id).first();
  assert(dispatch.status === "pending_pick" && dispatch.dispatch_type === "stock_transfer", "the auto-created dispatch sits pending_pick, exactly like a manually-created one — nothing skips the two-step process");

  const storeFabricAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE item_id = ? AND site_id = ?").bind(fabric.id, store.id).first();
  assert(storeFabricAfter.quantity_balance === 20, "CRITICAL: the store's fabric lot is completely untouched at creation time — the real decrement only happens later at actual ship time, matching the two-step design");

  section("=== Case 3: multiple lots at the store combine to cover one requirement ===");
  const item2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const saree2 = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Silk Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: item2.id, quantity_required: 15 }] }), env, params: { id: saree2.id } });
  await lotsMod.onRequestPost({ request: req({ item_id: item2.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} });
  await lotsMod.onRequestPost({ request: req({ item_id: item2.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} });

  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker.id, intended_item_id: saree2.id, target_quantity: 1 }), env, data: {} })).json();
  const silkResult = wo2.bom_results.find((r) => r.raw_material_item_id === item2.id);
  assert(silkResult.resolution === "dispatch_created" && silkResult.lots_used === 2, `needing 15, with two lots of 10 each at the store, correctly combines BOTH lots into one dispatch (got lots_used=${silkResult.lots_used})`);

  const dispatchItems = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(silkResult.dispatch_id).all();
  const totalExpected = dispatchItems.results.reduce((s, d) => s + d.expected_quantity, 0);
  assert(dispatchItems.results.length === 2 && totalExpected === 15, `the dispatch correctly has 2 separate line items (one per lot), summing to exactly 15 (got ${totalExpected})`);

  section("=== Case 4: genuinely unmet — neither worker nor store has enough ===");
  const rareItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Rare Silk" }), env })).json();
  const saree3 = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Rare Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rareItem.id, quantity_required: 100 }] }), env, params: { id: saree3.id } });

  const wo3 = await (await woMod.onRequestPost({ request: req({ description: "Job 3", worker_site_id: worker.id, intended_item_id: saree3.id, target_quantity: 1 }), env, data: {} })).json();
  const rareResult = wo3.bom_results.find((r) => r.raw_material_item_id === rareItem.id);
  assert(rareResult.resolution === "unmet", "with zero stock anywhere, the line is correctly left unmet — no fake dispatch, no fake issue");

  const dispatchQueueMod = await import("../functions/api/dispatch-queue.js");
  const queue = await (await dispatchQueueMod.onRequestGet({ env })).json();
  assert(queue.material_to_workers.some((w) => w.id === wo3.id), "the unmet WO correctly surfaces in the EXISTING dispatch queue detection, without needing any new tracking mechanism");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
