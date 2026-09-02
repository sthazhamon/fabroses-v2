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
  section("=== Setup: a store, a worker, a raw material, and a finished item with a BOM ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const woMod = await import("../functions/api/work-orders.js");
  const issueMod = await import("../functions/api/work-orders/[id]/issue-material.js");
  const verifyMod = await import("../functions/api/material-issues/[id]/verify.js");
  const stageMod = await import("../functions/api/work-orders/[id]/stage.js");
  const markDoneMod = await import("../functions/api/work-orders/[id]/mark-done.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  async function completeIssue(itemId, dispatchId) {
    const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
    await confirmPick(env, dispatchId, { item_id: itemId, lot_id: dItem.lot_id, scanned_quantity: dItem.expected_quantity });
    await shipDispatch(env, dispatchId, {}, "store staff");
    const shippedItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
    await confirmReceive(env, dispatchId, [{ dispatch_item_id: shippedItem.id, received_quantity: shippedItem.scanned_quantity }], "Zakir");
  }

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const fabric = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const saree = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: fabric.id, quantity_required: 5 }] }), env, params: { id: saree.id } });

  section("=== SCENARIO A: no supplier bill is ever entered - the PO's own rate should still flow through to COGS ===");
  const poA = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: fabric.id, quantity_ordered: 20, rate: 40 }] }), env })).json();
  const poALine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poA.id).items[0];
  const receiveARes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 20, site_id: store.id }), env, params: { id: poALine.id } })).json();

  const lotA = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(receiveARes.lot_id).first();
  assert(lotA.cost_total === 800, `CRITICAL: the lot's cost_total is correctly set from the PO's rate (40 x 20 = 800) at receive time, with NO bill entered at all - got ${lotA.cost_total}`);

  section("=== The raw material cost correctly reaches Mark Job Done, and thus COGS, without any bill ===");
  const woA = await (await woMod.onRequestPost({ request: req({ description: "Job A", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  const issueARes = await (await issueMod.onRequestPost({ request: req({ lot_id: lotA.id, quantity: 5 }), env, params: { id: woA.id } })).json();
  if (issueARes.dispatch_id) await completeIssue(fabric.id, issueARes.dispatch_id);
  const issueA = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(woA.id).first();
  await verifyMod.onRequestPost({ request: req({ item_id: fabric.id, lot_id: issueA.lot_id }), env, params: { id: issueA.id } });
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: woA.id } });
  const doneARes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: woA.id }, data: {} })).json();
  assert(doneARes.raw_material_cost === 200, `CRITICAL: raw material cost correctly computed as 40/unit x 5 units = 200, with zero bills ever entered - got ${doneARes.raw_material_cost}`);

  section("=== SCENARIO B: a bill is entered BEFORE the material is consumed - the actual billed rate should override the PO estimate ===");
  const poB = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: fabric.id, quantity_ordered: 10, rate: 40 }] }), env })).json();
  const poBLine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poB.id).items[0];
  const receiveBRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 10, site_id: store.id }), env, params: { id: poBLine.id } })).json();

  const lotBBeforeBill = await env.DB.prepare("SELECT cost_total FROM item_lots WHERE id = ?").bind(receiveBRes.lot_id).first();
  assert(lotBBeforeBill.cost_total === 400, "before any bill, the lot still correctly starts with the PO's own rate estimate (40 x 10 = 400)");

  // The actual bill arrives later, at a different, higher rate than the PO originally estimated.
  await sbMod.onRequestPost({
    request: req({ purchase_order_id: poB.id, supplier_name: "Cotton Threads", bill_date: "2026-08-15", lines: [{ purchase_order_item_id: poBLine.id, item_id: fabric.id, quantity: 10, rate: 45 }] }),
    env, data: {},
  });

  const lotBAfterBill = await env.DB.prepare("SELECT cost_total FROM item_lots WHERE id = ?").bind(receiveBRes.lot_id).first();
  assert(lotBAfterBill.cost_total === 450, `CRITICAL: entering the actual bill correctly UPDATES the lot's cost to the real billed rate (45 x 10 = 450), overriding the earlier PO estimate - got ${lotBAfterBill.cost_total}`);

  section("=== That updated, actual cost correctly reaches Mark Job Done ===");
  const woB = await (await woMod.onRequestPost({ request: req({ description: "Job B", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  const issueBRes = await (await issueMod.onRequestPost({ request: req({ lot_id: receiveBRes.lot_id, quantity: 5 }), env, params: { id: woB.id } })).json();
  if (issueBRes.dispatch_id) await completeIssue(fabric.id, issueBRes.dispatch_id);
  const issueB = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(woB.id).first();
  await verifyMod.onRequestPost({ request: req({ item_id: fabric.id, lot_id: issueB.lot_id }), env, params: { id: issueB.id } });
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: woB.id } });
  const doneBRes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: woB.id }, data: {} })).json();
  assert(doneBRes.raw_material_cost === 225, `CRITICAL: raw material cost correctly reflects the ACTUAL billed rate, not the original PO estimate - 45/unit x 5 units = 225, got ${doneBRes.raw_material_cost}`);

  section("=== A lot already fully consumed before the bill arrives is correctly left untouched (nothing left to update) ===");
  const poC = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: fabric.id, quantity_ordered: 5, rate: 40 }] }), env })).json();
  const poCLine = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poC.id).items[0];
  const receiveCRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 5, site_id: store.id }), env, params: { id: poCLine.id } })).json();
  const woC = await (await woMod.onRequestPost({ request: req({ description: "Job C", worker_site_id: worker.id, intended_item_id: saree.id, target_quantity: 1 }), env, data: {} })).json();
  const issueCRes = await (await issueMod.onRequestPost({ request: req({ lot_id: receiveCRes.lot_id, quantity: 5 }), env, params: { id: woC.id } })).json();
  if (issueCRes.dispatch_id) await completeIssue(fabric.id, issueCRes.dispatch_id);
  const issueC = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(woC.id).first();
  await verifyMod.onRequestPost({ request: req({ item_id: fabric.id, lot_id: issueC.lot_id }), env, params: { id: issueC.id } });
  await stageMod.onRequestPost({ request: req({ stage: "Work Started" }), env, params: { id: woC.id } });
  const doneCRes = await (await markDoneMod.onRequestPost({ request: req({}), env, params: { id: woC.id }, data: {} })).json();
  assert(doneCRes.raw_material_cost === 200, "job C correctly locked in 40/unit x 5 = 200 at the moment of production, using the PO rate since no bill existed yet");

  // The bill now arrives, at a different rate - but the lot has quantity_balance = 0, so nothing should be touched.
  await sbMod.onRequestPost({
    request: req({ purchase_order_id: poC.id, supplier_name: "Cotton Threads", bill_date: "2026-08-20", lines: [{ purchase_order_item_id: poCLine.id, item_id: fabric.id, quantity: 5, rate: 60 }] }),
    env, data: {},
  });
  const lotCAfterLateBill = await env.DB.prepare("SELECT cost_total FROM item_lots WHERE id = ?").bind(receiveCRes.lot_id).first();
  assert(lotCAfterLateBill.cost_total === 200, "CRITICAL: a fully-consumed lot's cost is correctly left untouched by a later bill - job C's already-locked-in 200 COGS is not retroactively disturbed");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
