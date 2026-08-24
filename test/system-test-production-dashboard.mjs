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
function getReq(qs) { return { url: "https://x/api/production-dashboard" + qs }; }

async function run() {
  section("=== Setup: two workers, work orders at different stages, one linked to a CO ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const woMod = await import("../functions/api/work-orders.js");
  const coMod = await import("../functions/api/customer-orders.js");
  const dashboardMod = await import("../functions/api/production-dashboard.js");

  const workerA = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const workerB = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await env.DB.prepare("INSERT INTO item_bom (finished_item_id, raw_material_item_id, quantity_required) VALUES (?, ?, 1)").bind(finishedItem.id, rawItem.id).run();

  const co = await (await coMod.onRequestPost({ request: req({ customer_name: "Susan", promised_delivery_date: "2026-09-01", items: [{ item_id: finishedItem.id, quantity: 1 }] }), env })).json();
  const woWithCO = await (await woMod.onRequestPost({ request: req({ description: "Job for Susan", worker_site_id: workerA.id, intended_item_id: finishedItem.id, target_quantity: 1, related_customer_order_id: co.id }), env, data: {} })).json();
  const woNoCO = await (await woMod.onRequestPost({ request: req({ description: "Generic stock job", worker_site_id: workerB.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();
  await env.DB.prepare("UPDATE work_orders SET stage = 'Material Received' WHERE id = ?").bind(woNoCO.id).run();

  section("=== Every genuinely occurring stage is correctly grouped, including Material Received ===");
  const dashRes = await (await dashboardMod.onRequestGet({ request: getReq(""), env })).json();
  assert(dashRes.by_stage["Order Placed"].some((w) => w.id === woWithCO.id), "the fresh WO correctly sits under Order Placed");
  assert(dashRes.by_stage["Material Received"].some((w) => w.id === woNoCO.id), "CRITICAL: the Material Received stage is correctly present and populated");

  section("=== Customer order context is correctly joined in ===");
  const woWithCOEntry = dashRes.all.find((w) => w.id === woWithCO.id);
  assert(woWithCOEntry.customer_name === "Susan" && woWithCOEntry.promised_delivery_date === "2026-09-01", "CRITICAL: the linked CO's customer name and expected delivery date are correctly joined in");

  const woNoCOEntry = dashRes.all.find((w) => w.id === woNoCO.id);
  assert(!woNoCOEntry.customer_name, "a work order with no linked CO correctly shows no customer name");

  section("=== Search matches across WO description and CO customer name ===");
  const searchByCustomer = await (await dashboardMod.onRequestGet({ request: getReq("?search=Susan"), env })).json();
  assert(searchByCustomer.all.length === 1 && searchByCustomer.all[0].id === woWithCO.id, "searching by customer name correctly finds only the matching work order");

  const searchByDescription = await (await dashboardMod.onRequestGet({ request: getReq("?search=Generic"), env })).json();
  assert(searchByDescription.all.length === 1 && searchByDescription.all[0].id === woNoCO.id, "searching by WO description correctly finds the matching work order");

  section("=== Filtering by worker correctly segregates results ===");
  const byWorkerA = await (await dashboardMod.onRequestGet({ request: getReq("?worker_site_id=" + workerA.id), env })).json();
  assert(byWorkerA.all.length === 1 && byWorkerA.all[0].id === woWithCO.id, "filtering by worker A correctly returns only their own job");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
