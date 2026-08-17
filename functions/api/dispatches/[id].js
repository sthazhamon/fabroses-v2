export async function onRequestGet({ params, env }) {
  const dispatch = await env.DB.prepare(
    `SELECT d.*, fs.name AS from_site_name, ts.name AS to_site_name
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     WHERE d.id = ?`
  ).bind(params.id).first();
  if (!dispatch) return Response.json({ error: "not found" }, { status: 404 });

  const { results: items } = await env.DB.prepare(
    `SELECT di.*, i.name AS item_name, i.item_code, COALESCE(l.origin_lot_id, l.id) AS resolved_origin
     FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id LEFT JOIN item_lots l ON l.id = di.lot_id
     WHERE di.dispatch_id = ?`
  ).bind(params.id).all();

  return Response.json({ ...dispatch, items });
}

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE id = ?").bind(params.id).first();
  if (!dispatch) return Response.json({ error: "Dispatch not found" }, { status: 404 });

  if (body.courier !== undefined || body.tracking_id !== undefined) {
    return Response.json({ error: "Tracking info is added through /dispatches/:id/tracking now, not edited directly here — the original entry stays locked, corrections go in as notes." }, { status: 400 });
  }

  return Response.json({ error: "Nothing to update" }, { status: 400 });
}
