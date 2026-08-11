import { createDispatch } from "./_dispatch.js";
import { genuinelyAvailable } from "./_bom.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { from_site_id, items, to_site_id } = body;
  if (!from_site_id || !items || !items.length) return Response.json({ error: "from_site_id and at least one item are required" }, { status: 400 });

  let storeSiteId = to_site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to ship into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  const dispatchItems = [];
  for (const line of items) {
    if (!line.lot_id || !line.quantity) return Response.json({ error: "Each item needs a lot_id and quantity" }, { status: 400 });
    const check = await genuinelyAvailable(env, line.lot_id);
    if (!check) return Response.json({ error: `Lot ${line.lot_id} not found` }, { status: 404 });
    const { lot, available } = check;
    if (lot.site_id !== from_site_id) return Response.json({ error: `Lot ${line.lot_id} isn't at the site you specified` }, { status: 400 });
    if (available < line.quantity) return Response.json({ error: `Only ${available} genuinely available for lot ${line.lot_id} — the rest is already committed elsewhere` }, { status: 400 });
    dispatchItems.push({ item_id: lot.item_id, lot_id: line.lot_id, expected_quantity: line.quantity });
  }

  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id, to_site_id: storeSiteId, items: dispatchItems,
  });

  return Response.json({ dispatch_id: dispatchId, item_count: dispatchItems.length });
}
