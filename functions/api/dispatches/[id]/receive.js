import { confirmReceive } from "../../_dispatch.js";

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { confirmations } = body;
  if (!confirmations || !confirmations.length) {
    return Response.json({ error: "confirmations (array of {dispatch_item_id, received_quantity}) is required" }, { status: 400 });
  }
  const result = await confirmReceive(env, params.id, confirmations, data.user?.name);
  if (result.error) return Response.json(result, { status: 400 });
  return Response.json(result);
}
