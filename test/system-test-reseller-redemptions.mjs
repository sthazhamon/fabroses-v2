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
  section("=== Setup: a reseller with 1000 points, and a catalog item ===");
  const partiesMod = await import("../functions/api/parties.js");
  const rewardItemsMod = await import("../functions/api/reseller-reward-items.js");
  const redemptionsMod = await import("../functions/api/reseller-reward-redemptions.js");
  const redemptionDetailMod = await import("../functions/api/reseller-reward-redemptions/[id].js");
  const gamificationMod = await import("../functions/api/_gamification.js");

  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type) VALUES (?, 'earned', 1000, 'sale')").bind(reseller.id).run();

  const rewardRes = await (await rewardItemsMod.onRequestPost({ request: req({ name: "Gift Hamper", points_cost: 600 }), env })).json();

  section("=== A reseller can request a reward they can afford ===");
  const redemptionRes = await (await redemptionsMod.onRequestPost({ request: req({ reseller_party_id: reseller.id, reward_item_id: rewardRes.id }), env, data: {} })).json();
  assert(redemptionRes.id, "the redemption request succeeds");

  const balanceAfterRequest = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfterRequest === 1000, "CRITICAL: points are NOT deducted just from requesting - still 1000, got " + balanceAfterRequest);

  section("=== CRITICAL: overcommitment is prevented across multiple pending requests ===");
  const secondRewardRes = await (await rewardItemsMod.onRequestPost({ request: req({ name: "Watch", points_cost: 500 }), env })).json();
  const secondAttempt = await (await redemptionsMod.onRequestPost({ request: req({ reseller_party_id: reseller.id, reward_item_id: secondRewardRes.id }), env, data: {} })).json();
  assert(secondAttempt.error, "CRITICAL: a second request (500 more, when only 400 is genuinely free after the first pending 600) is correctly rejected");

  section("=== A cheaper second request that genuinely still fits succeeds ===");
  const thirdRewardRes = await (await rewardItemsMod.onRequestPost({ request: req({ name: "Scarf", points_cost: 300 }), env })).json();
  const thirdAttempt = await (await redemptionsMod.onRequestPost({ request: req({ reseller_party_id: reseller.id, reward_item_id: thirdRewardRes.id }), env, data: {} })).json();
  assert(thirdAttempt.id, "a request for exactly what's still genuinely available (400 free, needs 300) correctly succeeds");

  section("=== Points are only deducted once admin approves ===");
  const approveRes = await (await redemptionDetailMod.onRequestPatch({ request: req({ status: "approved" }), env, params: { id: redemptionRes.id } })).json();
  assert(approveRes.ok, "approving the first redemption succeeds");

  const balanceAfterApproval = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfterApproval === 400, "CRITICAL: points are now correctly deducted (1000-600=400), only upon approval, got " + balanceAfterApproval);

  section("=== Shipping requires prior approval ===");
  const shipBlockedRes = await (await redemptionDetailMod.onRequestPatch({ request: req({ status: "shipped" }), env, params: { id: thirdAttempt.id } })).json();
  assert(shipBlockedRes.error, "attempting to ship a redemption that's only requested, not yet approved, is correctly rejected");

  const shipRes = await (await redemptionDetailMod.onRequestPatch({ request: req({ status: "shipped", courier: "BlueDart", tracking_id: "BD999" }), env, params: { id: redemptionRes.id } })).json();
  assert(shipRes.ok, "shipping an already-approved redemption succeeds");

  const finalRedemption = await env.DB.prepare("SELECT * FROM reseller_reward_redemptions WHERE id = ?").bind(redemptionRes.id).first();
  assert(finalRedemption.status === "shipped" && finalRedemption.courier === "BlueDart", "the redemption correctly shows shipped with courier details");

  section("=== A rejected request never deducts points ===");
  const rejectRes = await (await redemptionDetailMod.onRequestPatch({ request: req({ status: "rejected" }), env, params: { id: thirdAttempt.id } })).json();
  assert(rejectRes.ok, "rejecting a still-pending request succeeds");
  const balanceAfterReject = await gamificationMod.getSpendableBalance(env, reseller.id);
  assert(balanceAfterReject === 400, "rejecting correctly deducts nothing - balance stays at 400");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
