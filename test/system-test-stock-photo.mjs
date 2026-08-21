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
  section("=== Stock-by-site now includes the item's photo and the lot's receipt date ===");
  const sitesMod = await import("../functions/api/sites.js");
  const itemsMod = await import("../functions/api/items.js");
  const lotsMod = await import("../functions/api/item-lots.js");
  const stockMod = await import("../functions/api/stock-by-site.js");

  const store = await (await sitesMod.onRequestPost({ request: req({ name: "Store", site_type: "store" }), env })).json();
  const item = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Kota" }), env })).json();
  await env.DB.prepare("INSERT INTO item_photos (item_id, r2_key) VALUES (?, ?)").bind(item.id, "photos/kota.jpg").run();
  await lotsMod.onRequestPost({ request: req({ item_id: item.id, site_id: store.id, quantity: 10, source_type: "direct_intake" }), env, data: {} });

  const res = await (await stockMod.onRequestGet({ env })).json();
  const storeEntry = res.sites.find((s) => s.site.id === store.id);
  assert(storeEntry.lots[0].item_photo_key === "photos/kota.jpg", "CRITICAL: the lot correctly includes the item's own catalogue photo key");
  assert(storeEntry.lots[0].created_at, "the receipt date is correctly present on each lot");

  section("=== An item with no photo correctly returns null, not an error ===");
  const itemNoPhoto = await (await itemsMod.onRequestPost({ request: req({ item_type: "raw_material", name: "Silk" }), env })).json();
  await lotsMod.onRequestPost({ request: req({ item_id: itemNoPhoto.id, site_id: store.id, quantity: 5, source_type: "direct_intake" }), env, data: {} });
  const res2 = await (await stockMod.onRequestGet({ env })).json();
  const storeEntry2 = res2.sites.find((s) => s.site.id === store.id);
  const noPhotoLot = storeEntry2.lots.find((l) => l.item_id === itemNoPhoto.id);
  assert(noPhotoLot.item_photo_key === null, "an item with no uploaded photo correctly shows null, not an error");

  console.log("\n" + passed + " passed, " + failed + " failed\n");
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("CRASHED:", e); process.exit(1); });
