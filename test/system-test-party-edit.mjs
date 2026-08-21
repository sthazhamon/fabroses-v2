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
  section("=== Editing a party's basic details succeeds ===");
  const partiesMod = await import("../functions/api/parties.js");
  const partyDetailMod = await import("../functions/api/parties/[id].js");

  const party = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer" }), env })).json();
  const editRes = await (await partyDetailMod.onRequestPatch({ request: req({ name: "Susan Roy", phone: "9999999999", notes: "Prefers cash" }), env, params: { id: party.id } })).json();
  assert(editRes.ok, "editing name, phone, and notes succeeds");

  const afterEdit = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(party.id).first();
  assert(afterEdit.name === "Susan Roy" && afterEdit.phone === "9999999999" && afterEdit.notes === "Prefers cash", "all three fields are correctly saved");

  section("=== Changing type from customer to reseller is allowed ===");
  const typeChangeRes = await (await partyDetailMod.onRequestPatch({ request: req({ type: "reseller" }), env, params: { id: party.id } })).json();
  assert(typeChangeRes.ok, "changing party type succeeds");
  const afterTypeChange = await env.DB.prepare("SELECT type FROM parties WHERE id = ?").bind(party.id).first();
  assert(afterTypeChange.type === "reseller", "the type is correctly updated");

  section("=== A duplicate name is correctly rejected ===");
  const otherParty = await (await partiesMod.onRequestPost({ request: req({ name: "Anu", type: "customer" }), env })).json();
  const dupeRes = await (await partyDetailMod.onRequestPatch({ request: req({ name: "Anu" }), env, params: { id: party.id } })).json();
  assert(dupeRes.error, "renaming to a name already used by another party is correctly rejected");

  section("=== An empty name is correctly rejected ===");
  const emptyRes = await (await partyDetailMod.onRequestPatch({ request: req({ name: "   " }), env, params: { id: party.id } })).json();
  assert(emptyRes.error, "an empty/whitespace-only name is correctly rejected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
