export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const itemId = url.searchParams.get("item_id");
  const siteId = url.searchParams.get("site_id");

  const conditions = [];
  const params = [];
  if (from) { conditions.push("date(m.created_at) >= date(?)"); params.push(from); }
  if (to) { conditions.push("date(m.created_at) <= date(?)"); params.push(to); }
  if (itemId) { conditions.push("m.item_id = ?"); params.push(itemId); }
  if (siteId) { conditions.push("(m.from_site_id = ? OR m.to_site_id = ?)"); params.push(siteId, siteId); }

  const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const { results } = await env.DB.prepare(
    `SELECT m.*, i.name AS item_name, i.item_code, fs.name AS from_site_name, ts.name AS to_site_name
     FROM item_movements m
     LEFT JOIN items i ON i.id = m.item_id
     LEFT JOIN sites fs ON fs.id = m.from_site_id
     LEFT JOIN sites ts ON ts.id = m.to_site_id
     ${whereClause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 500`
  ).bind(...params).all();

  return Response.json(results);
}
