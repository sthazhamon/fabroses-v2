import { getSpendableBalance } from "./_gamification.js";

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM " + table).first();
  return prefix + "-" + String((row?.c || 0) + 1).padStart(pad, "0");
}

export async function onRequestGet({ request, env, data }) {
  const url = new URL(request.url);
  let resellerId = url.searchParams.get("reseller_party_id");
  if (data.user?.role === "reseller") resellerId = data.user.resellerPartyId;
  let q = "SELECT rrr.*, rri.name AS reward_name, rri.points_cost AS catalog_points_cost FROM reseller_reward_redemptions rrr LEFT JOIN reseller_reward_items rri ON rri.id = rrr.reward_item_id";
  const params = [];
  if (resellerId) { q += " WHERE rrr.reseller_party_id = ?"; params.push(resellerId); }
  q += " ORDER BY rrr.requested_at DESC";
  const { results } = await env.DB.prepare(q).bind(...params).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  let { reseller_party_id, reward_item_id } = body;
  if (!reward_item_id) return Response.json({ error: "reward_item_id is required" }, { status: 400 });

  // A reseller login can only ever request on their own behalf, never on
  // behalf of another reseller, regardless of what's passed in the body.
  if (data.user?.role === "reseller") {
    if (!data.user.resellerPartyId) return Response.json({ error: "This login isn't linked to a reseller party." }, { status: 400 });
    reseller_party_id = data.user.resellerPartyId;
  }
  if (!reseller_party_id) return Response.json({ error: "reseller_party_id is required" }, { status: 400 });

  const reward = await env.DB.prepare("SELECT * FROM reseller_reward_items WHERE id = ?").bind(reward_item_id).first();
  if (!reward || !reward.active) return Response.json({ error: "That reward isn't available" }, { status: 400 });

  const balance = await getSpendableBalance(env, reseller_party_id);
  const pendingRow = await env.DB.prepare("SELECT COALESCE(SUM(points_spent),0) AS t FROM reseller_reward_redemptions WHERE reseller_party_id = ? AND status = 'requested'").bind(reseller_party_id).first();
  const genuinelyAvailable = balance - pendingRow.t;
  if (genuinelyAvailable < reward.points_cost) {
    return Response.json({ error: "Only " + genuinelyAvailable + " points genuinely available (some may already be committed to another pending request) - this reward costs " + reward.points_cost }, { status: 400 });
  }

  const id = await nextId(env, "reseller_reward_redemptions", "RDM");
  await env.DB.prepare("INSERT INTO reseller_reward_redemptions (id, reseller_party_id, reward_item_id, points_spent, status) VALUES (?, ?, ?, ?, 'requested')")
    .bind(id, reseller_party_id, reward_item_id, reward.points_cost).run();

  return Response.json({ id, points_cost: reward.points_cost });
}
