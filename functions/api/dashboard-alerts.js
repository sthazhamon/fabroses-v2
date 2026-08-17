export async function onRequestGet({ env }) {
  const { results: unactionedOrders } = await env.DB.prepare(
    `SELECT co.id, co.customer_name, co.reseller_name, co.order_date, co.status
     FROM customer_orders co
     WHERE co.status NOT IN ('billed', 'shipped', 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM customer_order_items coi WHERE coi.customer_order_id = co.id AND coi.linked_work_order_id IS NOT NULL)
     ORDER BY co.created_at ASC`
  ).all();

  const { results: overdueWorkOrders } = await env.DB.prepare(
    `SELECT w.id, w.description, w.due_date, w.stage, w.worker_site_id, s.name AS worker_site_name
     FROM work_orders w LEFT JOIN sites s ON s.id = w.worker_site_id
     WHERE w.due_date IS NOT NULL AND date(w.due_date) < date('now') AND w.closed_at IS NULL AND w.cancelled_at IS NULL
     ORDER BY w.due_date ASC`
  ).all();

  return Response.json({ unactioned_orders: unactionedOrders, overdue_work_orders: overdueWorkOrders });
}
