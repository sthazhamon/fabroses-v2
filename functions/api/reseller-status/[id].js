import { getCurrentLevel, getSpendableBalance } from "../_gamification.js";

export async function onRequestGet({ env, params }) {
  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(params.id).first();
  if (!party || party.type !== "reseller") return Response.json({ error: "Not a reseller" }, { status: 404 });

  const { points_this_year, level } = await getCurrentLevel(env, params.id);
  const spendableBalance = await getSpendableBalance(env, params.id);

  return Response.json({
    reseller_party_id: params.id, reseller_name: party.name,
    points_this_year: points_this_year, current_level: level,
    spendable_balance: spendableBalance,
  });
}
