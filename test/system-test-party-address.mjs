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
  section("=== Address can be set on party creation ===");
  const partiesMod = await import("../functions/api/parties.js");
  const partyDetailMod = await import("../functions/api/parties/[id].js");

  const party = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer", address: "12 MG Road, Kochi" }), env })).json();
  const stored = await env.DB.prepare("SELECT address FROM parties WHERE id = ?").bind(party.id).first();
  assert(stored.address === "12 MG Road, Kochi", "the address is correctly stored at creation time");

  section("=== Address can be updated via edit ===");
  await partyDetailMod.onRequestPatch({ request: req({ address: "45 Marine Drive, Kochi" }), env, params: { id: party.id } });
  const updated = await env.DB.prepare("SELECT address FROM parties WHERE id = ?").bind(party.id).first();
  assert(updated.address === "45 Marine Drive, Kochi", "the address is correctly updated via the edit endpoint");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
