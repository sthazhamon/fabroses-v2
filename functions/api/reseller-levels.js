export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM reseller_level_config ORDER BY min_points_this_year ASC").all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { level_name, min_points_this_year, discount_percent, sort_order } = body;
  if (!level_name || min_points_this_year == null) return Response.json({ error: "level_name and min_points_this_year are required" }, { status: 400 });

  const existing = await env.DB.prepare("SELECT id FROM reseller_level_config WHERE level_name = ?").bind(level_name).first();
  if (existing) {
    await env.DB.prepare("UPDATE reseller_level_config SET min_points_this_year = ?, discount_percent = ?, sort_order = ? WHERE id = ?")
      .bind(min_points_this_year, discount_percent || 0, sort_order || 0, existing.id).run();
    return Response.json({ id: existing.id, updated: true });
  }

  const result = await env.DB.prepare("INSERT INTO reseller_level_config (level_name, min_points_this_year, discount_percent, sort_order) VALUES (?, ?, ?, ?)")
    .bind(level_name, min_points_this_year, discount_percent || 0, sort_order || 0).run();
  return Response.json({ id: result.meta.last_row_id, created: true });
}
