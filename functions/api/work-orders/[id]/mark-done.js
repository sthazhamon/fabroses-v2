import { reconcileMaterialIssue } from "../../_bom.js";

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json().catch(() => ({}));
  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.job_type !== "production") return Response.json({ error: "Mark Job Done applies to production jobs — rework has its own flow" }, { status: 400 });
  if (order.stage !== "Work Started") return Response.json({ error: `This job is at "${order.stage}" — it needs to be Work Started before it can be marked done` }, { status: 400 });
  if (order.cancelled_at) return Response.json({ error: "This job is cancelled" }, { status: 400 });

  const quantityDone = body.quantity_done || order.target_quantity;

  // Upfront validation, BEFORE touching anything: every BOM line needs
  // enough reserved material across this job's open issues. This catches
  // both "some was reserved but not enough" and "this raw material was
  // never reserved at all" (the BOM auto-fulfillment "unmet" case) —
  // closing out whatever issues happen to exist isn't enough on its own.
  const { results: bomLines } = await env.DB.prepare("SELECT * FROM item_bom WHERE finished_item_id = ?").bind(order.intended_item_id).all();
  const { results: openIssues } = await env.DB.prepare(
    `SELECT mi.*, l.item_id AS raw_item_id FROM material_issues mi LEFT JOIN item_lots l ON l.id = mi.lot_id WHERE mi.work_order_id = ? AND mi.status != 'received'`
  ).bind(params.id).all();

  for (const bomLine of bomLines) {
    const expected = bomLine.quantity_required * quantityDone;
    const reserved = openIssues.filter((i) => i.raw_item_id === bomLine.raw_material_item_id).reduce((s, i) => s + (i.quantity_issued - i.quantity_returned_stock - i.quantity_wasted), 0);
    if (reserved < expected - 0.001) {
      return Response.json({ error: `Not enough raw material reserved for this job — needs ${expected}, only ${reserved} reserved. Check whether a dispatch is still in transit, or issue more material first.` }, { status: 400 });
    }
  }

  // Everything checks out — now actually close out every open issue.
  const consumptionLog = [];
  for (const issue of openIssues) {
    try {
      const r = await reconcileMaterialIssue(env, issue.id, { close_fully: true }, data.user?.name);
      consumptionLog.push({ material_issue_id: issue.id, ...r });
    } catch (e) {
      return Response.json({ error: `Couldn't close out material issue ${issue.id}: ${e.error || e.message}. Check whether a dispatch for it is still in transit.` }, { status: 400 });
    }
  }

  // Create the finished-good lot right at the worker's own site — plain
  // stock from here on, shipped back later via the normal stock-transfer
  // mechanism, not a special ship-back flow.
  const finishedLotId = await nextId(env, "item_lots", "LOT");
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
     VALUES (?, ?, ?, ?, ?, 'work_order_output', ?, ?)`
  ).bind(finishedLotId, order.intended_item_id, order.worker_site_id, quantityDone, quantityDone, params.id, `Completed via Mark Job Done (${params.id})`).run();
  await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, notes, created_by) VALUES (?, ?, 'produced', ?, ?, ?, ?, ?)")
    .bind(finishedLotId, order.intended_item_id, order.worker_site_id, quantityDone, params.id, `Job marked done (${params.id})`, data.user?.name || "system").run();

  await env.DB.prepare("UPDATE work_orders SET stage = 'Work Done', output_item_id = ?, updated_at = datetime('now') WHERE id = ?").bind(order.intended_item_id, params.id).run();
  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Work Done', ?)").bind(params.id, data.user?.name || "unknown").run();

  return Response.json({ ok: true, finished_lot_id: finishedLotId, quantity_done: quantityDone, raw_material_consumed: consumptionLog });
}
