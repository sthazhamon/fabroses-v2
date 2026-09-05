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
  section("=== Setup: a WO created from a CO, for a named customer ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const woMod = await import("../functions/api/work-orders.js");
  const alertsMod = await import("../functions/api/dashboard-alerts.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const raw = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Fabric" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: raw.id, quantity_required: 5 }] }), env, params: { id: saree.id } });

  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan Verghese", items: [{ item_id: saree.id, quantity: 1 }] }), env })).json();
  await woMod.onRequestPost({ request: req({ description: "For order "+co.id, worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1, related_customer_order_id: co.id }), env, data: {} });

  section("=== CRITICAL: the dashboard now shows the item name and customer, not just the generic WO description ===");
  const alerts = await (await alertsMod.onRequestGet({ env })).json();
  const woEntry = alerts.pending_work_orders[0];
  assert(woEntry.intended_item_name === "Peacock Applique Saree", `CRITICAL: item name correctly surfaced, got ${woEntry.intended_item_name}`);
  assert(woEntry.customer_name === "Susan Verghese", `CRITICAL: customer name correctly surfaced for the admin dashboard, got ${woEntry.customer_name}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
