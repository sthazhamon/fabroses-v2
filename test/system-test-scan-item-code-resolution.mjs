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
  section("=== Setup: an item with a generated item_code, exactly like the reported scenario ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch, confirmPick } = await import("../functions/api/_dispatch.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");

  const cat = await env.DB.prepare("SELECT id FROM item_categories WHERE code = 'PTY'").first();
  const fab = await env.DB.prepare("SELECT id FROM item_fabrics WHERE code = 'LIN'").first();
  const wt = await env.DB.prepare("SELECT id FROM item_work_types WHERE code = 'APL'").first();
  const pat = await env.DB.prepare("SELECT id FROM item_patterns WHERE code = 'FLR'").first();

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const itemRes = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique", category_id: cat.id, fabric_id: fab.id, work_type_id: wt.id, pattern_id: pat.id }), env })).json();
  assert(itemRes.item_code && itemRes.item_code.startsWith("FR-"), `the item genuinely has a generated item_code, got ${itemRes.item_code}`);

  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: itemRes.id, site_id: store.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();

  section("=== CRITICAL: confirmPick now correctly accepts item_code, not just the internal ID ===");
  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: itemRes.id, lot_id: lot.id, expected_quantity: 1 }] });
  // This simulates exactly what the user reported: a value typed/pasted
  // in from a generic phone camera scan, which shows the raw item_code
  // with no resolution applied - not the app's own in-app scanner, which
  // already resolves this client-side.
  const pickRes = await confirmPick(env, dispatchId, { item_id: itemRes.item_code, lot_id: lot.id, scanned_quantity: 1 });
  assert(!pickRes.error, `CRITICAL: scanning the item_code directly (as a generic phone scan would produce) is correctly accepted, got error: ${pickRes.error}`);

  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota Fabric" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 1 }] }), env, params: { id: itemRes.id } });

  section("=== CRITICAL: material-issue verify also correctly accepts item_code ===");
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: itemRes.id, target_quantity: 1 }), env, data: {} })).json();
  const workerLot = await (await lotsMod.onRequestPost({ request: req({ item_id: itemRes.id, site_id: worker.id, quantity: 5, source_type: "opening_stock" }), env, data: {} })).json();
  await issueMod.onRequestPost({ request: req({ lot_id: workerLot.id, quantity: 1 }), env, params: { id: wo.id } });
  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  const verifyRes = await (await verifyMod.onRequestPost({ request: req({ item_id: itemRes.item_code, lot_id: issue.lot_id }), env, params: { id: issue.id } })).json();
  assert(verifyRes.ok === true, `CRITICAL: verifying with item_code directly is correctly accepted, got: ${JSON.stringify(verifyRes)}`);

  section("=== A genuinely wrong item is still correctly rejected, even by code ===");
  const otherItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Unrelated Thread" }), env })).json();
  const dispatchId2 = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: itemRes.id, lot_id: lot.id, expected_quantity: 1 }] });
  const wrongPickRes = await confirmPick(env, dispatchId2, { item_id: otherItem.id, lot_id: lot.id, scanned_quantity: 1 });
  assert(wrongPickRes.mismatch === true, "a genuinely different, unrelated item is still correctly rejected as a mismatch");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
