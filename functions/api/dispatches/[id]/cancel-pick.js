import { cancelPick } from "../../_dispatch.js";

export async function onRequestPost({ env, params }) {
  const result = await cancelPick(env, params.id);
  if (result.error) return Response.json(result, { status: 400 });
  return Response.json(result);
}
