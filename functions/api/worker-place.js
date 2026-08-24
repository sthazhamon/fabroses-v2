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

  const { results: completedOrders } = await env.DB.prepare(
    `SELECT w.*, i.name AS intended_item_name FROM work_orders w
     LEFT JOIN items i ON i.id = w.intended_item_id
     WHERE w.worker_site_id = ? AND w.closed_at IS NOT NULL
     ORDER BY w.closed_at DESC LIMIT 10`
  ).bind(siteId).all();

  const { results: ownStock } = await env.DB.prepare(
    `SELECT l.*, i.name AS item_name, i.item_code FROM item_lots l
     LEFT JOIN items i ON i.id = l.item_id
     WHERE l.site_id = ? AND l.quantity_balance > 0
     ORDER BY l.created_at ASC`
  ).bind(siteId).all();

  // Material shipped TO this worker, sitting in transit, waiting for them to confirm it arrived.
  const { results: incoming } = await env.DB.prepare(
    "SELECT * FROM dispatches WHERE to_site_id = ? AND status = 'shipped' ORDER BY shipped_at ASC"
  ).bind(siteId).all();

  // This worker's own outbound activity — finished goods they still need to pick/ship back.
  const { results: outgoing } = await env.DB.prepare(
    "SELECT * FROM dispatches WHERE from_site_id = ? AND status IN ('pending_pick', 'picked') ORDER BY created_at ASC"
  ).bind(siteId).all();

  // The worker's own recently completed shipments, so they can review or add tracking later.
  const { results: recentShipments } = await env.DB.prepare(
    `SELECT d.*, ts.name AS to_site_name FROM dispatches d LEFT JOIN sites ts ON ts.id = d.to_site_id
     WHERE d.from_site_id = ? AND d.status IN ('shipped', 'received') ORDER BY d.shipped_at DESC LIMIT 10`
  ).bind(siteId).all();
  for (const dispatch of recentShipments) {
    const { results: items } = await env.DB.prepare(
      "SELECT di.*, i.name AS item_name FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id WHERE di.dispatch_id = ?"
    ).bind(dispatch.id).all();
    dispatch.item_summary = items.map((i) => `${i.item_name || "?"} (${i.scanned_quantity ?? i.expected_quantity})`).join(", ");
  }

  return Response.json({ site_id: siteId, pending_orders: orders, completed_orders: completedOrders, own_stock: ownStock, incoming_to_confirm: incoming, outgoing_to_ship: outgoing, recent_shipments: recentShipments });
}
