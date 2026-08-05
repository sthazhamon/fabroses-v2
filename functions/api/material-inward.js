export async function onRequestGet({ env }) {
  const { results: fromWorkers } = await env.DB.prepare(
    `SELECT mi.id, mi.work_order_id, mi.quantity_issued, mi.issued_at, s.name AS worker_site_name,
            w.description AS work_order_description, w.target_quantity, w.received_quantity_total
     FROM material_issues mi
     LEFT JOIN sites s ON s.id = mi.worker_site_id
     LEFT JOIN work_orders w ON w.id = mi.work_order_id
     WHERE mi.status = 'with_worker'
     ORDER BY mi.issued_at ASC`
  ).all();

  const { results: fromPurchaseOrders } = await env.DB.prepare(
    `SELECT po.id, po.supplier_name, po.item_id, i.name AS item_name, po.quantity_ordered, po.quantity_received, po.expected_date
     FROM purchase_orders po LEFT JOIN items i ON i.id = po.item_id
     WHERE po.status IN ('ordered', 'partially_received')
     ORDER BY po.expected_date ASC`
  ).all();

  return Response.json({
    pending_from_workers: fromWorkers.map((r) => ({ ...r, source: "work_order" })),
    pending_from_purchase_orders: fromPurchaseOrders.map((r) => ({ ...r, source: "purchase_order" })),
  });
}
