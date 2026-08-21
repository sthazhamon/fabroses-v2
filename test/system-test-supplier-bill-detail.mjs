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
  section("=== The bill detail endpoint returns line items with tax ===");
  const itemsMod = await import("../functions/api/items.js");
  const sbMod = await import("../functions/api/supplier-bills.js");
  const sbDetailMod = await import("../functions/api/supplier-bills/[id].js");

  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const billRes = await (await sbMod.onRequestPost({
    request: req({ supplier_name: "Cotton Threads", bill_date: "2026-08-01", lines: [{ item_id: item.id, quantity: 10, rate: 100, tax_rate: 12 }] }), env, data: {},
  })).json();

  const detail = await (await sbDetailMod.onRequestGet({ env, params: { id: billRes.id } })).json();
  assert(detail.supplier_name === "Cotton Threads", "the bill's own header fields are correctly returned");
  assert(detail.items.length === 1, "the line item is correctly included");
  assert(detail.items[0].item_name === "Linen" && detail.items[0].rate === 100 && detail.items[0].tax_rate === 12, "the line's item name, rate, and tax rate are correctly resolved");

  section("=== A non-existent bill is handled cleanly ===");
  const missingRes = await (await sbDetailMod.onRequestGet({ env, params: { id: "SBILL-999999" } })).json();
  assert(missingRes.error, "requesting a bill that doesn't exist returns a clean error, not a crash");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
