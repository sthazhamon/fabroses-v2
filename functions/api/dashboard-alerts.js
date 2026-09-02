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

  // Every still-open work order, not just the ones already overdue - so
  // the current workload is visible, not just what's already late.
  const { results: pendingWorkOrders } = await env.DB.prepare(
    `SELECT w.id, w.description, w.stage, w.due_date, w.worker_site_id, s.name AS worker_site_name
     FROM work_orders w LEFT JOIN sites s ON s.id = w.worker_site_id
     WHERE w.closed_at IS NULL AND w.cancelled_at IS NULL
     ORDER BY w.created_at ASC`
  ).all();

  // Finished goods currently sitting in stock, unsold - a visibility
  // signal on what's ready to sell but hasn't moved yet.
  const { results: unsoldStock } = await env.DB.prepare(
    `SELECT i.id AS item_id, i.name, i.item_code, SUM(l.quantity_balance) AS total_stock
     FROM item_lots l JOIN items i ON i.id = l.item_id
     WHERE i.item_type = 'finished_good' AND l.quantity_balance > 0
     GROUP BY i.id
     HAVING total_stock > 0
     ORDER BY total_stock DESC`
  ).all();

  // Finished items with no BOM at all - these silently block work order
  // creation entirely (nothing to suggest issuing), so surfacing them
  // early avoids someone discovering this only when a job is already
  // supposed to start.
  const { results: missingBom } = await env.DB.prepare(
    `SELECT i.id AS item_id, i.name, i.item_code
     FROM items i
     WHERE i.item_type = 'finished_good' AND NOT EXISTS (SELECT 1 FROM item_bom b WHERE b.finished_item_id = i.id)
     ORDER BY i.name ASC`
  ).all();

  return Response.json({
    unactioned_orders: unactionedOrders, overdue_work_orders: overdueWorkOrders,
    pending_work_orders: pendingWorkOrders, unsold_stock: unsoldStock, items_missing_bom: missingBom,
  });
}
