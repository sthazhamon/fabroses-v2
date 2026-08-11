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
  section("=== Setup: worker already has raw material (from BOM auto-resolution), drawn against by TWO jobs ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const bomMod = await import("../functions/api/items/[id]/bom.js");
  const woMod = await import("../functions/api/work-orders.js");
  const { confirmPick, shipDispatch, confirmReceive } = await import("../functions/api/_dispatch.js");
  const returnMaterialMod = await import("../functions/api/return-material.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const rawItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  const finishedItem = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await bomMod.onRequestPost({ request: req({ lines: [{ raw_material_item_id: rawItem.id, quantity_required: 5 }] }), env, params: { id: finishedItem.id } });

  const workerLot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: worker.id, quantity: 18, source_type: "opening_stock" }), env, data: {} })).json();

  const wo1 = await (await woMod.onRequestPost({ request: req({ description: "Job 1", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();
  const wo2 = await (await woMod.onRequestPost({ request: req({ description: "Job 2", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();

  const issue1 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo1.id).first();
  const issue2 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo2.id).first();
  assert(issue1 && issue2 && issue1.lot_id === workerLot.id && issue2.lot_id === workerLot.id, "both jobs drew from the SAME pre-existing worker lot via BOM auto-resolution, no fresh dispatch needed");

  const lotAfterBoth = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(workerLot.id).first();
  assert(lotAfterBoth.quantity_balance === 18, `balance correctly stays at 18 — both are RESERVED via material_issues, not yet consumed (that now happens at Mark Job Done), got ${lotAfterBoth.quantity_balance}`);

  section("=== Worker returns the 8 spare, with no job selection at all — genuinely generic ===");
  const returnRes = await (await returnMaterialMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: workerLot.id, quantity: 8 }), env })).json();
  assert(returnRes.dispatch_id, "creating the return requires no work_order_id — it's a plain stock transfer");
  const dispatchRow = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(returnRes.dispatch_id).first();
  assert(dispatchRow.related_work_order_id === null && dispatchRow.dispatch_type === "stock_transfer", "confirmed generic — not linked to any job");

  section("=== Store confirms — with two genuinely OPEN issues on that same item+site, FIFO correctly applies against them ===");
  await confirmPick(env, returnRes.dispatch_id, { item_id: rawItem.id, lot_id: workerLot.id, scanned_quantity: 8 });
  await shipDispatch(env, returnRes.dispatch_id, {}, "Zakir");
  const returnDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(returnRes.dispatch_id).first();
  await confirmReceive(env, returnRes.dispatch_id, [{ dispatch_item_id: returnDispItem.id, received_quantity: 8 }], "Store staff");

  const issue1Check = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue1.id).first();
  const issue2Check = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue2.id).first();
  // Both issues (5 each) were still genuinely OPEN — "already at worker" only
  // skips the shipping step, not reconciliation. With no job link to say
  // otherwise, FIFO correctly closes the older one (job 1) fully, then
  // applies the remaining 3 of 8 to the newer one (job 2).
  assert(issue1Check.quantity_returned_stock === 5 && issue1Check.status === "received",
    `the OLDER issue (job 1, issued 5) is correctly closed first by FIFO, got returned=${issue1Check.quantity_returned_stock}`);
  assert(issue2Check.quantity_returned_stock === 3 && issue2Check.status === "partially_returned",
    `the remaining 3 of the 8 correctly spills onto the newer issue (job 2, issued 5), got returned=${issue2Check.quantity_returned_stock}`);

  const storeStockAfter = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ? AND site_id = ?").bind(rawItem.id, store.id).first();
  assert(storeStockAfter.t === 8, `the store correctly received the physical 8 back regardless, got ${storeStockAfter.t}`);

  section("=== FIFO-by-age holds even across a third job — the oldest still-open issue always wins ===");
  // After the return above, the raw balance is 18-8=10, with issue2 still
  // holding 2 outstanding (reserved, not yet consumed). Genuinely-free
  // stock is 10-2=8 — drain that away deliberately first, so job 3's own
  // BOM auto-fulfillment genuinely has nothing left and has to fall
  // through to a real store dispatch, exercising that path on purpose
  // rather than relying on incidental exhaustion.
  const drainRes = await (await returnMaterialMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: workerLot.id, quantity: 8 }), env })).json();
  assert(drainRes.dispatch_id, "draining the remaining genuinely-free stock succeeds");
  await confirmPick(env, drainRes.dispatch_id, { item_id: rawItem.id, lot_id: workerLot.id, scanned_quantity: 8 });
  await shipDispatch(env, drainRes.dispatch_id, {}, "Zakir");
  const drainDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(drainRes.dispatch_id).first();
  await confirmReceive(env, drainRes.dispatch_id, [{ dispatch_item_id: drainDispItem.id, received_quantity: 8 }], "Store staff");

  const wo3 = await (await woMod.onRequestPost({ request: req({ description: "Job 3", worker_site_id: worker.id, intended_item_id: finishedItem.id, target_quantity: 1 }), env, data: {} })).json();
  const autoBomLine = wo3.bom_results.find((r) => r.resolution === "dispatch_created");
  assert(autoBomLine, "with the worker's site now genuinely drained, BOM auto-fulfillment correctly falls through to creating its own store dispatch for this job");

  await confirmPick(env, autoBomLine.dispatch_id, { item_id: rawItem.id, lot_id: null, scanned_quantity: autoBomLine.quantity });
  await shipDispatch(env, autoBomLine.dispatch_id, {}, "store staff");
  const autoDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(autoBomLine.dispatch_id).first();
  await confirmReceive(env, autoBomLine.dispatch_id, [{ dispatch_item_id: autoDispItem.id, received_quantity: autoBomLine.quantity }], "Zakir");

  const issue3 = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(wo3.id).first();
  // issue3.lot_id points at the ORIGINAL source lot (the store's own lot,
  // by design — that's what makes "scan to find open issues" work). The
  // worker's actual physical lot is a different, freshly-minted one at
  // their own site, found by item+site instead.
  const workerLot3 = await env.DB.prepare("SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY id DESC LIMIT 1").bind(rawItem.id, worker.id).first();
  assert(workerLot3.site_id === worker.id, "job 3's own dedicated worker-side lot was created fresh, separate from the earlier shared lot");

  const issue2AfterDrain = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue2.id).first();
  assert(issue2AfterDrain.status === "received", "issue2 is already fully closed by the drain step itself (it absorbed the last 2 of its own outstanding 5 during that generic reconciliation) — nothing left open on it by the time job 3 exists");

  const partialReturn = await (await returnMaterialMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: workerLot3.id, quantity: 2 }), env })).json();
  await confirmPick(env, partialReturn.dispatch_id, { item_id: rawItem.id, lot_id: workerLot3.id, scanned_quantity: 2 });
  await shipDispatch(env, partialReturn.dispatch_id, {}, "Zakir");
  const partialDispItem = await env.DB.prepare("SELECT * FROM dispatch_items WHERE dispatch_id = ?").bind(partialReturn.dispatch_id).first();
  await confirmReceive(env, partialReturn.dispatch_id, [{ dispatch_item_id: partialDispItem.id, received_quantity: 2 }], "Store staff");

  const issue3After = await env.DB.prepare("SELECT * FROM material_issues WHERE id = ?").bind(issue3.id).first();
  // With issue2 already closed, issue3 is the ONLY genuinely open issue
  // left for this item+site — so this return correctly applies entirely
  // to it, closing it fully (5 issued, 2 wanted this round covers the gap
  // left from job 3's own store-fulfilled quantity).
  assert(issue3After.quantity_returned_stock === 2,
    `with issue2 already closed, this return correctly applies entirely to issue3 — the only open issue left, got returned=${issue3After.quantity_returned_stock}`);

  section("=== A return with genuinely no matching issue at all still succeeds as a pure stock move ===");
  const freeLot = await (await lotsMod.onRequestPost({ request: req({ item_id: rawItem.id, site_id: worker.id, quantity: 3, source_type: "opening_stock" }), env, data: {} })).json();
  const freeReturnRes = await (await returnMaterialMod.onRequestPost({ request: req({ from_site_id: worker.id, lot_id: freeLot.id, quantity: 3 }), env })).json();
  assert(freeReturnRes.dispatch_id, "a lot with no open material_issues behind it at all still returns fine — reconciliation is a bonus, not a requirement");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
