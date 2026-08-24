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
function getReq(qs) { return { url: "https://x/api/items" + qs }; }

async function run() {
  section("=== Setup: two items with different categories and fabrics ===");
  const itemsMod = await import("../functions/api/items.js");

  const catRes = await env.DB.prepare("INSERT INTO item_categories (name, code) VALUES ('Saree', 'SAR')").run();
  const catId = catRes.meta.last_row_id;
  const fabricRes = await env.DB.prepare("INSERT INTO item_fabrics (name, code) VALUES ('Cotton', 'COT')").run();
  const fabricId = fabricRes.meta.last_row_id;

  const itemA = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Cotton Saree", category_id: catId, fabric_id: fabricId }), env })).json();
  const itemB = await (await itemsMod.onRequestPost({ request: req({ item_type: "finished_good", name: "Silk Dupatta" }), env })).json();

  section("=== Filtering by category correctly narrows results ===");
  const byCategoryRes = await (await itemsMod.onRequestGet({ request: getReq("?category_id=" + catId), env })).json();
  assert(byCategoryRes.length === 1 && byCategoryRes[0].id === itemA.id, "filtering by category correctly returns only the matching item");

  section("=== Filtering by fabric correctly narrows results ===");
  const byFabricRes = await (await itemsMod.onRequestGet({ request: getReq("?fabric_id=" + fabricId), env })).json();
  assert(byFabricRes.length === 1 && byFabricRes[0].id === itemA.id, "filtering by fabric correctly returns only the matching item");

  section("=== A filter matching nothing correctly returns empty, not an error ===");
  const noMatchRes = await (await itemsMod.onRequestGet({ request: getReq("?category_id=999999"), env })).json();
  assert(noMatchRes.length === 0, "a category with no matching items correctly returns an empty list");

  section("=== No filters still returns everything ===");
  const allRes = await (await itemsMod.onRequestGet({ request: getReq(""), env })).json();
  assert(allRes.length === 2, "with no filters applied, both items are correctly returned");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
