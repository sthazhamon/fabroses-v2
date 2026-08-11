import { suggestMaterialReconciliation } from "../../_bom.js";

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  const confirmedQuantity = parseFloat(url.searchParams.get("confirmed_quantity")) || 1;

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });
  if (!dispatch.related_work_order_id) return Response.json({ lines: [] });

  const lines = await suggestMaterialReconciliation(env, dispatch.related_work_order_id, confirmedQuantity);
  return Response.json({ lines });
}
