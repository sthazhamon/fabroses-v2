import { logEdits } from "../_editlog.js";

export async function onRequestGet({ params, env }) {
  const item = await env.DB.prepare(
    `SELECT i.*, c.name AS category_name, f.name AS fabric_name, w.name AS work_type_name, p.name AS pattern_name
     FROM items i
     LEFT JOIN item_categories c ON c.id = i.category_id
     LEFT JOIN item_fabrics f ON f.id = i.fabric_id
     LEFT JOIN item_work_types w ON w.id = i.work_type_id
     LEFT JOIN item_patterns p ON p.id = i.pattern_id
     WHERE i.id = ?`
  ).bind(params.id).first();

  if (!item) return Response.json({ error: "not found" }, { status: 404 });

  const { results: lotsBySite } = await env.DB.prepare(
    `SELECT l.*, s.name AS site_name, s.site_type
     FROM item_lots l LEFT JOIN sites s ON s.id = l.site_id
     WHERE l.item_id = ? AND l.quantity_balance > 0
     ORDER BY s.site_type ASC, l.created_at ASC`
  ).bind(params.id).all();

  const { results: photos } = await env.DB.prepare(
    "SELECT * FROM item_photos WHERE item_id = ? ORDER BY uploaded_at DESC"
  ).bind(params.id).all();

  const totalStock = lotsBySite.reduce((sum, l) => sum + l.quantity_balance, 0);

  return Response.json({ ...item, lots_by_site: lotsBySite, total_stock: totalStock, photos });
}

export async function onRequestPatch({ request, env, params, data }) {
  const body = await request.json();
  const existing = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(params.id).first();
  if (!existing) return Response.json({ error: "Item not found" }, { status: 404 });

  const editable = ["name", "color", "price", "cost", "description", "unit_of_measure"];
  const changes = {};
  for (const field of editable) {
    if (body[field] !== undefined) changes[field] = body[field];
  }
  if (!Object.keys(changes).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  await logEdits(env, "item", params.id, existing, changes, data.user?.name);

  const setClauses = Object.keys(changes).map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE items SET ${setClauses} WHERE id = ?`).bind(...Object.values(changes), params.id).run();

  return Response.json({ ok: true });
}
