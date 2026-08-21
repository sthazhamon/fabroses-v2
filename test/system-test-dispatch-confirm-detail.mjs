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
  section("=== Dispatch detail now includes description and item photo ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const { createDispatch } = await import("../functions/api/_dispatch.js");
  const dispatchDetailMod = await import("../functions/api/dispatches/[id].js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const worker = await (await sitesMod.onRequestPost({ request: req({ name: "Zakir", site_type: "worker" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota", description: "Handwoven cotton" }), env })).json();
  await env.DB.prepare("INSERT INTO item_photos (item_id, r2_key) VALUES (?, ?)").bind(item.id, "photos/kota-sample.jpg").run();
  const lot = await (await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} })).json();

  const dispatchId = await createDispatch(env, { dispatch_type: "stock_transfer", from_site_id: store.id, to_site_id: worker.id, items: [{ item_id: item.id, lot_id: lot.id, expected_quantity: 5 }] });
  const detail = await (await dispatchDetailMod.onRequestGet({ params: { id: dispatchId }, env })).json();

  assert(detail.items[0].item_description === "Handwoven cotton", "the item's description is now correctly included");
  assert(detail.items[0].item_photo_key === "photos/kota-sample.jpg", "CRITICAL: the item's own catalogue photo key is correctly included");
  assert(detail.items[0].resolved_origin === lot.id, "the resolved origin is still correctly included alongside the new fields");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
