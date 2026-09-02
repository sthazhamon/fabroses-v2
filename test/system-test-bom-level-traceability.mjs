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
  section("=== Setup: a real production run - two raw materials go into one finished saree ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");
  const historyMod = await import("../functions/api/item-lots/[id]/history.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota Fabric" }), env })).json();
  const thread = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk Thread" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Applique Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }, { raw_material_item_id: thread.id, quantity_required: 2 }] }), env, params: { id: saree.id } });

  const fabricLot = await (await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} })).json();
  const threadLot = await (await lotsMod.onRequestPost({ request: req({ item_id: thread.id, site_id: worker.id, quantity: 10, source_type: "opening_stock" }), env, data: {} })).json();

  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  await issueMod.onRequestPost({ request: req({ lot_id: fabricLot.id, quantity: 5 }), env, params: { id: wo.id } });
  await issueMod.onRequestPost({ request: req({ lot_id: threadLot.id, quantity: 2 }), env, params: { id: wo.id } });
  const issues = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).all();
  for (const issue of issues.results) {
    const itemId = (await env.DB.prepare("SELECT item_id FROM item_lots WHERE id=?").bind(issue.lot_id).first()).item_id;
    await verifyMod.onRequestPost({ request: req({ item_id: itemId, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  }
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: wo.id } });
  const doneRes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: wo.id }, data: {} })).json();

  section("=== CRITICAL: the finished lot's history now shows what it was actually MADE FROM, not just its own movements ===");
  const historyRes = await (await historyMod.onRequestGet({ env, params: { id: doneRes.finished_lot_id } })).json();
  assert(Array.isArray(historyRes.bom_consumption), "the response correctly includes a bom_consumption array");
  assert(historyRes.bom_consumption.length === 2, `CRITICAL: both raw materials consumed to make this saree are correctly traced, got ${historyRes.bom_consumption.length}`);

  const fabricEntry = historyRes.bom_consumption.find((c) => c.item_name === "Kota Fabric");
  const threadEntry = historyRes.bom_consumption.find((c) => c.item_name === "Silk Thread");
  assert(fabricEntry && fabricEntry.quantity === 5, `CRITICAL: the fabric consumption is correctly traced with the right quantity, got ${fabricEntry?.quantity}`);
  assert(threadEntry && threadEntry.quantity === 2, `CRITICAL: the thread consumption is correctly traced with the right quantity, got ${threadEntry?.quantity}`);
  assert(fabricEntry.lot_id === fabricLot.id, "the fabric entry correctly points back to the exact specific lot it was consumed from");

  section("=== A raw material lot itself (never produced by a WO) correctly shows no BOM consumption at all ===");
  const rawHistoryRes = await (await historyMod.onRequestGet({ env, params: { id: fabricLot.id } })).json();
  assert(rawHistoryRes.bom_consumption.length === 0, "a raw material lot correctly has no bom_consumption of its own, since nothing was consumed to create IT");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
