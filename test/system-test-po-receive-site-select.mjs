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
  section("=== Setup: two store sites and an outstanding PO line ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const poMod = await import("../functions/api/purchase-orders.js");
  const receiveMod = await import("../functions/api/purchase-order-items/[id]/receive.js");

  const firstStore = await (await sitesMod.onRequestPost({ request: req({ name: "First Store", site_type: "store" }), env })).json();
  const secondStore = await (await sitesMod.onRequestPost({ request: req({ name: "Branch Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Linen" }), env })).json();
  const po = await (await poMod.onRequestPost({ request: req({ supplier_name: "Cotton Threads", items: [{ item_id: item.id, quantity_ordered: 20, rate: 100 }] }), env })).json();
  const line = (await (await poMod.onRequestGet({ env })).json()).find((p) => p.id === po.id).items[0];

  section("=== Explicitly choosing the SECOND store correctly stocks it there, not the first ===");
  const receiveRes = await (await receiveMod.onRequestPost({ request: req({ quantity_received: 20, site_id: secondStore.id }), env, params: { id: line.id } })).json();
  const lot = await env.DB.prepare("SELECT * FROM item_lots WHERE id = ?").bind(receiveRes.lot_id).first();
  assert(lot.site_id === secondStore.id, "CRITICAL: the lot is correctly stocked at the explicitly chosen second store, not silently defaulting to the first");

  const firstStoreStock = await env.DB.prepare("SELECT COUNT(*) AS c FROM item_lots WHERE site_id = ?").bind(firstStore.id).first();
  assert(firstStoreStock.c === 0, "the first store correctly received nothing, confirming the choice was genuinely respected");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
