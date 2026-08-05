export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { site_id, delta, reason } = body;

  if (!site_id || !delta) return Response.json({ error: "site_id and a non-zero delta are required" }, { status: 400 });

  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(params.id).first();
  if (!item) return Response.json({ error: "Item not found" }, { status: 404 });
  const site = await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(site_id).first();
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  if (delta > 0) {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM item_lots").first();
    const lotId = "LOT-" + String((countRow?.c || 0) + 1).padStart(6, "0");
    await env.DB.prepare(
      `INSERT INTO item_lots (id, item_id, site_id, quantity_original, quantity_balance, source_type, notes)
       VALUES (?, ?, ?, ?, ?, 'adjustment', ?)`
    ).bind(lotId, params.id, site_id, delta, delta, reason || null).run();

    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, to_site_id, quantity, notes, created_by)
       VALUES (?, ?, 'adjusted', ?, ?, ?, ?)`
    ).bind(lotId, params.id, site_id, delta, reason || "Stock added", data.user?.name || "unknown").run();

    return Response.json({ ok: true, lot_id: lotId, new_total: await totalStock(env, params.id) });
  }

  // Negative delta: consume from existing lots at this site, oldest first.
  const need = Math.abs(delta);
  const { results: lots } = await env.DB.prepare(
    "SELECT * FROM item_lots WHERE item_id = ? AND site_id = ? AND quantity_balance > 0 ORDER BY created_at ASC"
  ).bind(params.id, site_id).all();

  const available = lots.reduce((sum, l) => sum + l.quantity_balance, 0);
  if (available < need) {
    return Response.json({ error: `Only ${available} available at this site — can't remove ${need}` }, { status: 400 });
  }

  let remaining = need;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity_balance, remaining);
    await env.DB.prepare("UPDATE item_lots SET quantity_balance = quantity_balance - ? WHERE id = ?").bind(take, lot.id).run();
    await env.DB.prepare(
      `INSERT INTO item_movements (lot_id, item_id, event_type, from_site_id, quantity, notes, created_by)
       VALUES (?, ?, 'adjusted', ?, ?, ?, ?)`
    ).bind(lot.id, params.id, site_id, take, reason || "Stock removed", data.user?.name || "unknown").run();
    remaining -= take;
  }

  return Response.json({ ok: true, new_total: await totalStock(env, params.id) });
}

async function totalStock(env, itemId) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(quantity_balance),0) AS t FROM item_lots WHERE item_id = ?").bind(itemId).first();
  return row.t;
}
