async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const saleId = url.searchParams.get("sale_id");
  let q = "SELECT sr.*, si.description, si.sale_id FROM sale_returns sr LEFT JOIN sale_items si ON si.id = sr.sale_item_id";
  const params = [];
  if (saleId) { q += " WHERE si.sale_id = ?"; params.push(saleId); }
  q += " ORDER BY sr.created_at DESC";
  const { results } = await env.DB.prepare(q).bind(...params).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { sale_item_id, quantity, destination_site_id, notes } = body;
  if (!sale_item_id || !quantity) return Response.json({ error: "sale_item_id and quantity are required" }, { status: 400 });

  const line = await env.DB.prepare("SELECT * FROM sale_items WHERE id = ?").bind(sale_item_id).first();
  if (!line) return Response.json({ error: "Sale line not found" }, { status: 404 });
  if (!line.item_id) return Response.json({ error: "This line has no catalogue item to return — it was a custom/service line" }, { status: 400 });

  const alreadyReturned = await env.DB.prepare("SELECT COALESCE(SUM(quantity),0) AS t FROM sale_returns WHERE sale_item_id = ?").bind(sale_item_id).first();
  const remaining = line.quantity - alreadyReturned.t;
  if (quantity > remaining + 0.001) {
    return Response.json({ error: `Only ${remaining} still returnable on this line — ${alreadyReturned.t} already returned out of ${line.quantity} sold` }, { status: 400 });
  }

  let site = destination_site_id;
  if (!site) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to return into" }, { status: 400 });
    site = storeSite.id;
  }

  // Matches how every other inbound movement in this system works — the
  // returned piece becomes its own new lot, never silently merged back
  // into whatever lot it was originally sold from.
  const lotId = await nextId(env, "item_lots", "LOT");
  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, notes)
     VALUES (?, ?, ?, ?, ?, 'sales_return', ?, ?)`
  ).bind(lotId, line.item_id, site, quantity, quantity, line.sale_id, notes || `Returned from sale ${line.sale_id}`).run();

  await env.DB.prepare(
    "INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, notes, created_by) VALUES (?, ?, 'returned', ?, ?, ?, ?)"
  ).bind(lotId, line.item_id, site, quantity, `Sales return on ${line.sale_id}`, data.user?.name || "unknown").run();

  await env.DB.prepare(
    "INSERT INTO sale_returns (sale_item_id, lot_id, quantity, destination_site_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(sale_item_id, lotId, quantity, site, notes || null, data.user?.name || "unknown").run();

  return Response.json({ ok: true, lot_id: lotId, remaining_returnable: Math.round((remaining - quantity) * 100) / 100 });
}
