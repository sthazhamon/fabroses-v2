export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const itemId = url.searchParams.get("item_id");
  if (!itemId) return Response.json({ error: "item_id is required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });

  const { results: lots } = await env.DB.prepare(
    `SELECT l.*, s.name AS site_name, s.site_type
     FROM item_lots l LEFT JOIN sites s ON s.id = l.site_id
     WHERE l.item_id = ? AND l.quantity_balance > 0 AND (l.site_id = ? OR s.site_type = 'store')
     ORDER BY (s.site_type = 'store') ASC, l.created_at ASC`
  ).bind(itemId, order.worker_site_id).all();
  for (const l of lots) l.resolved_origin = l.origin_lot_id || l.id;

  return Response.json({ lots });
}
