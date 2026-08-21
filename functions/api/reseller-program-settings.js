import { getPointsPerRupee, setPointsPerRupee, getRollingWindowDays, setRollingWindowDays } from "./_gamification.js";
import { getRedemptionRatePerPoint, setRedemptionRatePerPoint } from "./reseller-redeem-cash.js";

export async function onRequestGet({ env }) {
  const earnRate = await getPointsPerRupee(env);
  const windowDays = await getRollingWindowDays(env);
  const redeemRate = await getRedemptionRatePerPoint(env);
  return Response.json({ earn_rate_per_rupee: earnRate, level_window_days: windowDays, redeem_rate_per_point: redeemRate });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  if (body.earn_rate_per_rupee != null) await setPointsPerRupee(env, body.earn_rate_per_rupee);
  if (body.level_window_days != null) await setRollingWindowDays(env, body.level_window_days);
  if (body.redeem_rate_per_point != null) await setRedemptionRatePerPoint(env, body.redeem_rate_per_point);
  return Response.json({ ok: true });
}
