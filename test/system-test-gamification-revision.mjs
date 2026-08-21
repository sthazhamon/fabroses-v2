import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log("  \x1b[32m\u2713\x1b[0m " + l); } else { failed++; console.log("  \x1b[31m\u2717 FAIL\x1b[0m " + l); } }
function section(t) { console.log("\n" + t); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== Tiers can be relabeled to Regular/Silver/Gold ===");
  const levelsMod = await import("../functions/api/reseller-levels.js");
  const partiesMod = await import("../functions/api/parties.js");
  const partyDetailMod = await import("../functions/api/parties/[id].js");
  const gamificationMod = await import("../functions/api/_gamification.js");
  const redeemCashMod = await import("../functions/api/reseller-redeem-cash.js");

  await levelsMod.onRequestPost({ request: req({ level_name: "Regular", min_points_this_year: 0, discount_percent: 0 }), env });
  await levelsMod.onRequestPost({ request: req({ level_name: "Silver", min_points_this_year: 5000, discount_percent: 8 }), env });
  await levelsMod.onRequestPost({ request: req({ level_name: "Gold", min_points_this_year: 20000, discount_percent: 15 }), env });
  const levels = await (await levelsMod.onRequestGet({ env })).json();
  assert(levels.map((l) => l.level_name).sort().join(",") === "Gold,Regular,Silver", "the three relabeled tiers are correctly configured");

  section("=== CRITICAL: the rolling window replaces the calendar year ===");
  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  await gamificationMod.setRollingWindowDays(env, 90);

  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 8000, 'sale', datetime('now', '-120 days'))").bind(reseller.id).run();
  const statusOld = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(statusOld.level.level_name === "Regular", "CRITICAL: points earned 120 days ago, outside the 90-day window, correctly doesn't count");

  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 8000, 'sale', datetime('now', '-10 days'))").bind(reseller.id).run();
  const statusRecent = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(statusRecent.level.level_name === "Silver", "CRITICAL: points earned 10 days ago, inside the window, correctly counts and promotes to Silver");

  section("=== Widening the window brings the old points back into view ===");
  await gamificationMod.setRollingWindowDays(env, 200);
  const statusWiderWindow = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(statusWiderWindow.points_this_year === 16000, "the total correctly reflects both entries once the window is wide enough");

  section("=== A manual override correctly downgrades, but never upgrades ===");
  await gamificationMod.setRollingWindowDays(env, 90);
  const beforeOverride = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(beforeOverride.level.level_name === "Silver", "confirming baseline is Silver before applying the override");

  await partyDetailMod.onRequestPatch({ request: req({ manual_level_override: "Regular" }), env, params: { id: reseller.id } });
  const afterDowngrade = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(afterDowngrade.level.level_name === "Regular" && afterDowngrade.manually_overridden === true, "CRITICAL: the manual override correctly forces the level down to Regular");

  section("=== CRITICAL: a manual override set to a HIGHER tier is correctly ignored ===");
  await partyDetailMod.onRequestPatch({ request: req({ manual_level_override: "Gold" }), env, params: { id: reseller.id } });
  const afterFakeUpgrade = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(afterFakeUpgrade.level.level_name === "Silver" && afterFakeUpgrade.manually_overridden === false, "CRITICAL: overriding UP to Gold is correctly ignored - stays at the genuinely computed Silver");

  section("=== Clearing the override correctly restores the computed level ===");
  await partyDetailMod.onRequestPatch({ request: req({ manual_level_override: null }), env, params: { id: reseller.id } });
  const afterClear = await gamificationMod.getCurrentLevel(env, reseller.id);
  assert(afterClear.level.level_name === "Silver" && afterClear.manually_overridden === false, "clearing the override correctly restores the genuinely computed level");

  section("=== Cash-credit redemption is a real, separate path from the catalog ===");
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type) VALUES (?, 'earned', 1000, 'sale')").bind(reseller.id).run();
  const balanceBefore = await gamificationMod.getSpendableBalance(env, reseller.id);

  await redeemCashMod.setRedemptionRatePerPoint(env, 0.5);
  const redeemRes = await (await redeemCashMod.onRequestPost({ request: req({ reseller_party_id: reseller.id, points: 400 }), env, data: { user: { name: "Admin" } } })).json();
  assert(redeemRes.ok && redeemRes.credit_value === 200, "CRITICAL: redeeming 400 points at 0.5 Rs/point correctly produces Rs 200 credit");

  const balanceAfter = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfter === balanceBefore - 400, "points are correctly deducted immediately");

  const partyAccount = await env.DB.prepare("SELECT id FROM accounts WHERE name LIKE '%Cozy%'").first();
  const creditRow = await env.DB.prepare("SELECT COALESCE(SUM(credit),0) AS t FROM journal_lines WHERE account_id = ?").bind(partyAccount.id).first();
  assert(creditRow.t === 200, "CRITICAL: a real Rs 200 credit is correctly posted to the reseller's own party account");

  section("=== Redeeming more points than available is correctly refused ===");
  const overRedeemRes = await (await redeemCashMod.onRequestPost({ request: req({ reseller_party_id: reseller.id, points: 99999 }), env, data: {} })).json();
  assert(overRedeemRes.error, "attempting to redeem more points than available is correctly rejected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
