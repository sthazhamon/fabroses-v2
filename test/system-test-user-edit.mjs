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
  section("=== Editing a user's name/username/role succeeds ===");
  const usersMod = await import("../functions/api/users.js");
  const userDetailMod = await import("../functions/api/users/[id].js");
  const changePinMod = await import("../functions/api/change-my-pin.js");

  const createRes = await (await usersMod.onRequestPost({ request: req({ name: "Ravi Kumar", username: "ravi", pin: "123456", role: "accountant" }), env })).json();
  const editRes = await (await userDetailMod.onRequestPatch({ request: req({ action: "edit", name: "Ravi K", username: "ravik", role: "dispatch" }), env, params: { id: createRes.id } })).json();
  assert(editRes.ok, "editing name, username, and role succeeds");

  const afterEdit = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(createRes.id).first();
  assert(afterEdit.name === "Ravi K" && afterEdit.username === "ravik" && afterEdit.role === "dispatch", "all three fields are correctly saved");

  section("=== A duplicate username on edit is correctly rejected ===");
  await usersMod.onRequestPost({ request: req({ name: "Anu", username: "anu", pin: "123456", role: "accountant" }), env });
  const dupeRes = await (await userDetailMod.onRequestPatch({ request: req({ action: "edit", name: "Ravi K", username: "anu", role: "dispatch" }), env, params: { id: createRes.id } })).json();
  assert(dupeRes.error, "renaming to a username already in use is correctly rejected");

  section("=== Admin reset-PIN still works alongside the new edit action ===");
  const resetRes = await (await userDetailMod.onRequestPatch({ request: req({ action: "reset_pin", new_pin: "999999" }), env, params: { id: createRes.id } })).json();
  assert(resetRes.ok, "admin PIN reset still succeeds");

  section("=== Self-service PIN change requires the correct current PIN ===");
  const wrongCurrentRes = await (await changePinMod.onRequestPost({ request: req({ current_pin: "wrongpin", new_pin: "654321" }), env, data: { user: { id: createRes.id } } })).json();
  assert(wrongCurrentRes.error, "CRITICAL: changing the PIN with the wrong current PIN is correctly rejected");

  const correctChangeRes = await (await changePinMod.onRequestPost({ request: req({ current_pin: "999999", new_pin: "654321" }), env, data: { user: { id: createRes.id } } })).json();
  assert(correctChangeRes.ok, "changing the PIN with the correct current PIN succeeds");

  const authMod = await import("../functions/api/_auth.js");
  const userAfterChange = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(createRes.id).first();
  const newPinValid = await authMod.verifyPin("654321", userAfterChange.pin_salt, userAfterChange.pin_hash);
  assert(newPinValid, "the new PIN is correctly verifiable after the change");

  section("=== A too-short new PIN is correctly rejected ===");
  const shortPinRes = await (await changePinMod.onRequestPost({ request: req({ current_pin: "654321", new_pin: "123" }), env, data: { user: { id: createRes.id } } })).json();
  assert(shortPinRes.error, "a new PIN under the minimum length is correctly rejected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
