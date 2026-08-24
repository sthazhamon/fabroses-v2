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
  section("=== Setup: three resellers with different current-vs-prior activity ===");
  const partiesMod = await import("../functions/api/parties.js");
  const gamificationMod = await import("../functions/api/_gamification.js");
  const leaderboardMod = await import("../functions/api/reseller-leaderboard.js");

  await gamificationMod.setRollingWindowDays(env, 90);

  const risingReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Rising Star", type: "reseller" }), env })).json();
  const decliningReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Declining Co", type: "reseller" }), env })).json();
  const steadyReseller = await (await partiesMod.onRequestPost({ request: req({ name: "Steady Ltd", type: "reseller" }), env })).json();

  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 1000, 'sale', datetime('now', '-150 days'))").bind(risingReseller.id).run();
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 3000, 'sale', datetime('now', '-10 days'))").bind(risingReseller.id).run();

  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 3000, 'sale', datetime('now', '-150 days'))").bind(decliningReseller.id).run();
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type, created_at) VALUES (?, 'earned', 500, 'sale', datetime('now', '-10 days'))").bind(decliningReseller.id).run();

  section("=== The leaderboard correctly computes trend against the prior window ===");
  const board = await (await leaderboardMod.onRequestGet({ env })).json();
  const rising = board.find(function (r) { return r.reseller_party_id === risingReseller.id; });
  const declining = board.find(function (r) { return r.reseller_party_id === decliningReseller.id; });
  const steady = board.find(function (r) { return r.reseller_party_id === steadyReseller.id; });

  assert(rising.trend === "up", "CRITICAL: the rising reseller (1000 prior -> 3000 current) is correctly marked up");
  assert(rising.points_this_period === 3000 && rising.points_prior_period === 1000, "the rising reseller's current and prior figures are both correctly reported");

  assert(declining.trend === "down", "CRITICAL: the declining reseller (3000 prior -> 500 current) is correctly marked down");
  assert(steady.trend === "same", "a reseller with zero activity in both periods is correctly marked same");

  section("=== The leaderboard is correctly ranked by current period points, highest first ===");
  assert(board[0].reseller_party_id === risingReseller.id, "the reseller with the most current-period points is correctly ranked first");
  assert(board[0].rank === 1, "rank is correctly assigned starting from 1");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
