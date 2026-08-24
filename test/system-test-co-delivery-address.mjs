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
  section("=== A CO can be created with a delivery address different from the party's own ===");
  const itemsMod = await import("../functions/api/items.js");
  const partiesMod = await import("../functions/api/parties.js");
  const coMod = await import("../functions/api/customer-orders.js");

  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Saree" }), env })).json();
  const party = await (await partiesMod.onRequestPost({ request: req({ name: "Susan", type: "customer", address: "12 MG Road, Kochi" }), env })).json();

  const co = await (await coMod.onRequestPost({ request: req({ customer_party_id: party.id, customer_name: "Susan", delivery_address: "Gift address: 5 Beach Road, Kovalam", items: [{ item_id: item.id, quantity: 1 }] }), env })).json();

  const stored = await env.DB.prepare("SELECT delivery_address FROM customer_orders WHERE id = ?").bind(co.id).first();
  assert(stored.delivery_address === "Gift address: 5 Beach Road, Kovalam", "CRITICAL: a delivery address different from the party's own default is correctly stored");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
