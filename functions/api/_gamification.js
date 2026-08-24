// Points are earned proportional to order value, but only once a sale is
// genuinely fully paid, not at billing time. This checks whether a
// specific sale has just become fully paid, and if its customer is a
// reseller, awards points exactly once - never double-awarding if this
// gets called again after the sale was already fully settled.
export async function awardPointsIfSaleFullyPaid(env, saleId, actorName) {
  const sale = await env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(saleId).first();
  if (!sale || !sale.customer_party_id) return null;

  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(sale.customer_party_id).first();
  if (!party || party.type !== "reseller") return null;

  const alreadyAwarded = await env.DB.prepare(
    "SELECT id FROM reseller_points_ledger WHERE reference_type = 'sale' AND reference_id = ?"
  ).bind(saleId).first();
  if (alreadyAwarded) return null;

  const allocatedRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_applied),0) AS t FROM payment_allocations WHERE bill_type = 'sale' AND bill_id = ?"
  ).bind(saleId).first();
  if (allocatedRow.t < sale.total_amount - 0.001) return null;

  const pointsRate = await getPointsPerRupee(env);
  const pointsEarned = Math.round(sale.total_amount * pointsRate * 100) / 100;
  if (pointsEarned <= 0) return null;

  await env.DB.prepare(
    "INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, reference_id, notes) VALUES (?, 'earned', ?, 'sale', ?, ?)"
  ).bind(party.id, pointsEarned, saleId, "Earned from fully-paid sale " + saleId).run();

  return { reseller_party_id: party.id, points_earned: pointsEarned };
}

export async function getPointsPerRupee(env) {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'reseller_points_per_rupee'").first();
  return row ? parseFloat(row.value) : 1;
}

export async function setPointsPerRupee(env, rate) {
  await env.DB.prepare("INSERT INTO system_settings (key, value) VALUES ('reseller_points_per_rupee', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(rate)).run();
}

export async function getSpendableBalance(env, resellerPartyId) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(points),0) AS t FROM reseller_points_ledger WHERE reseller_party_id = ?").bind(resellerPartyId).first();
  return row.t;
}

export async function getRollingWindowDays(env) {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'reseller_level_window_days'").first();
  return row ? parseInt(row.value, 10) : 90;
}

export async function setRollingWindowDays(env, days) {
  await env.DB.prepare("INSERT INTO system_settings (key, value) VALUES ('reseller_level_window_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(days)).run();
}

// The window immediately BEFORE the current one - e.g. if the window is
// 90 days, this covers days 90-180 ago. Used to compare current standing
// against "last period" on the leaderboard.
export async function getPriorWindowPoints(env, resellerPartyId) {
  const windowDays = await getRollingWindowDays(env);
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(points),0) AS t FROM reseller_points_ledger WHERE reseller_party_id = ? AND event_type = 'earned' AND date(created_at) >= date('now', '-' || ? || ' days') AND date(created_at) < date('now', '-' || ? || ' days')"
  ).bind(resellerPartyId, windowDays * 2, windowDays).first();
  return row.t;
}

export async function getCurrentLevel(env, resellerPartyId) {
  const windowDays = await getRollingWindowDays(env);
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(points),0) AS t FROM reseller_points_ledger WHERE reseller_party_id = ? AND event_type = 'earned' AND date(created_at) >= date('now', '-' || ? || ' days')"
  ).bind(resellerPartyId, windowDays).first();
  const pointsThisWindow = row.t;

  const { results: levels } = await env.DB.prepare("SELECT * FROM reseller_level_config ORDER BY min_points_this_year DESC").all();
  const computedLevel = levels.find(function(l){ return pointsThisWindow >= l.min_points_this_year; }) || null;

  // A manual override (e.g. for outstanding payments) always wins over the
  // computed level, but can only ever push it DOWN, never up - it exists
  // to restrict a reseller, not to artificially inflate their standing.
  const party = await env.DB.prepare("SELECT manual_level_override FROM parties WHERE id = ?").bind(resellerPartyId).first();
  let effectiveLevel = computedLevel;
  let overridden = false;
  if (party && party.manual_level_override) {
    const overrideLevel = levels.find(function(l){ return l.level_name === party.manual_level_override; });
    if (overrideLevel && (!computedLevel || overrideLevel.min_points_this_year < computedLevel.min_points_this_year)) {
      effectiveLevel = overrideLevel;
      overridden = true;
    }
  }

  return { points_this_year: pointsThisWindow, window_days: windowDays, level: effectiveLevel, computed_level: computedLevel, manually_overridden: overridden };
}

async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM " + table).first();
  return prefix + "-" + String((row?.c || 0) + 1).padStart(pad, "0");
}

// Called after a sale becomes fully paid for a reseller - checks every
// active, still-unachieved milestone targeted at them, and applies the
// perk if their fully-paid order value within the milestone's window now
// meets the target. A bonus-points perk credits directly; a specific-item
// perk creates a redemption request that still goes through the normal
// admin approval-and-ship flow, since a physical product still needs to
// actually reach them.
export async function checkMilestoneAchievements(env, resellerPartyId) {
  const achievements = [];
  const { results: targets } = await env.DB.prepare(
    "SELECT rmt.id AS target_row_id, rmt.milestone_id, rmt.reseller_party_id, rmt.achieved_at, rmt.redemption_id, " +
    "m.name, m.target_value, m.start_date, m.end_date, m.perk_type, m.perk_points, m.perk_reward_item_id " +
    "FROM reseller_milestone_targets rmt " +
    "JOIN reseller_milestones m ON m.id = rmt.milestone_id " +
    "WHERE rmt.reseller_party_id = ? AND rmt.achieved_at IS NULL AND date('now') <= date(m.end_date)"
  ).bind(resellerPartyId).all();

  for (const target of targets) {
    const progressRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(pa.amount_applied),0) AS t FROM payment_allocations pa " +
      "JOIN sales s ON s.id = pa.bill_id AND pa.bill_type = 'sale' " +
      "WHERE s.customer_party_id = ? AND date(s.sale_date) BETWEEN date(?) AND date(?)"
    ).bind(resellerPartyId, target.start_date, target.end_date).first();

    if (progressRow.t >= target.target_value) {
      await env.DB.prepare("UPDATE reseller_milestone_targets SET achieved_at = datetime('now') WHERE id = ?").bind(target.target_row_id).run();

      if (target.perk_type === "bonus_points") {
        await env.DB.prepare(
          "INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, reference_id, notes) VALUES (?, 'milestone_bonus', ?, 'milestone', ?, ?)"
        ).bind(resellerPartyId, target.perk_points, target.milestone_id, "Milestone achieved: " + target.name).run();
        achievements.push({ milestone_id: target.milestone_id, perk_type: "bonus_points", perk_points: target.perk_points });
      } else if (target.perk_type === "reward_item") {
        const redemptionId = await nextId(env, "reseller_reward_redemptions", "RDM");
        await env.DB.prepare(
          "INSERT INTO reseller_reward_redemptions (id, reseller_party_id, reward_item_id, points_spent, status) VALUES (?, ?, ?, 0, 'requested')"
        ).bind(redemptionId, resellerPartyId, target.perk_reward_item_id).run();
        await env.DB.prepare("UPDATE reseller_milestone_targets SET redemption_id = ? WHERE id = ?").bind(redemptionId, target.target_row_id).run();
        achievements.push({ milestone_id: target.milestone_id, perk_type: "reward_item", redemption_id: redemptionId });
      }
    }
  }
  return achievements;
}

// A reseller's live progress toward each of their active, targeted,
// unachieved milestones - for the portal to display.
export async function getMilestoneProgress(env, resellerPartyId) {
  const { results: targets } = await env.DB.prepare(
    "SELECT rmt.id AS target_row_id, rmt.milestone_id, rmt.achieved_at, " +
    "m.name, m.target_value, m.start_date, m.end_date " +
    "FROM reseller_milestone_targets rmt " +
    "JOIN reseller_milestones m ON m.id = rmt.milestone_id " +
    "WHERE rmt.reseller_party_id = ? AND date('now') <= date(m.end_date)"
  ).bind(resellerPartyId).all();

  const progress = [];
  for (const target of targets) {
    const progressRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(pa.amount_applied),0) AS t FROM payment_allocations pa " +
      "JOIN sales s ON s.id = pa.bill_id AND pa.bill_type = 'sale' " +
      "WHERE s.customer_party_id = ? AND date(s.sale_date) BETWEEN date(?) AND date(?)"
    ).bind(resellerPartyId, target.start_date, target.end_date).first();
    progress.push({
      milestone_id: target.milestone_id, name: target.name, target_value: target.target_value,
      current_value: progressRow.t, achieved: !!target.achieved_at, end_date: target.end_date,
    });
  }
  return progress;
}
