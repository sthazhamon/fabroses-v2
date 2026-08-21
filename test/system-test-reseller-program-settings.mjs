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
  section("=== Defaults are returned when nothing has been configured yet ===");
  const settingsMod = await import("../functions/api/reseller-program-settings.js");
  const defaults = await (await settingsMod.onRequestGet({ env })).json();
  assert(defaults.earn_rate_per_rupee === 1 && defaults.level_window_days === 90 && defaults.redeem_rate_per_point === 0.5, "sensible defaults are correctly returned before any configuration");

  section("=== Saving new settings correctly persists all three ===");
  await settingsMod.onRequestPost({ request: req({ earn_rate_per_rupee: 2, level_window_days: 60, redeem_rate_per_point: 0.75 }), env });
  const updated = await (await settingsMod.onRequestGet({ env })).json();
  assert(updated.earn_rate_per_rupee === 2 && updated.level_window_days === 60 && updated.redeem_rate_per_point === 0.75, "CRITICAL: all three settings are correctly saved and read back together");

  section("=== Updating just one setting leaves the others untouched ===");
  await settingsMod.onRequestPost({ request: req({ earn_rate_per_rupee: 3 }), env });
  const partial = await (await settingsMod.onRequestGet({ env })).json();
  assert(partial.earn_rate_per_rupee === 3 && partial.level_window_days === 60 && partial.redeem_rate_per_point === 0.75, "updating one setting correctly leaves the other two exactly as they were");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
