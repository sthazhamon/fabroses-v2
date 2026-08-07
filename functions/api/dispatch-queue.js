export async function onRequestGet({ env }) {
  const { results: customerShipments } = await env.DB.prepare(
    `SELECT co.* FROM customer_orders co WHERE co.status = 'billed' ORDER BY co.updated_at ASC`
  ).all();
  for (const co of customerShipments) {
    const { results: items } = await env.DB.prepare(
      "SELECT coi.*, i.name AS item_name FROM customer_order_items coi LEFT JOIN items i ON i.id = coi.item_id WHERE coi.customer_order_id = ?"
    ).bind(co.id).all();
    co.items = items;
  }

  const { results: materialToWorkers } = await env.DB.prepare(
    `SELECT w.*, s.name AS worker_site_name, i.name AS intended_item_name
     FROM work_orders w
     LEFT JOIN sites s ON s.id = w.worker_site_id
     LEFT JOIN items i ON i.id = w.intended_item_id
     WHERE w.worker_site_id IS NOT NULL AND w.closed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM material_issues mi WHERE mi.work_order_id = w.id)
     ORDER BY w.priority DESC, w.due_date ASC`
  ).all();

  return Response.json({
    customer_shipments: customerShipments,
    material_to_workers: materialToWorkers,
  });
}
