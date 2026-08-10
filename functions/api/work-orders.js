import { nextId } from "./_ledger.js";
import { fulfillBomLines } from "./_bom.js";

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

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const {
    description, work_instructions, worker_site_id, intended_item_id, job_type, rework_lot_id,
    target_quantity, due_date, priority, order_date, related_customer_order_id, related_customer_order_item_id,
    material_lines,
  } = body;

  if (!description) return Response.json({ error: "description is required" }, { status: 400 });
  if (!worker_site_id) return Response.json({ error: "A worker must be assigned to create a work order — production can't start without knowing who's doing it" }, { status: 400 });
  if (!intended_item_id) return Response.json({ error: "The finished item this job produces is required — this is what drives the material it needs" }, { status: 400 });

  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(worker_site_id).first();
  if (!site) return Response.json({ error: "That worker site doesn't exist" }, { status: 404 });
  if (site.site_type !== "worker") return Response.json({ error: "That site isn't a worker site" }, { status: 400 });

  const intendedItem = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(intended_item_id).first();
  if (!intendedItem) return Response.json({ error: "That intended item doesn't exist" }, { status: 404 });

  const effectiveJobType = job_type === "rework" ? "rework" : "production";
  if (effectiveJobType === "rework" && !rework_lot_id) {
    return Response.json({ error: "Rework jobs need the specific lot being reworked" }, { status: 400 });
  }
  if (effectiveJobType === "rework") {
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(rework_lot_id).first();
    if (!lot) return Response.json({ error: "That rework lot doesn't exist" }, { status: 404 });
  }

  const id = await nextId(env, "work_orders", "WO");
  await env.DB.prepare(
    `INSERT INTO work_orders
     (id, description, work_instructions, worker_site_id, job_type, intended_item_id, rework_lot_id, target_quantity, due_date, priority, order_date, related_customer_order_id, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Order Placed')`
  ).bind(
    id, description, work_instructions || null, worker_site_id, effectiveJobType, intended_item_id, rework_lot_id || null,
    target_quantity || 1, due_date || null, priority || "normal",
    order_date || new Date().toISOString().slice(0, 10), related_customer_order_id || null
  ).run();

  await env.DB.prepare("INSERT INTO stage_log (work_order_id, stage, changed_by) VALUES (?, 'Order Placed', 'system')").bind(id).run();

  // The deliberate link back to the SPECIFIC LINE this production run is
  // for — a multi-line order can have several lines, each independently
  // needing (or not needing) its own work order. Traceability only, never
  // reserves stock or auto-attaches later.
  if (related_customer_order_item_id) {
    await env.DB.prepare("UPDATE customer_order_items SET linked_work_order_id = ? WHERE id = ?").bind(id, related_customer_order_item_id).run();

    if (related_customer_order_id) {
      const { results: allLines } = await env.DB.prepare("SELECT linked_work_order_id FROM customer_order_items WHERE customer_order_id = ?").bind(related_customer_order_id).all();
      const linkedCount = allLines.filter((l) => l.linked_work_order_id).length;
      const order = await env.DB.prepare("SELECT status FROM customer_orders WHERE id = ?").bind(related_customer_order_id).first();
      const terminal = ["billed", "shipped", "cancelled"].includes(order?.status);
      if (!terminal) {
        const newStatus = linkedCount === allLines.length ? "awaiting_material" : "partially_fulfilled";
        await env.DB.prepare("UPDATE customer_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(newStatus, related_customer_order_id).run();
      }
    }
  }

  // BOM auto-fulfillment: worker's own stock first, then the store,
  // otherwise the need surfaces through the existing dispatch queue.
  // material_lines lets the creator override the BOM-suggested quantities
  // before this runs; if omitted, the BOM's own suggested quantities are used.
  let bomResults = [];
  if (effectiveJobType === "production") {
    let lines = material_lines;
    if (!lines) {
      const { results: bom } = await env.DB.prepare("SELECT * FROM item_bom WHERE finished_item_id = ?").bind(intended_item_id).all();
      lines = bom.map((b) => ({ raw_material_item_id: b.raw_material_item_id, quantity: b.quantity_required * (target_quantity || 1) }));
    }
    if (lines.length) bomResults = await fulfillBomLines(env, { workOrderId: id, workerSiteId: worker_site_id, lines, actorName: data.user?.name });
  }

  return Response.json({ id, bom_results: bomResults });
}
