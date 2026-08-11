export async function onRequestPost({ env, params }) {
  const line = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(params.id).first();
  if (!line) return Response.json({ error: "Purchase order line not found" }, { status: 404 });
  if (line.quantity_received >= line.quantity_ordered) {
    return Response.json({ error: "This line is already fully received — nothing to short-close" }, { status: 400 });
  }
  await env.DB.prepare("UPDATE purchase_order_items SET status = 'short_closed' WHERE id = ?").bind(params.id).run();
  return Response.json({ ok: true });
}
