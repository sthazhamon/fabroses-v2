export async function onRequestGet({ env }) {
  const { results: fromWorkers } = await env.DB.prepare(
    `SELECT mi.*, w.description AS work_order_description, s.name AS worker_site_name
     FROM material_issues mi
     LEFT JOIN work_orders w ON w.id = mi.work_order_id
     LEFT JOIN sites s ON s.id = mi.worker_site_id
     WHERE mi.status = 'received'
     ORDER BY mi.received_at DESC
     LIMIT 100`
  ).all();

  const { results: fromPurchaseOrders } = await env.DB.prepare(
    `SELECT po.*, i.name AS item_name FROM purchase_orders po
     LEFT JOIN items i ON i.id = po.item_id
     WHERE po.status = 'received'
     ORDER BY po.created_at DESC
     LIMIT 100`
  ).all();

  return Response.json({
    received_from_workers: fromWorkers,
    received_from_purchase_orders: fromPurchaseOrders,
  });
}
