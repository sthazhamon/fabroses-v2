import { getCurrentLevel, getSpendableBalance, getPriorWindowPoints } from "./_gamification.js";

export async function onRequestGet({ env }) {
  const { results: resellers } = await env.DB.prepare("SELECT * FROM parties WHERE type = 'reseller'").all();

  const leaderboard = [];
  for (const reseller of resellers) {
    const { points_this_year, level, manually_overridden } = await getCurrentLevel(env, reseller.id);
    const spendableBalance = await getSpendableBalance(env, reseller.id);
    const priorPoints = await getPriorWindowPoints(env, reseller.id);

    let trend = "same";
    if (points_this_year > priorPoints) trend = "up";
    else if (points_this_year < priorPoints) trend = "down";

    leaderboard.push({
      reseller_party_id: reseller.id,
      reseller_name: reseller.name,
      current_level: level ? level.level_name : null,
      manually_overridden: manually_overridden,
      points_this_period: points_this_year,
      points_prior_period: priorPoints,
      trend: trend,
      spendable_balance: spendableBalance,
    });
  }

  leaderboard.sort(function (a, b) { return b.points_this_period - a.points_this_period; });
  leaderboard.forEach(function (entry, i) { entry.rank = i + 1; });

  return Response.json(leaderboard);
}
