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
  section("=== An order with no linked work order at all shows as unactioned ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const woMod = await import("../functions/api/work-orders.js");
  const alertsMod = await import("../functions/api/dashboard-alerts.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(item.id, rawItem.id).run();
  const unactionedCO = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();

  const alertsRes1 = await (await alertsMod.onRequestGet({ env })).json();
  assert(alertsRes1.unactioned_orders.some((o) => o.id === unactionedCO.id), "the unlinked order correctly shows as unactioned");

  section("=== An order whose line IS linked to a work order no longer shows ===");
  const actionedCO = await (await coMod.onRequestPost({ request: req({ customer_name: "Anu", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: item.id, target_quantity: 1 }), env, data: {} })).json();
  const line = await env.DB.prepare("SELECT id FROM customer_order_items WHERE customer_order_id = ?").bind(actionedCO.id).first();
  await env.DB.prepare("UPDATE customer_order_items SET linked_work_order_id = ? WHERE id = ?").bind(wo.id, line.id).run();

  const alertsRes2 = await (await alertsMod.onRequestGet({ env })).json();
  assert(!alertsRes2.unactioned_orders.some((o) => o.id === actionedCO.id), "once a line is linked to a work order, the order correctly stops showing as unactioned");
  assert(alertsRes2.unactioned_orders.some((o) => o.id === unactionedCO.id), "the still-unlinked order correctly remains in the list");

  section("=== A billed order never shows, regardless of linkage ===");
  const billedCO = await (await coMod.onRequestPost({ request: req({ customer_name: "Cozy", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();
  await env.DB.prepare("UPDATE customer_orders SET status = 'billed' WHERE id = ?").bind(billedCO.id).run();
  const alertsRes3 = await (await alertsMod.onRequestGet({ env })).json();
  assert(!alertsRes3.unactioned_orders.some((o) => o.id === billedCO.id), "a billed order correctly never shows as needing attention");

  section("=== Overdue work orders correctly show, on-time and closed ones don't ===");
  const overdueWO = await (await woMod.onRequestPost({ request: req({ description: "Overdue job", worker_site_id: worker.id, intended_item_id: item.id, target_quantity: 1, due_date: "2020-01-01" }), env, data: {} })).json();
  const futureWO = await (await woMod.onRequestPost({ request: req({ description: "Future job", worker_site_id: worker.id, intended_item_id: item.id, target_quantity: 1, due_date: "2099-01-01" }), env, data: {} })).json();
  const closedOverdueWO = await (await woMod.onRequestPost({ request: req({ description: "Closed but was overdue", worker_site_id: worker.id, intended_item_id: item.id, target_quantity: 1, due_date: "2020-01-01" }), env, data: {} })).json();
  await env.DB.prepare("UPDATE work_orders SET closed_at = datetime('now') WHERE id = ?").bind(closedOverdueWO.id).run();

  const alertsRes4 = await (await alertsMod.onRequestGet({ env })).json();
  assert(alertsRes4.overdue_work_orders.some((w) => w.id === overdueWO.id), "the genuinely overdue, still-open job correctly shows");
  assert(!alertsRes4.overdue_work_orders.some((w) => w.id === futureWO.id), "a job due in the future correctly doesn't show");
  assert(!alertsRes4.overdue_work_orders.some((w) => w.id === closedOverdueWO.id), "a job that WAS overdue but is now closed correctly doesn't show");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
