async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM " + table).first();
  return prefix + "-" + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestGet({ env }) {
  const { results: milestones } = await env.DB.prepare("SELECT * FROM reseller_milestones ORDER BY start_date DESC").all();
  for (const m of milestones) {
    const { results: targets } = await env.DB.prepare(
      "SELECT rmt.*, p.name AS reseller_name FROM reseller_milestone_targets rmt LEFT JOIN parties p ON p.id = rmt.reseller_party_id WHERE rmt.milestone_id = ?"
    ).bind(m.id).all();
    m.targets = targets;
  }
  return Response.json(milestones);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { name, target_value, start_date, end_date, perk_type, perk_points, perk_reward_item_id, reseller_party_ids } = body;
  if (!name || !target_value || !start_date || !end_date || !perk_type) {
    return Response.json({ error: "name, target_value, start_date, end_date, and perk_type are required" }, { status: 400 });
  }
  if (perk_type === "bonus_points" && !perk_points) return Response.json({ error: "perk_points is required when perk_type is bonus_points" }, { status: 400 });
  if (perk_type === "reward_item" && !perk_reward_item_id) return Response.json({ error: "perk_reward_item_id is required when perk_type is reward_item" }, { status: 400 });
  if (!reseller_party_ids || !reseller_party_ids.length) return Response.json({ error: "At least one targeted reseller is required" }, { status: 400 });

  const id = await nextId(env, "reseller_milestones", "MLS");
  await env.DB.prepare(
    "INSERT INTO reseller_milestones (id, name, target_value, start_date, end_date, perk_type, perk_points, perk_reward_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, name, target_value, start_date, end_date, perk_type, perk_points || null, perk_reward_item_id || null).run();

  for (const resellerId of reseller_party_ids) {
    await env.DB.prepare("INSERT INTO reseller_milestone_targets (milestone_id, reseller_party_id) VALUES (?, ?)").bind(id, resellerId).run();
  }

  return Response.json({ id });
}
