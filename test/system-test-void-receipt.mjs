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
  section("=== Voiding a wrong PO-line receipt ===");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");
  const voidMod = await import("../functions/api/item-lots/[id]/void-receipt.js");
  const sitesMod = await import("../functions/api/sites.js");

  await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env });
  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  const poA = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: itemA.id, quantity_ordered: 50, rate: 100 }] }), env })).json();
  const lineA = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poA.id).items[0];

  const wrongReceiveRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 20 }), env, params: { id: lineA.id } })).json();
  assert(wrongReceiveRes.lot_id, "the (mistaken) receipt succeeds, creating a lot");

  const voidRes = await (await voidMod.onRequestPost({ env, params: { id: wrongReceiveRes.lot_id } })).json();
  assert(voidRes.ok, "voiding the mistaken receipt succeeds");

  const lotAfterVoid = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(wrongReceiveRes.lot_id).first();
  assert(lotAfterVoid.quantity_balance === 0 && lotAfterVoid.quantity_original === 0, "the voided lot correctly zeroes out rather than being deleted — still visible in history");

  const lineAAfterVoid = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(lineA.id).first();
  assert(lineAAfterVoid.quantity_received === 0 && lineAAfterVoid.status === "ordered", `CRITICAL: the PO line's received quantity is correctly reversed back to 0, got ${lineAAfterVoid.quantity_received}`);

  section("=== A short-closed line stays short-closed even after voiding a receipt on it ===");
  const poB = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: itemB.id, quantity_ordered: 30, rate: 50 }] }), env })).json();
  const lineB = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poB.id).items[0];
  const receiveB = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: lineB.id } })).json();
  const shortCloseMod = await import("../functions/api/purchase-order-items/[id]/short-close.js");
  await shortCloseMod.onRequestPost({ env, params: { id: lineB.id } });

  await voidMod.onRequestPost({ env, params: { id: receiveB.lot_id } });
  const lineBAfter = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(lineB.id).first();
  assert(lineBAfter.status === "short_closed", "the line's deliberate short-close status is correctly preserved, not silently undone by the void");

  section("=== CRITICAL: voiding is refused once part of the lot has already been used elsewhere ===");
  const itemC = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Cotton" }), env })).json();
  const poC = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cozy", items: [{ item_id: itemC.id, quantity_ordered: 20, rate: 30 }] }), env })).json();
  const lineC = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === poC.id).items[0];
  const receiveC = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 10 }), env, params: { id: lineC.id } })).json();
  await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - 3 WHERE id = ?").bind(receiveC.lot_id).run();

  const blockedVoid = await (await voidMod.onRequestPost({ env, params: { id: receiveC.lot_id } })).json();
  assert(blockedVoid.error, "voiding is correctly refused once part of what it created has already been consumed elsewhere");

  section("=== Voiding a dispatch confirm-receive lot correctly reverses work order credit ===");
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const finished = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const { createDispatch, confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const woMod = await import("../functions/api/work-orders.js");
  const wo = await (await woMod.onRequestPost({ request: req({ description: "Job", worker_site_id: worker.id, intended_item_id: finished.id, target_quantity: 1, material_lines: [] }), env, data: {} })).json();

  const fakeFinishedLotId = "LOT-999001";
  await env.DB.prepare("INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference) VALUES (?, ?, ?, 1, 1, 'work_order_output', ?)")
    .bind(fakeFinishedLotId, finished.id, worker.id, wo.id).run();
  await env.DB.prepare("UPDATE work_orders SET stage = 'Work Done' WHERE id = ?").bind(wo.id).run();

  const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type='store' LIMIT 1").first();
  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: worker.id, to_site_id: storeSite.id, items: [{ item_id: finished.id, lot_id: fakeFinishedLotId, expected_quantity: 1 }] });
  await confirmPick(env, dispatchId, { item_id: finished.id, lot_id: fakeFinishedLotId, scanned_quantity: 1 });
  await shipDispatch(env, dispatchId, {}, "Zakir");
  const dItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(dispatchId).first();
  const receiveRes = await confirmReceive(env, dispatchId, [{ dispatch_item_id: dItem.id, received_quantity: 1 }], "Store staff");

  const woAfterReceive = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfterReceive.closed_at, "confirming the finished good correctly closed the work order");

  const newLotId = receiveRes.created_lot_ids[0].lot_id;
  const voidDispatchRes = await (await voidMod.onRequestPost({ env, params: { id: newLotId } })).json();
  assert(voidDispatchRes.ok, "voiding the dispatch confirm-receive lot succeeds");

  const woAfterVoid = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(wo.id).first();
  assert(woAfterVoid.closed_at === null && woAfterVoid.received_quantity_total === 0, `CRITICAL: the work order's credit is correctly reversed — no longer closed, progress back to 0, got closed_at=${woAfterVoid.closed_at}, received=${woAfterVoid.received_quantity_total}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
