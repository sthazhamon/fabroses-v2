import { shipDispatch } from "../../_dispatch.js";

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const result = await shipDispatch(env, params.id, body, data.user?.name);
  if (result.error) return Response.json(result, { status: 400 });
  return Response.json(result);
}
