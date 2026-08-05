import { createDispatch } from "../../_dispatch.js";

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { lot_id, quantity } = body;
  if (!lot_id || !quantity) return Response.json({ error: "lot_id and quantity are required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });

  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot_id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });
  if (lot.quantity_balance < quantity) return Response.json({ error: `Only ${lot.quantity_balance} available in that lot` }, { status: 400 });

  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id: lot.site_id, to_site_id: order.worker_site_id,
    items: [{ item_id: lot.item_id, lot_id, expected_quantity: quantity }], related_work_order_id: params.id,
  });

  return Response.json({ dispatch_id: dispatchId });
}
