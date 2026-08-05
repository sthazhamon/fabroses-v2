export async function onRequestGet({ env, data }) {
  const siteId = data.user?.siteId;
  if (!siteId) {
    return Response.json({ error: "This login isn't linked to a worker site. An admin can fix this in Users." }, { status: 400 });
  }

  const { results: orders } = await env.DB.prepare(
    `SELECT w.*, i.name AS intended_item_name FROM work_orders w
     LEFT JOIN items i ON i.id = w.intended_item_id
     WHERE w.worker_site_id = ? AND w.closed_at IS NULL
     ORDER BY w.priority DESC, w.due_date ASC`
  ).bind(siteId).all();

  const { results: ownStock } = await env.DB.prepare(
    `SELECT l.*, i.name AS item_name, i.item_code FROM item_lots l
     LEFT JOIN items i ON i.id = l.item_id
     WHERE l.site_id = ? AND l.quantity_balance > 0
     ORDER BY l.created_at ASC`
  ).bind(siteId).all();

  return Response.json({ site_id: siteId, pending_orders: orders, own_stock: ownStock });
}
