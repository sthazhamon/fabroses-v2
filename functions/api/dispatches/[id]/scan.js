import { confirmPick } from "../../_dispatch.js";

export async function onRequestPost({ request, env, params }) {
  const body = await request.json();
  if (!body.item_id || body.scanned_quantity == null) {
    return Response.json({ error: "item_id and scanned_quantity are required" }, { status: 400 });
  }
  const result = await confirmPick(env, params.id, body);
  if (result.error) return Response.json(result, { status: result.mismatch ? 409 : 400 });
  return Response.json(result);
}
