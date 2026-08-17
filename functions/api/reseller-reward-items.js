async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM " + table).first();
  return prefix + "-" + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT rri.*, i.name AS item_name, i.item_code FROM reseller_reward_items rri LEFT JOIN items i ON i.id = rri.item_id ORDER BY rri.points_cost ASC"
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { item_id, name, points_cost } = body;
  if (!name || points_cost == null) return Response.json({ error: "name and points_cost are required" }, { status: 400 });

  const id = await nextId(env, "reseller_reward_items", "RWD");
  await env.DB.prepare("INSERT INTO reseller_reward_items (id, item_id, name, points_cost) VALUES (?, ?, ?, ?)")
    .bind(id, item_id || null, name, points_cost).run();
  return Response.json({ id });
}
