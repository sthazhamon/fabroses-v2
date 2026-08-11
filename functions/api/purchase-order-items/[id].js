export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const line = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(params.id).first();
  if (!line) return Response.json({ error: "Purchase order line not found" }, { status: 404 });

  if (line.quantity_received > 0) {
    return Response.json({ error: "Can't edit — this line has already had material received against it. Editing now could create a mismatch with what's already on record." }, { status: 400 });
  }
  const billedRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM supplier_bill_items WHERE purchase_order_item_id = ?").bind(params.id).first();
  if (billedRow.c > 0) {
    return Response.json({ error: "Can't edit — this line has already been billed. Editing now could create a mismatch with the bill already on record." }, { status: 400 });
  }

  const updates = [];
  const values = [];
  if (body.quantity_ordered != null) { updates.push("quantity_ordered = ?"); values.push(body.quantity_ordered); }
  if (body.rate != null) { updates.push("rate = ?"); values.push(body.rate); }
  if (!updates.length) return Response.json({ error: "Nothing to update — provide quantity_ordered and/or rate" }, { status: 400 });

  values.push(params.id);
  await env.DB.prepare(`UPDATE purchase_order_items SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return Response.json({ ok: true });
}
