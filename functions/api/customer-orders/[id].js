export async function onRequestGet({ params, env }) {
  const order = await env.DB.prepare(
    `SELECT co.*, i.name AS item_name, i.item_code, i.price AS item_price
     FROM customer_orders co LEFT JOIN items i ON i.id = co.item_id WHERE co.id = ?`
  ).bind(params.id).first();
  if (!order) return Response.json({ error: "not found" }, { status: 404 });

  let currentStock = null;
  let openWorkOrdersForItem = [];
  if (order.item_id) {
    const stockRow = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(order.item_id).first();
    currentStock = stockRow.t;
    const { results } = await env.DB.prepare(
      `SELECT w.*, s.name AS worker_site_name FROM work_orders w LEFT JOIN sites s ON s.id = w.worker_site_id
       WHERE w.intended_item_id = ? AND w.closed_at IS NULL ORDER BY w.created_at DESC`
    ).bind(order.item_id).all();
    openWorkOrdersForItem = results;
  }

  let workOrder = null;
  if (order.linked_work_order_id) {
    workOrder = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(order.linked_work_order_id).first();
    if (workOrder) {
      const { results: stages } = await env.DB.prepare("SELECT * FROM stage_log WHERE work_order_id = ? ORDER BY changed_at ASC").bind(order.linked_work_order_id).all();
      workOrder = { ...workOrder, stages };
    }
  }

  let sale = null;
  if (order.sale_id) sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(order.sale_id).first();

  return Response.json({ ...order, current_stock: currentStock, open_work_orders_for_item: openWorkOrdersForItem, work_order: workOrder, sale });
}

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const existing = await env.DB.prepare("SELECT * FROM customer_orders WHERE id = ?").bind(params.id).first();
  if (!existing) return Response.json({ error: "Customer order not found" }, { status: 404 });

  if (body.status === "cancelled") {
    if (["billed", "shipped"].includes(existing.status)) {
      return Response.json({ error: `Can't cancel — already ${existing.status}` }, { status: 400 });
    }
    await env.DB.prepare("UPDATE customer_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }

  const editable = ["customer_name", "customer_phone", "promised_delivery_date", "notes", "courier", "tracking_id"];
  const changes = {};
  for (const field of editable) if (body[field] !== undefined) changes[field] = body[field];
  if (!Object.keys(changes).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const setClauses = Object.keys(changes).map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE customer_orders SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).bind(...Object.values(changes), params.id).run();
  return Response.json({ ok: true });
}
