export async function onRequestGet({ params, env }) {
  const dispatch = await env.DB.prepare(
    `SELECT d.*, fs.name AS from_site_name, ts.name AS to_site_name, ts.address AS to_site_address
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     WHERE d.id = ?`
  ).bind(params.id).first();
  if (!dispatch) return Response.json({ error: "not found" }, { status: 404 });

  let shippingAddress = dispatch.to_site_address || null;
  let shippingName = dispatch.to_site_name || null;
  if (dispatch.dispatch_type === "customer_shipment" && dispatch.related_customer_order_id) {
    const co = await env.DB.prepare(
      `SELECT co.delivery_address, co.customer_name, co.reseller_name, co.customer_phone, p.address AS party_address
       FROM customer_orders co LEFT JOIN parties p ON p.id = co.customer_party_id
       WHERE co.id = ?`
    ).bind(dispatch.related_customer_order_id).first();
    if (co) {
      shippingAddress = co.delivery_address || co.party_address || null;
      shippingName = co.customer_name || co.reseller_name || null;
    }
  } else if (dispatch.dispatch_type === "customer_shipment" && dispatch.related_sale_id) {
    const sale = await env.DB.prepare(
      `SELECT s.customer_name, s.reseller_name, p.name AS party_name, p.address AS party_address
       FROM sales s LEFT JOIN parties p ON p.id = s.customer_party_id
       WHERE s.id = ?`
    ).bind(dispatch.related_sale_id).first();
    if (sale) {
      shippingAddress = sale.party_address || null;
      shippingName = sale.customer_name || sale.reseller_name || sale.party_name || null;
    }
  }

  const { results: items } = await env.DB.prepare(
    `SELECT di.*, i.name AS item_name, i.item_code, i.description AS item_description,
            COALESCE(l.origin_lot_id, l.id) AS resolved_origin,
            (SELECT ip.r2_key FROM item_photos ip WHERE ip.item_id = di.item_id ORDER BY ip.uploaded_at ASC LIMIT 1) AS item_photo_key
     FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id LEFT JOIN item_lots l ON l.id = di.lot_id
     WHERE di.dispatch_id = ?`
  ).bind(params.id).all();

  return Response.json({ ...dispatch, shipping_name: shippingName, shipping_address: shippingAddress, items });
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
