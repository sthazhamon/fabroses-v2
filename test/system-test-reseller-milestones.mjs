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
function daysFromNow(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function run() {
  section("=== Setup: two resellers, only one targeted by a milestone ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const partiesMod = await import("../functions/api/parties.js");
  const salesMod = await import("../functions/api/sales.js");
  const paymentsMod = await import("../functions/api/payments.js");
  const milestonesMod = await import("../functions/api/reseller-milestones.js");
  const gamificationMod = await import("../functions/api/_gamification.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "opening_stock" }), env, data: {} });
  const targetedReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  const untargetedReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Other Resellers", type: "reseller" }), env })).json();

  const milestoneRes = await (await milestonesMod.onRequestPost({
    request: req({ name: "August Challenge", target_value: 5000, start_date: daysFromNow(-5), end_date: daysFromNow(5), perk_type: "bonus_points", perk_points: 2000, reseller_party_ids: [targetedReseller.id] }),
    env,
  })).json();
  assert(milestoneRes.id, "the milestone is created with its target reseller");

  section("=== Progress builds up but doesn't trigger until the target is genuinely met ===");
  const partialSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 3000 }], customer_party_id: targetedReseller.id, customer_name: null, sale_date: daysFromNow(-3) }), env, data: {} })).json();
  const partialPayment = await (await paymentsMod.onRequestPost({
    request: req({ party_id: targetedReseller.id, direction: "receivable", amount: 3000, allocations: [{ bill_type: "sale", bill_id: partialSale.id, amount_applied: 3000 }] }), env, data: {},
  })).json();
  assert(partialPayment.milestone_achievements.length === 0, "3000 of a 5000 target correctly doesn't trigger the milestone yet");

  section("=== CRITICAL: crossing the target correctly triggers the bonus-points perk ===");
  const finalSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 2500 }], customer_party_id: targetedReseller.id, customer_name: null, sale_date: daysFromNow(-2) }), env, data: {} })).json();
  const finalPayment = await (await paymentsMod.onRequestPost({
    request: req({ party_id: targetedReseller.id, direction: "receivable", amount: 2500, allocations: [{ bill_type: "sale", bill_id: finalSale.id, amount_applied: 2500 }] }), env, data: {},
  })).json();
  assert(finalPayment.milestone_achievements.length === 1, "CRITICAL: 3000+2500=5500, correctly crossing the 5000 target, triggers the milestone");
  assert(finalPayment.milestone_achievements[0].perk_type === "bonus_points" && finalPayment.milestone_achievements[0].perk_points === 2000, "the bonus-points perk is correctly identified");

  const spendableBalance = await gamificationMod.getSpendableBalance(env, targetedReseller.id);
  assert(spendableBalance === 3000 + 2500 + 2000, "CRITICAL: balance correctly includes BOTH regular earned points AND the milestone bonus, got " + spendableBalance);

  section("=== The untargeted reseller never gets checked at all, even with identical spending ===");
  const untargetedSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 6000 }], customer_party_id: untargetedReseller.id, customer_name: null, sale_date: daysFromNow(-1) }), env, data: {} })).json();
  const untargetedPayment = await (await paymentsMod.onRequestPost({
    request: req({ party_id: untargetedReseller.id, direction: "receivable", amount: 6000, allocations: [{ bill_type: "sale", bill_id: untargetedSale.id, amount_applied: 6000 }] }), env, data: {},
  })).json();
  assert(untargetedPayment.milestone_achievements.length === 0, "CRITICAL: a reseller who spent MORE but was never targeted correctly gets no achievement at all");

  section("=== Achieving it again on a further payment doesn't double-fire the perk ===");
  const extraSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 100 }], customer_party_id: targetedReseller.id, customer_name: null, sale_date: daysFromNow(0) }), env, data: {} })).json();
  const extraPayment = await (await paymentsMod.onRequestPost({
    request: req({ party_id: targetedReseller.id, direction: "receivable", amount: 100, allocations: [{ bill_type: "sale", bill_id: extraSale.id, amount_applied: 100 }] }), env, data: {},
  })).json();
  assert(extraPayment.milestone_achievements.length === 0, "an already-achieved milestone correctly never fires its perk a second time");

  section("=== A reward-item perk correctly creates a redemption request, not direct points ===");
  const rewardItemsMod = await import("../functions/api/reseller-reward-items.js");
  const rewardRes = await (await rewardItemsMod.onRequestPost({ request: req({ name: "Watch", points_cost: 0 }), env })).json();
  const secondReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Third Reseller", type: "reseller" }), env })).json();
  await milestonesMod.onRequestPost({
    request: req({ name: "September Reward Challenge", target_value: 1000, start_date: daysFromNow(10), end_date: daysFromNow(40), perk_type: "reward_item", perk_reward_item_id: rewardRes.id, reseller_party_ids: [secondReseller.id] }),
    env,
  });
  const septSale = await (await salesMod.onRequestPost({ request: req({ lines: [{ item_id: item.id, quantity: 1, description: "Saree", sale_price: 1500 }], customer_party_id: secondReseller.id, customer_name: null, sale_date: daysFromNow(20) }), env, data: {} })).json();
  const septPayment = await (await paymentsMod.onRequestPost({
    request: req({ party_id: secondReseller.id, direction: "receivable", amount: 1500, allocations: [{ bill_type: "sale", bill_id: septSale.id, amount_applied: 1500 }] }), env, data: {},
  })).json();
  assert(septPayment.milestone_achievements[0].perk_type === "reward_item" && septPayment.milestone_achievements[0].redemption_id, "the reward-item perk correctly creates a redemption request instead of crediting points directly");

  const redemption = await env.DB.prepare("SELECT * FROM reseller_reward_redemptions WHERE id = ?").bind(septPayment.milestone_achievements[0].redemption_id).first();
  assert(redemption.status === "requested", "the milestone-triggered redemption correctly still needs admin approval and shipping, just like a normal reward request");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
