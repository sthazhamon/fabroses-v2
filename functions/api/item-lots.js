export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const itemId = url.searchParams.get("item_id");
  const siteId = url.searchParams.get("site_id");

  let query = `
    SELECT l.*, i.name AS item_name, i.item_code, s.name AS site_name
    FROM item_lots l
    LEFT JOIN items i ON i.id = l.item_id
    LEFT JOIN sites s ON s.id = l.site_id
    WHERE 1=1`;
  const params = [];
  if (itemId) { query += " AND l.item_id = ?"; params.push(itemId); }
  if (siteId) { query += " AND l.site_id = ?"; params.push(siteId); }
  query += " ORDER BY l.created_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { item_id, site_id, quantity, source_type, source_reference, cost_total, notes } = body;

  const validSources = ["purchase_order", "direct_intake", "work_order_output", "opening_stock", "adjustment"];
  if (!item_id || !site_id || !quantity || !validSources.includes(source_type)) {
    return Response.json({ error: `item_id, site_id, quantity, and a valid source_type (${validSources.join(", ")}) are required` }, { status: 400 });
  }

  const item = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(item_id).first();
  if (!item) return Response.json({ error: "Item not found" }, { status: 404 });
  const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(site_id).first();
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM item_lots").first();
  const lotId = "LOT-" + String((countRow?.c || 0) + 1).padStart(6, "0");

  await env.DB.prepare(
    `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, source_reference, cost_total, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(lotId, item_id, site_id, quantity, quantity, source_type, source_reference || null, cost_total || null, notes || null).run();

  await env.DB.prepare(
    `INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, to_site_id, quantity, notes, created_by)
     VALUES (?, ?, 'received', NULL, ?, ?, ?, ?)`
  ).bind(lotId, item_id, site_id, quantity, notes || `New lot: ${source_type}`, data.user?.name || "system").run();

  return Response.json({ id: lotId });
}
