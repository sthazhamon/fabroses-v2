import { nextId } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT w.*, s.name AS worker_site_name, i.name AS intended_item_name
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items i ON i.id = w.intended_item_id
     ORDER BY w.created_at DESC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const {
    description, work_instructions, worker_site_id, intended_item_id,
    target_quantity, due_date, priority, order_date, related_customer_order_id,
  } = body;

  if (!description) return Response.json({ error: "description is required" }, { status: 400 });
  if (!worker_site_id) return Response.json({ error: "A worker must be assigned to create a work order — production can't start without knowing who's doing it" }, { status: 400 });

  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(worker_site_id).first();
  if (!site) return Response.json({ error: "That worker site doesn't exist" }, { status: 404 });
  if (site.site_type !== "worker") return Response.json({ error: "That site isn't a worker site" }, { status: 400 });

  const id = await nextId(env, "work_orders", "WO");
  await env.DB.prepare(
    `INSERT INTO work_orders
     (id, description, work_instructions, worker_site_id, intended_item_id, target_quantity, due_date, priority, order_date, related_customer_order_id, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Order Placed')`
  ).bind(
    id, description, work_instructions || null, worker_site_id, intended_item_id || null,
    target_quantity || 1, due_date || null, priority || "normal",
    order_date || new Date().toISOString().slice(0, 10), related_customer_order_id || null
  ).run();

  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Order Placed', 'system')").bind(id).run();

  // The deliberate link back to the order this production run is for —
  // traceability only, this never reserves stock or auto-attaches later.
  if (related_customer_order_id) {
    await env.DB.prepare(
      "UPDATE customer_orders SET linked_work_order_id = ?, status = 'awaiting_material', updated_at = datetime('now') WHERE id = ?"
    ).bind(id, related_customer_order_id).run();
  }

  return Response.json({ id });
}
