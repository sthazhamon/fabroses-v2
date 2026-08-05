export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { quantity_received, cost_total, site_id, notes } = body;
  if (!quantity_received) return Response.json({ error: "quantity_received is required" }, { status: 400 });

  const po = await env.DB.prepare("SELECT * FROM purchase_orders WHERE id = ?").bind(params.id).first();
  if (!po) return Response.json({ error: "Purchase order not found" }, { status: 404 });
  if (po.status === "cancelled") return Response.json({ error: "This purchase order was cancelled" }, { status: 400 });

  const totalReceived = po.quantity_received + quantity_received;
  if (totalReceived > po.quantity_ordered) {
    return Response.json({ error: `Only ${po.quantity_ordered - po.quantity_received} still outstanding on this order` }, { status: 400 });
  }

  let storeSiteId = site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to receive into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM item_lots").first();
  const lotId = "LOT-" + String((countRow?.c || 0) + 1).padStart(6, "0");
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, 'purchase_order', ?, ?, ?)`
  ).bind(lotId, po.item_id, storeSiteId, quantity_received, quantity_received, po.id, cost_total || null, notes || null).run();

  await env.DB.prepare(
    "INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, notes) VALUES (?, ?, 'received', ?, ?, ?)"
  ).bind(lotId, po.item_id, storeSiteId, quantity_received, `Received against ${po.id}`).run();

  const newStatus = totalReceived >= po.quantity_ordered ? "received" : "partially_received";
  await env.DB.prepare("UPDATE purchase_orders SET quantity_received = ?, status = ? WHERE id = ?").bind(totalReceived, newStatus, po.id).run();

  return Response.json({ lot_id: lotId, po_status: newStatus });
}
