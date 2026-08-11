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
  section("=== Setup: a job, with the raw material split across store AND the worker's own site ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const availableLotsMod = await import("../functions/api/work-orders/[id]/available-lots.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }] }), env, params: { id: saree.id } });

  const storeLot = await (await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: store.id, quantity: 20, source_type: "direct_intake" }), env, data: {} })).json();
  const workerLot = await (await lotsMod.onRequestPost({ request: req({ item_id: fabric.id, site_id: worker.id, quantity: 3, source_type: "opening_stock" }), env, data: {} })).json();

  // Create the WO with material_lines=[] to skip auto-fulfillment, so we control issuance manually for this test
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();

  section("=== available-lots correctly shows BOTH the store lot and the worker's own lot ===");
  const availRes = await (await availableLotsMod.onRequestGet({ request: { url: "https://x/api/work-orders/" + wo.id + "/available-lots?item_id=" + fabric.id }, env, params: { id: wo.id } })).json();
  assert(availRes.lots.length === 2, `both lots correctly shown — store and worker (got ${availRes.lots.length})`);
  const workerLotEntry = availRes.lots.find((l) => l.id === workerLot.id);
  const storeLotEntry = availRes.lots.find((l) => l.id === storeLot.id);
  assert(workerLotEntry.site_name === "Zakir" && storeLotEntry.site_name === "Store", "each lot correctly shows its own site name");

  section("=== Choosing the WORKER's own lot creates a DIRECT issue, no dispatch at all ===");
  const directRes = await (await issueMod.onRequestPost({ request: req({ lot_id: workerLot.id, quantity: 3 }), env, params: { id: wo.id } })).json();
  assert(directRes.direct_issue === true && directRes.issue_id, "correctly resolved as a direct issue, not a dispatch");

  const dispatchCountAfterDirect = await env.DB.prepare("SELECT COUNT(*) AS c FROM dispatches WHERE related_work_order_id = ?").bind(wo.id).first();
  assert(dispatchCountAfterDirect.c === 0, "CRITICAL: no dispatch was created for material already sitting at the worker's own site");

  const workerLotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(workerLot.id).first();
  assert(workerLotAfter.quantity_balance === 0, "the worker's own lot balance correctly dropped immediately, since this is a direct issue");

  const directIssueRow = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(directRes.issue_id).first();
  assert(directIssueRow.status === "with_worker" && directIssueRow.quantity_issued === 3, "a real, reconcilable material issue exists for this direct issue");

  section("=== Choosing a STORE lot still creates a real dispatch, exactly as before ===");
  const dispatchRes = await (await issueMod.onRequestPost({ request: req({ lot_id: storeLot.id, quantity: 5 }), env, params: { id: wo.id } })).json();
  assert(dispatchRes.direct_issue === false && dispatchRes.dispatch_id, "correctly resolved as a real dispatch, since this lot is at the store");

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(dispatchRes.dispatch_id).first();
  assert(dispatch.status === "pending_pick" && dispatch.from_site_id === store.id && dispatch.to_site_id === worker.id, "the dispatch is correctly pending pick, from the store to the worker");

  const storeLotAfter = await env.DB.prepare("SELECT quantity_balance FROM item_lots WHERE id = ?").bind(storeLot.id).first();
  assert(storeLotAfter.quantity_balance === 20, "CRITICAL: the store lot is untouched at creation time — the real decrement only happens later at actual pick/ship, matching the two-step design everywhere else");

  section("=== Quantity is capped by the chosen lot's own available amount ===");
  const overRequest = await (await issueMod.onRequestPost({ request: req({ lot_id: storeLot.id, quantity: 100 }), env, params: { id: wo.id } })).json();
  assert(overRequest.error, "requesting more than the chosen lot actually has is correctly rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
