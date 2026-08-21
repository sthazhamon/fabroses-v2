import { getSpendableBalance } from "./_gamification.js";
import { getOrCreatePartyAccount, accountFixedId, postJournalEntry } from "./_ledger.js";

export async function getRedemptionRatePerPoint(env) {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'reseller_redemption_rate_per_point'").first();
  return row ? parseFloat(row.value) : 0.5;
}

export async function setRedemptionRatePerPoint(env, rate) {
  await env.DB.prepare("INSERT INTO system_settings (key, value) VALUES ('reseller_redemption_rate_per_point', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(rate)).run();
}

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  let { reseller_party_id, points } = body;
  if (data.user?.role === "reseller") {
    if (!data.user.resellerPartyId) return Response.json({ error: "This login isn't linked to a reseller party." }, { status: 400 });
    reseller_party_id = data.user.resellerPartyId;
  }
  if (!reseller_party_id || !points) return Response.json({ error: "reseller_party_id and points are required" }, { status: 400 });
  if (points <= 0) return Response.json({ error: "points must be a positive number" }, { status: 400 });

  const balance = await getSpendableBalance(env, reseller_party_id);
  if (balance < points) return Response.json({ error: "Only " + balance + " points available" }, { status: 400 });

  const rate = await getRedemptionRatePerPoint(env);
  const creditValue = Math.round(points * rate * 100) / 100;

  await env.DB.prepare(
    "INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, notes) VALUES (?, 'spent', ?, 'cash_credit', ?)"
  ).bind(reseller_party_id, -points, "Redeemed " + points + " points for Rs " + creditValue + " credit").run();

  const lossAccountId = await accountFixedId(env, "4300");
  const partyAccountId = await getOrCreatePartyAccount(env, reseller_party_id);
  await postJournalEntry(env, {
    date: new Date().toISOString().slice(0, 10), description: "Reseller points redeemed for cash credit",
    reference_type: "reseller_points_redemption", reference_id: reseller_party_id, created_by: data.user?.name,
    lines: [{ account_id: lossAccountId, debit: creditValue }, { account_id: partyAccountId, credit: creditValue }],
  });

  return Response.json({ ok: true, points_redeemed: points, credit_value: creditValue });
}
