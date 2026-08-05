import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapD1, makeFakeR2 } from "./d1-shim.mjs";

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); } else { failed++; console.log(`  \x1b[31m✗ FAIL\x1b[0m ${l}`); } }
function section(t) { console.log(`\n${t}`); }

const sqliteDb = new DatabaseSync(":memory:");
sqliteDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const env = { DB: wrapD1(sqliteDb), PHOTOS: makeFakeR2(), AUTH_SECRET: "test-secret" };
function req(b) { return { json: async () => b }; }

async function run() {
  section("=== Worker site created via Sites tab gets a linked party ===");
  const sitesMod = await import("../functions/api/sites.js");
  const site1 = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  assert(site1.worker_party_id, "site creation returned a worker_party_id");
  const party1 = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(site1.worker_party_id).first();
  assert(party1 && party1.type === "worker" && party1.name === "Zakir", "the party actually exists, correctly typed, correctly named");

  section("=== Worker site created via Users tab ALSO gets a linked party (same helper) ===");
  const usersMod = await import("../functions/api/users.js");
  const userRes = await (await usersMod.onRequestPost({ request: req({ name: "Mortaja", username: "mortaja", pin: "pin123456", role: "worker", create_worker_site: true }), env })).json();
  const site2 = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(userRes.site_id).first();
  assert(site2.worker_party_id, "the site created via Users ALSO has a worker_party_id — no drift between the two entry points");
  const party2 = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(site2.worker_party_id).first();
  assert(party2 && party2.type === "worker", "and that party is real and correctly typed");

  section("=== Duplicate worker names don't collide ===");
  const site3 = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const party3 = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(site3.worker_party_id).first();
  assert(party3.name !== "Zakir" && party3.name.includes("Zakir"), `a second worker named "Zakir" gets a disambiguated party name instead of failing (got "${party3.name}")`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
