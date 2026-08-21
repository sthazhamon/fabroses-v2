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
  section("=== Setup: a worker with 6 units of leftover Linen ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const returnMod = await import("../functions/api/return-material.js");
  const { confirmPick, shipDispatch } = await import("../functions/api/_dispatch.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Murtaza", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 6, source_type: "opening_stock" }), env, data: {} })).json();

  section("=== CRITICAL: the exact reported bug — clicking Return twice on the same stock ===");
  const firstReturn = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot.id, quantity: 6 }), env })).json();
  assert(firstReturn.dispatch_id, "the first return correctly creates a dispatch for all 6");

  const secondReturnAttempt = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot.id, quantity: 6 }), env })).json();
  assert(secondReturnAttempt.error, "CRITICAL: a second return of the same 6 units, while the first dispatch is still pending, is now correctly rejected — this is the exact bug reported");

  section("=== Once the first dispatch actually ships, the lot is genuinely empty, not falsely available again ===");
  await confirmPick(env, firstReturn.dispatch_id, { item_id: item.id, lot_id: lot.id, scanned_quantity: 6 });
  await shipDispatch(env, firstReturn.dispatch_id, {}, "worker");

  const afterShipAttempt = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot.id, quantity: 1 }), env })).json();
  assert(afterShipAttempt.error, "once genuinely shipped away, trying to return even 1 more unit correctly fails — nothing left at all");

  section("=== A partial return correctly still allows returning the genuine remainder ===");
  const lot2 = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} })).json();
  const partialReturn = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot2.id, quantity: 4 }), env })).json();
  assert(partialReturn.dispatch_id, "returning 4 of 10 succeeds");

  const remainderAttempt = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot2.id, quantity: 6 }), env })).json();
  assert(remainderAttempt.dispatch_id, "returning the genuine remainder (6 of the original 10, since 4 is already committed) correctly succeeds");

  const overRemainderAttempt = await (await returnMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: lot2.id, quantity: 1 }), env })).json();
  assert(overRemainderAttempt.error, "and now that all 10 are committed across two dispatches, even 1 more is correctly rejected");

  section("=== The same fix applies to issue-material.js's direct-issue path too ===");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const dedicatedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk Thread" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(finishedItem.id, dedicatedItem.id).run();
  const workerLot = await (await lotsMod.onRequestPost({ request: req({ item_id: dedicatedItem.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  const wo1 = await (await woMod.onRequestPost({ request: req({ description: "Job A", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job B", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();

  const firstIssue = await (await issueMod.onRequestPost({ request: req({ lot_id: workerLot.id, quantity: 5 }), env, params: { id: wo1.id } })).json();
  assert(firstIssue.direct_issue === true, "first job's direct issue of all 5 succeeds");

  const secondIssueAttempt = await (await issueMod.onRequestPost({ request: req({ lot_id: workerLot.id, quantity: 5 }), env, params: { id: wo2.id } })).json();
  assert(secondIssueAttempt.error, "CRITICAL: a second job trying to claim the SAME already-consumed 5 units is correctly rejected, not double-counted");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
