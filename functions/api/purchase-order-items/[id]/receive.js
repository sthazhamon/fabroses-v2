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

  // The check and the write happen in ONE atomic statement, not a separate
  // read-then-decide-then-write sequence. A read-then-write here is a real
  // race: two nearly-simultaneous requests (e.g. a slow first request that
  // outlasts the frontend's own double-click cooldown) could both read the
  // same not-yet-updated quantity_received, both see room to receive, and
  // both succeed - silently double-receiving the same line despite the
  // earlier validation looking correct in isolation. Building the
  // condition into the WHERE clause makes SQL itself the single point of
  // truth: only one of two overlapping requests can actually change the row.
  const provisionalTotal = line.quantity_received + quantity_received;
  const provisionalStatus = provisionalTotal >= line.quantity_ordered ? "received" : "partially_received";
  const updateResult = await env.DB.prepare(
    "UPDATE purchase_order_items SET quantity_received = quantity_received + ?, status = ? WHERE id = ? AND quantity_received + ? <= quantity_ordered"
  ).bind(quantity_received, provisionalStatus, params.id, quantity_received).run();

  if (!updateResult.meta.changes) {
    const current = await env.DB.prepare("SELECT quantity_received, quantity_ordered FROM purchase_order_items WHERE id = ?").bind(params.id).first();
    return Response.json({ error: `Only ${current.quantity_ordered - current.quantity_received} still outstanding on this line` }, { status: 400 });
  }

  let storeSiteId = site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to receive into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  const lotId = await nextId(env, "item_lots", "LOT");
  // Every lot needs a real cost basis from the moment it exists, or COGS
  // silently computes to zero for anything made from it. Default to the
  // PO's own agreed rate - known at receipt time, well before any supplier
  // bill might arrive - and let an explicitly-passed cost_total override it
  // if the caller has something more specific.
  const effectiveCostTotal = cost_total != null ? cost_total : (line.rate != null ? line.rate * quantity_received : null);
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, 'purchase_order', ?, ?, ?)`
  ).bind(lotId, line.item_id, storeSiteId, quantity_received, quantity_received, line.purchase_order_id, effectiveCostTotal, notes || null).run();

  await env.DB.prepare("INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, notes) VALUES (?, ?, 'received', ?, ?, ?)")
    .bind(lotId, line.item_id, storeSiteId, quantity_received, `Received against PO line ${params.id}`).run();

  return Response.json({ lot_id: lotId, line_status: provisionalStatus });
}
