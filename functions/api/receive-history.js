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

  const { results: allPOs } = await env.DB.prepare("SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 100").all();
  const fromPurchaseOrders = [];
  if (allPOs.length) {
    const poIds = allPOs.map((po) => po.id);
    const placeholders = poIds.map(() => "?").join(",");
    const { results: allLines } = await env.DB.prepare(
      `SELECT poi.*, i.name AS item_name FROM purchase_order_items poi LEFT JOIN items i ON i.id = poi.item_id WHERE poi.purchase_order_id IN (${placeholders})`
    ).bind(...poIds).all();
    const linesByPo = {};
    for (const line of allLines) {
      if (!linesByPo[line.purchase_order_id]) linesByPo[line.purchase_order_id] = [];
      linesByPo[line.purchase_order_id].push(line);
    }
    for (const po of allPOs) {
      const lines = linesByPo[po.id] || [];
      if (lines.length && lines.every((l) => l.quantity_received >= l.quantity_ordered)) {
        fromPurchaseOrders.push({ ...po, item_name: lines.map((l) => l.item_name).join(", ") });
      }
    }
  }

  return Response.json({
    received_from_workers: fromWorkers,
    received_from_purchase_orders: fromPurchaseOrders,
  });
}
