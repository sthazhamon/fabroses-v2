import { logEdits } from "../_editlog.js";

export async function onRequestPatch({ request, env, params, data }) {
  const body = await request.json();
  const { quantity_balance, notes } = body;
  if (quantity_balance == null) return Response.json({ error: "quantity_balance is required" }, { status: 400 });
  if (quantity_balance < 0) return Response.json({ error: "Quantity can't go negative" }, { status: 400 });

  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(params.id).first();
  if (!lot) return Response.json({ error: "Lot not found" }, { status: 404 });

  await logEdits(env, "item_lot", params.id, lot, { quantity_balance, notes: notes !== undefined ? notes : lot.notes }, data.user?.name);

  await env.DB.prepare("UPDATE item_lots SET quantity_balance = ?, notes = ? WHERE id = ?")
    .bind(quantity_balance, notes !== undefined ? notes : lot.notes, params.id).run();

  await env.DB.prepare(
    "INSERT INTO item_movements (lot_id, item_id, event_type, quantity, notes, created_by) VALUES (?, ?, 'adjusted', ?, ?, ?)"
  ).bind(params.id, lot.item_id, quantity_balance - lot.quantity_balance, notes || `Manual correction: ${lot.quantity_balance} -> ${quantity_balance}`, data.user?.name || "unknown").run();

  return Response.json({ ok: true, old_quantity: lot.quantity_balance, new_quantity: quantity_balance });
}
