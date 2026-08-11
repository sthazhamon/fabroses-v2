import { createDispatch } from "./_dispatch.js";
import { genuinelyAvailable } from "./_bom.js";

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { from_site_id, lot_id, quantity, to_site_id } = body;
  if (!from_site_id || !lot_id || !quantity) return Response.json({ error: "from_site_id, lot_id, and quantity are required" }, { status: 400 });

  const check = await genuinelyAvailable(env, lot_id);
  if (!check) return Response.json({ error: "Lot not found" }, { status: 404 });
  const { lot, available } = check;
  if (lot.site_id !== from_site_id) return Response.json({ error: "That lot isn't at the site you specified" }, { status: 400 });
  if (available < quantity) return Response.json({ error: `Only ${available} genuinely available — the rest is already committed to another pending dispatch` }, { status: 400 });

  let storeSiteId = to_site_id;
  if (!storeSiteId) {
    const storeSite = await env.DB.prepare("SELECT id FROM sites WHERE site_type = 'store' LIMIT 1").first();
    if (!storeSite) return Response.json({ error: "No store site exists to return into" }, { status: 400 });
    storeSiteId = storeSite.id;
  }

  // Deliberately NOT tied to a work order — this is genuinely spare stock,
  // possibly leftover across several jobs, not one issue being closed out.
  const dispatchId = await createDispatch(env, {
    dispatch_type: "stock_transfer", from_site_id, to_site_id: storeSiteId,
    items: [{ item_id: lot.item_id, lot_id, expected_quantity: quantity }],
  });

  return Response.json({ dispatch_id: dispatchId });
}
