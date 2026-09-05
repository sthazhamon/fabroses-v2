export async function onRequestGet({ env }) {
  const { results: unactionedOrders } = await env.DB.prepare(
    `SELECT co.id, co.customer_name, co.reseller_name, co.order_date, co.status
     FROM customer_orders co
     WHERE co.status NOT IN ('billed', 'shipped', 'delivered', 'cancelled')
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
    `SELECT w.id, w.description, w.stage, w.due_date, w.worker_site_id, s.name AS worker_site_name,
            i.name AS intended_item_name, i.item_code AS intended_item_code,
            co.customer_name, co.reseller_name
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items i ON i.id = w.intended_item_id
     LEFT JOIN customer_orders co ON co.id = w.related_customer_order_id
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

  // Material that's left one site but hasn't been confirmed received at the
  // other yet — the gap between "shipped" and "receive confirmed" that was
  // previously invisible anywhere except by opening the Dispatch/Receive
  // tabs and checking each one individually.
  const { results: materialInTransit } = await env.DB.prepare(
    `SELECT d.id, d.dispatch_type, d.shipped_at, fs.name AS from_site_name, ts.name AS to_site_name
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     WHERE d.status = 'shipped' AND d.dispatch_type != 'customer_shipment'
     ORDER BY d.shipped_at ASC`
  ).all();
  if (materialInTransit.length) {
    const ids = materialInTransit.map((d) => d.id);
    const placeholders = ids.map(() => "?").join(",");
    const { results: allItems } = await env.DB.prepare(
      `SELECT di.dispatch_id, di.scanned_quantity, di.expected_quantity, i.name AS item_name
       FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id WHERE di.dispatch_id IN (${placeholders})`
    ).bind(...ids).all();
    const byDispatch = {};
    for (const row of allItems) (byDispatch[row.dispatch_id] ||= []).push(row);
    for (const d of materialInTransit) {
      d.item_summary = (byDispatch[d.id] || []).map((i) => `${i.item_name || "?"} (${i.scanned_quantity ?? i.expected_quantity})`).join(", ");
    }
  }

  // Customer shipments already sent, but nobody has yet confirmed the
  // customer actually has them — the order shouldn't be treated as fully
  // closed until this happens.
  const { results: awaitingDeliveryConfirmation } = await env.DB.prepare(
    `SELECT d.id, d.shipped_at, d.related_customer_order_id, d.related_sale_id, co.customer_name, co.reseller_name
     FROM dispatches d LEFT JOIN customer_orders co ON co.id = d.related_customer_order_id
     WHERE d.status = 'shipped' AND d.dispatch_type = 'customer_shipment' AND d.delivery_confirmed_at IS NULL
     ORDER BY d.shipped_at ASC`
  ).all();

  return Response.json({
    unactioned_orders: unactionedOrders, overdue_work_orders: overdueWorkOrders,
    pending_work_orders: pendingWorkOrders, unsold_stock: unsoldStock, items_missing_bom: missingBom,
    material_in_transit: materialInTransit, awaiting_delivery_confirmation: awaitingDeliveryConfirmation,
  });
}
