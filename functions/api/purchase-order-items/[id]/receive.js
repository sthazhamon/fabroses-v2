async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  const { quantity_received, cost_total, site_id, notes } = body;
  if (!quantity_received) return Response.json({ error: "quantity_received is required" }, { status: 400 });

  const line = await env.DB.prepare("SELECT * FROM purchase_order_items WHERE id = ?").bind(params.id).first();
  if (!line) return Response.json({ error: "Purchase order line not found" }, { status: 404 });

  const totalReceived = line.quantity_received + quantity_received;
  if (totalReceived > line.quantity_ordered) {
    return Response.json({ error: `Only ${line.quantity_ordered - line.quantity_received} still outstanding on this line` }, { status: 400 });
  }

  let storeSiteId = site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to receive into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  const lotId = await nextId(env, "item_lots", "LOT");
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, 'purchase_order', ?, ?, ?)`
  ).bind(lotId, line.item_id, storeSiteId, quantity_received, quantity_received, line.purchase_order_id, cost_total || null, notes || null).run();

  await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, notes) VALUES (?, ?, 'received', ?, ?, ?)")
    .bind(lotId, line.item_id, storeSiteId, quantity_received, `Received against PO line ${params.id}`).run();

  const newStatus = totalReceived >= line.quantity_ordered ? "received" : "partially_received";
  await env.DB.prepare("UPDATE purchase_order_items SET quantity_received = ?, status = ? WHERE id = ?").bind(totalReceived, newStatus, params.id).run();

  return Response.json({ lot_id: lotId, line_status: newStatus });
}
