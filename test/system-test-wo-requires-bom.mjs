import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log("  \x1b[32m\u2713\x1b[0m " + l); } else { failed++; console.log("  \x1b[31m\u2717 FAIL\x1b[0m " + l); } }
function section(t) { console.log("\n" + t); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== A production job for an item with NO BOM is correctly refused ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const woMod = await import("../functions/api/work-orders.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const bomLessItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Kerala Cotton Applique Saree" }), env })).json();

  const blockedRes = await (await woMod.onRequestPost({ request: req({ description: "Job for CO-1", worker_site_id: worker.id, intended_item_id: bomLessItem.id, target_quantity: 1 }), env, data: {} })).json();
  assert(blockedRes.error, "CRITICAL: creating a production WO for an item with no BOM is correctly refused up front");

  const woCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM work_orders").first();
  assert(woCount.c === 0, "no work order record was created - the block happens before anything is written");

  section("=== Adding a BOM afterward correctly allows creation ===");
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Cotton" }), env })).json();
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 2 }] }), env, params: { id: bomLessItem.id } });

  const allowedRes = await (await woMod.onRequestPost({ request: req({ description: "Job for CO-1", worker_site_id: worker.id, intended_item_id: bomLessItem.id, target_quantity: 1 }), env, data: {} })).json();
  assert(allowedRes.id && !allowedRes.error, "once a BOM is defined, creating the work order correctly succeeds");

  section("=== A rework job is correctly unaffected by this rule, even with no BOM ===");
  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const lotsMod = await import("../functions/api/item-lots.js");
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: bomLessItem.id, site_id: store.id, quantity: 1, source_type: "opening_stock" }), env, data: {} })).json();

  const reworkRes = await (await woMod.onRequestPost({ request: req({ description: "Rework this piece", worker_site_id: worker.id, intended_item_id: bomLessItem.id, target_quantity: 1, job_type: "rework", rework_lot_id: lot.id }), env, data: {} })).json();
  assert(reworkRes.id && !reworkRes.error, "CRITICAL: a rework job correctly succeeds regardless of BOM status");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
