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
  const { generateSalt, hashPin } = await import("../functions/api/_auth.js");
  const salt = generateSalt();
  const hash = await hashPin("workerpin123", salt);
  await env.DB.prepare("INSERT INTO users (name, username, pin_hash, pin_salt, role, active) VALUES ('Zakir', 'zakir', ?, ?, 'worker', 1)").bind(hash, salt).run();
  const zakir = await env.DB.prepare("SELECT * FROM users WHERE username = 'zakir'").first();

  const sitesMod = await import("../functions/api/sites.js");
  const siteDetailMod = await import("../functions/api/sites/[id].js");

  section("=== A site created via Sites tab with NO user, previously orphaned forever ===");
  const orphanSite = await (await sitesMod.onRequestPost({ request: req({ name: "Orphan Site", site_type: "worker" }), env })).json();
  const orphanRow = (await (await sitesMod.onRequestGet({ env })).json()).find((s) => s.id === orphanSite.id);
  assert(!orphanRow.worker_user_id, "site correctly has no user linked yet");

  section("=== Now attachable after the fact — the capability that was completely missing ===");
  const attachRes = await (await siteDetailMod.onRequestPatch({ request: req({ worker_user_id: zakir.id }), env, params: { id: orphanSite.id } })).json();
  assert(attachRes.ok, "attaching a user to an already-existing site now works");

  const afterAttach = (await (await sitesMod.onRequestGet({ env })).json()).find((s) => s.id === orphanSite.id);
  assert(afterAttach.worker_user_id === zakir.id, "the site now correctly shows the linked user");

  const zakirAfter = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(zakir.id).first();
  assert(zakirAfter.site_id === orphanSite.id, "and the link works both directions — the user record itself points back to this site too");

  section("=== Creating a site WITH an existing user selected, in one step ===");
  await env.DB.prepare("INSERT INTO users (name, username, pin_hash, pin_salt, role, active) VALUES ('Mortaja', 'mortaja', ?, ?, 'worker', 1)").bind(hash, salt).run();
  const mortaja = await env.DB.prepare("SELECT * FROM users WHERE username = 'mortaja'").first();
  const linkedSite = await (await sitesMod.onRequestPost({ request: req({ name: "Mortaja Site", site_type: "worker", worker_user_id: mortaja.id }), env })).json();
  const linkedRow = (await (await sitesMod.onRequestGet({ env })).json()).find((s) => s.id === linkedSite.id);
  assert(linkedRow.worker_user_id === mortaja.id, "one-step creation with an existing user selected works correctly");

  section("=== Can't link the same user to two different sites ===");
  const duplicateAttempt = await (await siteDetailMod.onRequestPatch({ request: req({ worker_user_id: mortaja.id }), env, params: { id: orphanSite.id } })).json();
  assert(duplicateAttempt.error, "attaching an already-linked user to a second site is rejected");

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
