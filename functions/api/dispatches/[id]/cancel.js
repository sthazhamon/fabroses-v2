export async function onRequestPost({ env, params }) {
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });
  if (dispatch.status !== "pending_pick") {
    return Response.json({ error: `Can't cancel — this dispatch is already "${dispatch.status}". Cancellation is only available before anything's been picked.` }, { status: 400 });
  }
  await env.DB.prepare("UPDATE dispatches SET status = 'cancelled' WHERE id = ?").bind(params.id).run();
  return Response.json({ ok: true });
}
