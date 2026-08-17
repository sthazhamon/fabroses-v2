export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  if (body.active == null) return Response.json({ error: "active is required" }, { status: 400 });
  await env.DB.prepare("UPDATE reseller_reward_items SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, params.id).run();
  return Response.json({ ok: true });
}
