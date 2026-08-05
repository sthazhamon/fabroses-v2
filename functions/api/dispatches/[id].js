export async function onRequestGet({ params, env }) {
  const dispatch = await env.DB.prepare(
    `SELECT d.*, fs.name AS from_site_name, ts.name AS to_site_name
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     WHERE d.id = ?`
  ).bind(params.id).first();
  if (!dispatch) return Response.json({ error: "not found" }, { status: 404 });

  const { results: items } = await env.DB.prepare(
    `SELECT di.*, i.name AS item_name, i.item_code FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id WHERE di.dispatch_id = ?`
  ).bind(params.id).all();

  return Response.json({ ...dispatch, items });
}

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });

  const changes = {};
  if (body.courier !== undefined) changes.courier = body.courier;
  if (body.tracking_id !== undefined) changes.tracking_id = body.tracking_id;
  if (!Object.keys(changes).length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  const setClauses = Object.keys(changes).map((f) => `${f} = ?`).join(", ");
  await env.DB.prepare(`UPDATE dispatches SET ${setClauses} WHERE id = ?`).bind(...Object.values(changes), params.id).run();
  return Response.json({ ok: true });
}
