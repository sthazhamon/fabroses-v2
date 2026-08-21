import { createDispatch } from "./_dispatch.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { from_site_id, to_site_id, lot_id, quantity } = body;
  if (!from_site_id || !to_site_id || !lot_id || !quantity) {
    return Response.json({ error: "from_site_id, to_site_id, lot_id, and quantity are all required" }, { status: 400 });
  }
  if (from_site_id === to_site_id) return Response.json({ error: "From and To sites can't be the same" }, { status: 400 });

  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(lot_id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });
  if (lot.site_id !== from_site_id) return Response.json({ error: "That lot isn't currently at the selected From site" }, { status: 400 });
  if (quantity > lot.quantity_balance) return Response.json({ error: "Only " + lot.quantity_balance + " available in that lot" }, { status: 400 });

  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id, to_site_id,
    items: [{ item_id: lot.item_id, lot_id: lot.id, expected_quantity: quantity }],
  });

  return Response.json({ dispatch_id: dispatchId });
}
