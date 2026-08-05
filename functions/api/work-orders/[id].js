import { logEdits } from "../_editlog.js";

export async function onRequestGet({ params, env }) {
  const order = await env.DB.prepare(
    `SELECT w.*, s.name AS worker_site_name, ii.name AS intended_item_name, io.name AS output_item_name
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items ii ON ii.id = w.intended_item_id
     LEFT JOIN items io ON io.id = w.output_item_id
     WHERE w.id = ?`
  ).bind(params.id).first();
  if (!order) return Response.json({ error: "not found" }, { status: 404 });

  const { results: stages } = await env.DB.prepare("SELECT * FROM stage_log WHERE work_order_id = ? ORDER BY changed_at ASC").bind(params.id).all();
  const { results: issues } = await env.DB.prepare(
    `SELECT mi.*, l.item_id, i.name AS item_name FROM material_issues mi
     LEFT JOIN item_lots l ON l.id = mi.lot_id LEFT JOIN items i ON i.id = l.item_id
     WHERE mi.work_order_id = ? ORDER BY mi.issued_at ASC`
  ).bind(params.id).all();
  const { results: movements } = await env.DB.prepare("SELECT * FROM item_movements WHERE work_order_id = ? ORDER BY created_at ASC").bind(params.id).all();
  const { results: photos } = await env.DB.prepare("SELECT * FROM photos WHERE entity_type = 'work_order' AND entity_id = ? ORDER BY uploaded_at DESC").bind(params.id).all();

  return Response.json({ ...order, stages, issues, movements, photos });
}

export async function onRequestPatch({ request, env, params, data }) {
  const body = await request.json();
  const existing = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!existing) return Response.json({ error: "Work order not found" }, { status: 404 });

  if (body.worker_site_id !== undefined) {
    if (body.worker_site_id === null) {
      return Response.json({ error: "A work order must always have a worker assigned — reassign to someone else instead of clearing it" }, { status: 400 });
    }
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(body.worker_site_id).first();
    if (!site) return Response.json({ error: "That site doesn't exist" }, { status: 404 });
    if (site.site_type !== "worker") return Response.json({ error: "That site isn't a worker site" }, { status: 400 });
  }

  const editable = ["description", "work_instructions", "due_date", "priority", "target_quantity", "worker_site_id"];
  const changes = {};
  for (const field of editable) if (body[field] !== undefined) changes[field] = body[field];
  if (!Object.keys(changes).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  await logEdits(env, "work_order", params.id, existing, changes, data.user?.name);
  const setClauses = Object.keys(changes).map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE work_orders SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).bind(...Object.values(changes), params.id).run();

  return Response.json({ ok: true });
}
