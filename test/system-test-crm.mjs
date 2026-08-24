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
function getReq(qs) { return { url: "https://x/api/crm" + qs }; }

async function run() {
  section("Setup: a real production run through Mark Job Done, then a sale of the output");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const woMod = await import("../functions/api/work-orders.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const crmMod = await import("../functions/api/crm.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 2 }] }), env, params: { id: finishedItem.id } });

  const rawLot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: worker.id, quantity: 10, source_type: "direct_intake", cost_total: 500 }), env, data: {} })).json();
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  await issueMod.onRequestPost({ request: req({ lot_id: rawLot.id, quantity: 2 }), env, params: { id: wo.id } });
  const issue = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo.id).first();
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  await verifyMod.onRequestPost({ request: req({ item_id: rawItem.id, lot_id: issue.lot_id }), env, params: { id: issue.id } });
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  await stageMod.onRequestPost({ request: req({ stage: "Work Started", changed_by: "Zakir" }), env, params: { id: wo.id } });
  const markDoneRes = await (await markDoneMod.onRequestPost({ request: req({ quantity_done: 1, labor_cost: 200 }), env, params: { id: wo.id }, data: { user: { name: "Admin" } } })).json();
  assert(markDoneRes.raw_material_cost === 100 && markDoneRes.labor_cost === 200, "the production run correctly costs 100 raw material + 200 labor = 300 total COGS");

  await env.DB.prepare("UPDATE item_lots SET site_id = ? WHERE id = ?").bind(store.id, markDoneRes.finished_lot_id).run();

  const customer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  await salesMod.onRequestPost({ request: req({ lines: [{ item_id: finishedItem.id, lot_id: markDoneRes.finished_lot_id, quantity: 1, description: "Saree", sale_price: 1000 }], customer_party_id: customer.id, customer_name: null, sale_date: "2026-08-15" }), env, data: {} });

  section("The CRM page correctly traces genuine COGS through the actual production cost");
  const crmRes = await (await crmMod.onRequestGet({ request: getReq(""), env })).json();
  const susanEntry = crmRes.find(function (c) { return c.party_id === customer.id; });
  assert(susanEntry.total_order_value === 1000, "the total order value correctly matches the sale price");
  assert(susanEntry.approx_cogs === 300, "CRITICAL: the traced COGS correctly matches the real production cost (100 raw + 200 labor = 300)");
  assert(susanEntry.approx_profit_margin === 700, "CRITICAL: the profit margin correctly reflects sale price minus full COGS (1000-300=700)");

  section("A customer with zero sales is correctly excluded entirely");
  const emptyCustomer = await (await partiesMod.onRequestPost({ request: req({ name: "No Orders Yet", type: "customer" }), env })).json();
  const crmRes2 = await (await crmMod.onRequestGet({ request: getReq(""), env })).json();
  assert(!crmRes2.some(function (c) { return c.party_id === emptyCustomer.id; }), "a party with no sales at all correctly doesn't appear on the CRM page");

  section("Date filtering correctly excludes sales outside the selected period");
  const outsideRangeRes = await (await crmMod.onRequestGet({ request: getReq("?from=2026-09-01&to=2026-09-30"), env })).json();
  assert(!outsideRangeRes.some(function (c) { return c.party_id === customer.id; }), "CRITICAL: filtering to a period that excludes the sale date correctly shows nothing for that customer");

  const insideRangeRes = await (await crmMod.onRequestGet({ request: getReq("?from=2026-08-01&to=2026-08-31"), env })).json();
  assert(insideRangeRes.some(function (c) { return c.party_id === customer.id; }), "filtering to a period that includes the sale date correctly still shows it");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch(function (e) { console.error("CRASHED:", e); process.exit(1); });
