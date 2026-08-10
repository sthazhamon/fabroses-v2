export async function onRequestGet({ env, params }) {
  const dispatch = await env.DB.prepare("SELECT courier, tracking_id FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });
  const { results: notes } = await env.DB.prepare("SELECT * FROM dispatch_tracking_notes WHERE dispatch_id = ? ORDER BY created_at ASC").bind(params.id).all();
  return Response.json({ original: dispatch, notes });
}

export async function onRequestPost({ request, env, params, data }) {
  const body = await request.json();
  const { courier, tracking_id, note } = body;
  if (!courier && !tracking_id && !note) return Response.json({ error: "Provide a courier, tracking_id, or note" }, { status: 400 });

  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });

  // First time tracking gets entered for this dispatch — this becomes the
  // permanent, locked original. Everything after this point is a note,
  // never an overwrite of these two fields.
  if (!dispatch.courier && !dispatch.tracking_id) {
    await env.DB.prepare("UPDATE dispatches SET courier = ?, tracking_id = ? WHERE id = ?").bind(courier || null, tracking_id || null, params.id).run();
    return Response.json({ ok: true, locked_original: true });
  }

  await env.DB.prepare("INSERT INTO dispatch_tracking_notes (dispatch_id, courier, tracking_id, note, created_by) VALUES (?, ?, ?, ?, ?)")
    .bind(params.id, courier || null, tracking_id || null, note || null, data.user?.name || "unknown").run();

  return Response.json({ ok: true, locked_original: false });
}
