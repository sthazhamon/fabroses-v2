async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { output_item_id, new_item_name, quantity, to_site_id, labor_cost, notes, courier, tracking_id } = body;

  if (!quantity) return Response.json({ error: "quantity is required" }, { status: 400 });

  const order = await env.DB.prepare("SELECT * FROM work_orders WHERE id = ?").bind(params.id).first();
  if (!order) return Response.json({ error: "Work order not found" }, { status: 404 });
  if (order.closed_at) return Response.json({ error: "This work order is already closed" }, { status: 400 });

  let finalItemId = output_item_id || order.output_item_id || null;
  if (!finalItemId && new_item_name) {
    finalItemId = await nextId(env, "items", "ITM");
    await env.DB.prepare("INSERT INTO items (id, item_type, name, description) VALUES (?, 'finished_good', ?, ?)")
      .bind(finalItemId, new_item_name, notes || `Made from ${params.id}`).run();
  }
  if (!finalItemId) return Response.json({ error: "Provide output_item_id (existing item) or new_item_name" }, { status: 400 });

  let storeSiteId = to_site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to receive into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  // Cost basis: whatever's actually been CONSUMED on this work order's
  // material issues so far (issued minus returned-as-stock minus wasted) —
  // reconciliation happens on the material return endpoint, not here.
  const { results: issues } = await env.DB.prepare("SELECT * FROM material_issues WHERE work_order_id = ?").bind(params.id).all();
  let rawCostForThisReceipt = 0;
  for (const issue of issues) {
    const consumed = issue.quantity_issued - issue.quantity_returned_stock - issue.quantity_wasted;
    if (consumed <= 0) continue;
    const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(issue.lot_id).first();
    const costPerUnit = lot && lot.cost_total && lot.quantity_original ? lot.cost_total / lot.quantity_original : 0;
    rawCostForThisReceipt += costPerUnit * consumed;
  }

  const newLotId = await nextId(env, "item_lots", "LOT");
  const lotCost = rawCostForThisReceipt + (labor_cost || 0);
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, 'work_order_output', ?, ?, ?)`
  ).bind(newLotId, finalItemId, storeSiteId, quantity, quantity, params.id, lotCost || null, notes || null).run();

  await env.DB.prepare(
    `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, work_order_id, notes, created_by)
     VALUES (?, ?, 'returned', ?, ?, ?, ?, ?)`
  ).bind(newLotId, finalItemId, storeSiteId, quantity, params.id, `Received from ${order.worker_site_id || "worker"}`, data.user?.name || "system").run();

  let returnDispatchId = null;
  if (courier || tracking_id) {
    returnDispatchId = await nextId(env, "dispatches", "DSP");
    await env.DB.prepare(
      `INSERT INTO dispatches (id, dispatch_type, from_site_id, to_site_id, related_work_order_id, status, courier, tracking_id, shipped_at)
       VALUES (?, 'return_shipment', ?, ?, ?, 'shipped', ?, ?, datetime('now'))`
    ).bind(returnDispatchId, order.worker_site_id, storeSiteId, params.id, courier || null, tracking_id || null).run();
  }

  const newReceivedTotal = order.received_quantity_total + quantity;
  const isNowComplete = newReceivedTotal >= order.target_quantity;

  await env.DB.prepare(
    `UPDATE work_orders SET received_quantity_total = ?, output_item_id = ?, labor_cost = COALESCE(labor_cost, 0) + ?, closed_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(newReceivedTotal, finalItemId, labor_cost || 0, isNowComplete ? new Date().toISOString() : null, params.id).run();

  if (isNowComplete) {
    await env.DB.prepare(
      "UPDATE customer_orders SET status = 'ready_to_bill', updated_at = datetime('now') WHERE linked_work_order_id = ? AND status = 'awaiting_material'"
    ).bind(params.id).run();
  }

  return Response.json({ ok: true, lot_id: newLotId, item_id: finalItemId, received_quantity_total: newReceivedTotal, work_order_closed: isNowComplete, return_dispatch_id: returnDispatchId });
}
