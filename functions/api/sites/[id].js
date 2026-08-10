export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(params.id).first();
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  if (body.worker_user_id !== undefined) {
    if (site.site_type !== "worker") return Response.json({ error: "Only worker sites can have a user linked" }, { status: 400 });
    if (body.worker_user_id !== null) {
      const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(body.worker_user_id).first();
      if (!user) return Response.json({ error: "That user doesn't exist" }, { status: 404 });
      const existingLink = await env.DB.prepare("SELECT id FROM sites WHERE worker_user_id = ? AND id != ?").bind(body.worker_user_id, params.id).first();
      if (existingLink) return Response.json({ error: "That user is already linked to a different site" }, { status: 400 });
    }
    await env.DB.prepare("UPDATE sites SET worker_user_id = ? WHERE id = ?").bind(body.worker_user_id, params.id).run();
    if (body.worker_user_id !== null) await env.DB.prepare("UPDATE users SET site_id = ? WHERE id = ?").bind(params.id, body.worker_user_id).run();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Nothing to update" }, { status: 400 });
}
