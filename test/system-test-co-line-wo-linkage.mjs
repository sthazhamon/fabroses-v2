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
  section("=== Setup: a two-line customer order, no WOs yet ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const coDetailMod = await import("../functions/api/customer-orders/[id].js");
  const woMod = await import("../functions/api/work-orders.js");

  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Peacock Applique" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Custom Peacock" }), env })).json();
  const rawMaterialMod = await import("../functions/api/items.js");
  const rawMaterial = await (await rawMaterialMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Thread" }), env })).json();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(itemA.id, rawMaterial.id).run();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(itemB.id, rawMaterial.id).run();
  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", items: [{ item_id: itemA.id, quantity: 1 }, { item_id: itemB.id, quantity: 1 }] }), env })).json();

  section("=== Both lines appear in backlog before any WO exists ===");
  let detail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(detail.items.every((i) => !i.linked_work_order_id), "neither line has a WO yet");

  section("=== Creating a WO for ONLY line A must not hide line B from the backlog ===");
  const lineA = detail.items.find((i) => i.item_id === itemA.id);
  const lineB = detail.items.find((i) => i.item_id === itemB.id);
  const wo = await (await woMod.onRequestPost({
    request: req({ description: "Job for line A", worker_site_id: worker.id, intended_item_id: itemA.id, related_customer_order_id: co.id, related_customer_order_item_id: lineA.id }), env,
  })).json();

  detail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  const lineAAfter = detail.items.find((i) => i.item_id === itemA.id);
  const lineBAfter = detail.items.find((i) => i.item_id === itemB.id);
  assert(lineAAfter.linked_work_order_id === wo.id, "line A correctly shows its own linked WO");
  assert(!lineBAfter.linked_work_order_id, "CRITICAL: line B still correctly shows NO linked WO — this is the exact bug that was reported, now fixed");

  section("=== Order status correctly becomes 'partially_fulfilled', not fully awaiting_material ===");
  assert(detail.status === "partially_fulfilled", `order status correctly reflects that only ONE of two lines has a WO (got '${detail.status}')`);

  section("=== Creating a WO for the SECOND line completes the picture ===");
  const wo2 = await (await woMod.onRequestPost({
    request: req({ description: "Job for line B", worker_site_id: worker.id, intended_item_id: itemB.id, related_customer_order_id: co.id, related_customer_order_item_id: lineB.id }), env,
  })).json();
  detail = await (await coDetailMod.onRequestGet({ params: { id: co.id }, env })).json();
  assert(detail.status === "awaiting_material", `once BOTH lines have a WO, status correctly moves to awaiting_material (got '${detail.status}')`);
  assert(detail.items.every((i) => i.linked_work_order_id), "both lines now correctly show their own WO");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
