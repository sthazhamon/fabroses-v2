import { reconcileMaterialIssue } from "../../_bom.js";

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  try {
    const result = await reconcileMaterialIssue(env, params.id, body, data.user?.name);
    return Response.json(result);
  } catch (e) {
    if (e.status) return Response.json({ error: e.error }, { status: e.status });
    return Response.json({ error: e.message }, { status: 400 });
  }
}
