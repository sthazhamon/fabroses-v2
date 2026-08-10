import { createDispatch } from "../../_dispatch.js";

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { to_site_id } = body;

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.job_type !== "rework") return Response.json({ error: "This isn't a rework job" }, { status: 400 });
  if (!order.rework_lot_id) return Response.json({ error: "No rework lot recorded on this work order" }, { status: 400 });

  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(order.rework_lot_id).first();
  if (!lot) return Response.json({ error: "The rework lot no longer exists" }, { status: 404 });
  if (lot.quantity_balance <= 0) return Response.json({ error: "That lot has no quantity left to send" }, { status: 400 });

  const existingOpen = await env.DB.prepare("SELECT id FROM rework_issues WHERE work_order_id = ? AND status != 'received'").bind(params.id).first();
  if (existingOpen) return Response.json({ error: "This work order already has an open rework issue — return it before sending again" }, { status: 400 });

  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id: lot.site_id, to_site_id: to_site_id || order.worker_site_id,
    items: [{ item_id: lot.item_id, lot_id: lot.id, expected_quantity: lot.quantity_balance }], related_work_order_id: params.id,
  });

  return Response.json({ dispatch_id: dispatchId });
}
