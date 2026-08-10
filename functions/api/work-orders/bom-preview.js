import { suggestBomLines } from "../_bom.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const intendedItemId = url.searchParams.get("intended_item_id");
  const targetQuantity = parseFloat(url.searchParams.get("target_quantity")) || 1;
  const workerSiteId = url.searchParams.get("worker_site_id");
  if (!intendedItemId || !workerSiteId) return Response.json({ error: "intended_item_id and worker_site_id are required" }, { status: 400 });

  const suggestions = await suggestBomLines(env, intendedItemId, targetQuantity, workerSiteId);
  return Response.json({ lines: suggestions });
}
