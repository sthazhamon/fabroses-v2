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
  section("=== Admin configures level thresholds ===");
  const levelsMod = await import("../functions/api/reseller-levels.js");
  const partiesMod = await import("../functions/api/parties.js");
  const statusMod = await import("../functions/api/reseller-status/[id].js");

  await levelsMod.onRequestPost({ request: req({ level_name: "silver", min_points_this_year: 0, discount_percent: 5 }), env });
  await levelsMod.onRequestPost({ request: req({ level_name: "gold", min_points_this_year: 5000, discount_percent: 10 }), env });
  await levelsMod.onRequestPost({ request: req({ level_name: "platinum", min_points_this_year: 20000, discount_percent: 15 }), env });

  const levels = await (await levelsMod.onRequestGet({ env })).json();
  assert(levels.length === 3, "all three levels are correctly configured");

  section("=== A reseller with zero points sits at the lowest level ===");
  const reseller = await (await partiesMod.onRequestPost({ request: req({ name: "Cozy Resellers", type: "reseller" }), env })).json();
  const status0 = await (await statusMod.onRequestGet({ env, params: { id: reseller.id } })).json();
  assert(status0.current_level.level_name === "silver", "with zero points, correctly sits at silver, the lowest configured level");

  section("=== Earning enough points correctly promotes to the right level ===");
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type) VALUES (?, 'earned', 6000, 'sale')").bind(reseller.id).run();
  const status1 = await (await statusMod.onRequestGet({ env, params: { id: reseller.id } })).json();
  assert(status1.current_level.level_name === "gold", "CRITICAL: 6000 points correctly promotes to gold, got " + status1.current_level.level_name);
  assert(status1.current_level.discount_percent === 10, "gold's configured 10% discount is correctly returned");

  section("=== CRITICAL: level standing and spendable balance are genuinely independent ===");
  await env.DB.prepare("INSERT INTO reseller_points_ledger (reseller_party_id, event_type, points, reference_type) VALUES (?, 'spent', -2000, 'redemption')").bind(reseller.id).run();
  const status2 = await (await statusMod.onRequestGet({ env, params: { id: reseller.id } })).json();
  assert(status2.current_level.level_name === "gold", "spending points on a reward does NOT affect level standing - still gold, since level only counts 'earned' events");
  assert(status2.spendable_balance === 4000, "the spendable balance correctly reflects the spend (6000-2000=4000)");
  assert(status2.points_this_year === 6000, "CRITICAL: points_this_year for LEVEL purposes stays at 6000 - spending never reduces level standing, got " + status2.points_this_year);

  section("=== A plain customer party is correctly rejected ===");
  const plainCustomer = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  const blockedStatus = await (await statusMod.onRequestGet({ env, params: { id: plainCustomer.id } })).json();
  assert(blockedStatus.error, "requesting reseller status for a plain customer is correctly rejected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
