import { getCurrentLevel, getSpendableBalance, getMilestoneProgress } from "./_gamification.js";
import { computeBalance } from "./parties.js";

export async function onRequestGet({ env, data }) {
  const resellerPartyId = data.user?.resellerPartyId;
  if (!resellerPartyId) {
    return Response.json({ error: "This login isn't linked to a reseller party. An admin can fix this in Users." }, { status: 400 });
  }

  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(resellerPartyId).first();
  const { balance: outstandingBalance } = await computeBalance(env, party);

  let ledgerEntries = [];
  if (party?.account_id) {
    const { results } = await env.DB.prepare(
      `SELECT jl.debit, jl.credit, je.entry_date, je.description, je.reference_type, je.reference_id
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE jl.account_id = ? ORDER BY je.entry_date DESC, je.id DESC LIMIT 30`
    ).bind(party.account_id).all();
    ledgerEntries = results;
  }

  const { results: orders } = await env.DB.prepare(
    "SELECT co.*, s.id AS sale_id, s.total_amount AS sale_total FROM customer_orders co LEFT JOIN sales s ON s.id = co.sale_id " +
    "WHERE co.customer_party_id = ? ORDER BY co.created_at DESC"
  ).bind(resellerPartyId).all();

  const { points_this_year, window_days, level, manually_overridden } = await getCurrentLevel(env, resellerPartyId);
  const spendableBalance = await getSpendableBalance(env, resellerPartyId);
  const milestoneProgress = await getMilestoneProgress(env, resellerPartyId);

  const { results: rewardCatalog } = await env.DB.prepare(
    "SELECT rri.*, i.name AS item_name FROM reseller_reward_items rri LEFT JOIN items i ON i.id = rri.item_id WHERE rri.active = 1 ORDER BY rri.points_cost ASC"
  ).all();

  const { results: myRedemptions } = await env.DB.prepare(
    "SELECT rrr.*, rri.name AS reward_name FROM reseller_reward_redemptions rrr LEFT JOIN reseller_reward_items rri ON rri.id = rrr.reward_item_id " +
    "WHERE rrr.reseller_party_id = ? ORDER BY rrr.requested_at DESC"
  ).bind(resellerPartyId).all();

  return Response.json({
    reseller_name: party ? party.name : null,
    orders: orders,
    outstanding_balance: outstandingBalance,
    ledger_entries: ledgerEntries,
    points_this_year: points_this_year,
    window_days: window_days,
    current_level: level,
    manually_overridden: manually_overridden,
    spendable_balance: spendableBalance,
    milestone_progress: milestoneProgress,
    reward_catalog: rewardCatalog,
    my_redemptions: myRedemptions,
  });
}
