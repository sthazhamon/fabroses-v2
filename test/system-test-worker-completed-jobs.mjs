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
  section("=== Setup: one open job and one closed job for the same worker ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const woMod = await import("../functions/api/work-orders.js");
  const workerPlaceMod = await import("../functions/api/worker-place.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(finishedItem.id, rawItem.id).run();

  const openWO = await (await woMod.onRequestPost({ request: req({ description: "Open job", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();
  const closedWO = await (await woMod.onRequestPost({ request: req({ description: "Closed job", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();
  await env.DB.prepare("UPDATE work_orders SET closed_at = datetime('now') WHERE id = ?").bind(closedWO.id).run();

  section("=== worker-place correctly separates open from completed jobs ===");
  const res = await (await workerPlaceMod.onRequestGet({ env, data: { user: { siteId: worker.id } } })).json();
  assert(res.pending_orders.length === 1 && res.pending_orders[0].id === openWO.id, "the still-open job correctly appears in pending_orders");
  assert(res.completed_orders.length === 1 && res.completed_orders[0].id === closedWO.id, "CRITICAL: the closed job correctly appears in completed_orders, not pending_orders");
  assert(!res.pending_orders.some((w) => w.id === closedWO.id), "the closed job correctly does NOT also appear in pending_orders");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
