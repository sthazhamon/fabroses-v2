import { logEdits } from "../_editlog.js";

export async function onRequestGet({ params, env }) {
  const order = await env.DB.prepare(
    `SELECT w.*, s.name AS worker_site_name, ii.name AS intended_item_name, ii.item_code AS intended_item_code, io.name AS output_item_name,
            (SELECT ip.r2_key FROM item_photos ip WHERE ip.item_id = w.intended_item_id ORDER BY ip.uploaded_at ASC LIMIT 1) AS intended_item_photo_key
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items ii ON ii.id = w.intended_item_id
     LEFT JOIN items io ON io.id = w.output_item_id
     WHERE w.id = ?`
  ).bind(params.id).first();
  if (!order) return Response.json({ error: "not found" }, { status: 404 });

  const { results: stages } = await env.DB.prepare("SELECT * FROM stage_log WHERE work_order_id = ? ORDER BY changed_at ASC").bind(params.id).all();
  const { results: issues } = await env.DB.prepare(
    `SELECT mi.*, l.item_id, l.origin_lot_id, i.name AS item_name,
            (SELECT ip.r2_key FROM item_photos ip WHERE ip.item_id = l.item_id ORDER BY ip.uploaded_at ASC LIMIT 1) AS item_photo_key
     FROM material_issues mi
     LEFT JOIN item_lots l ON l.id = mi.lot_id LEFT JOIN items i ON i.id = l.item_id
     WHERE mi.work_order_id = ? ORDER BY mi.issued_at ASC`
  ).bind(params.id).all();
  for (const issue of issues) issue.resolved_origin = issue.origin_lot_id || issue.lot_id;
  const { results: reworkIssues } = await env.DB.prepare(
    `SELECT ri.*, l.item_id, i.name AS item_name FROM rework_issues ri
     LEFT JOIN item_lots l ON l.id = ri.lot_id LEFT JOIN items i ON i.id = l.item_id
     WHERE ri.work_order_id = ? ORDER BY ri.issued_at ASC`
  ).bind(params.id).all();
  const { results: movements } = await env.DB.prepare("SELECT * FROM item_movements WHERE work_order_id = ? ORDER BY created_at ASC").bind(params.id).all();
  const { results: photos } = await env.DB.prepare("SELECT * FROM photos WHERE entity_type = 'work_order' AND entity_id = ? ORDER BY uploaded_at DESC").bind(params.id).all();

  // Material status, separate from the WO's own work-progress stage - a job
  // can genuinely have material already assigned, in transit, or received,
  // while the work itself hasn't started yet. Without surfacing this
  // separately, that state was invisible and looked like nothing had
  // happened at all.
  const { results: linkedDispatches } = await env.DB.prepare(
    "SELECT * FROM dispatches WHERE related_work_order_id = ? ORDER BY created_at DESC"
  ).bind(params.id).all();

  let materialStatus = "not_assigned";
  if (issues.some((i) => i.verified_at)) materialStatus = "verified";
  else if (issues.length) materialStatus = "at_worker_unverified";
  else if (linkedDispatches.some((d) => d.status === "received")) materialStatus = "at_worker_unverified";
  else if (linkedDispatches.some((d) => d.status === "shipped")) materialStatus = "in_transit";
  else if (linkedDispatches.some((d) => d.status === "pending_pick")) materialStatus = "assigned";

  return Response.json({ ...order, stages, issues, rework_issues: reworkIssues, movements, photos, material_status: materialStatus, linked_dispatches: linkedDispatches });
}

export async function onRequestPatch({ request, env, params, data }) {
  const body = await request.json();
  const existing = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!existing) return Response.json({ error: "Work order not found" }, { status: 404 });

  if (body.worker_site_id !== undefined) {
    return Response.json({ error: "Reassigning a work order isn't supported — cancel it and create a fresh one for the new worker instead, so material custody always stays correctly tracked." }, { status: 400 });
  }

  const editable = ["description", "work_instructions", "due_date", "priority", "target_quantity"];
  const changes = {};
  for (const field of editable) if (body[field] !== undefined) changes[field] = body[field];
  if (!Object.keys(changes).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  await logEdits(env, "work_order", params.id, existing, changes, data.user?.name);
  const setClauses = Object.keys(changes).map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE work_orders SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).bind(...Object.values(changes), params.id).run();

  return Response.json({ ok: true });
}
