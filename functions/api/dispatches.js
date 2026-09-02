import { createDispatch } from "./_dispatch.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, fs.name AS from_site_name, ts.name AS to_site_name
     FROM dispatches d LEFT JOIN sites fs ON fs.id = d.from_site_id LEFT JOIN sites ts ON ts.id = d.to_site_id
     ORDER BY d.created_at DESC`
  ).all();

  if (results.length) {
    const dispatchIds = results.map((d) => d.id);
    const placeholders = dispatchIds.map(() => "?").join(",");
    const { results: allItems } = await env.DB.prepare(
      `SELECT di.dispatch_id, di.expected_quantity, di.scanned_quantity, di.received_quantity, di.receive_mismatch_flag, i.name AS item_name
       FROM dispatch_items di LEFT JOIN items i ON i.id = di.item_id WHERE di.dispatch_id IN (${placeholders})`
    ).bind(...dispatchIds).all();

    const itemsByDispatch = {};
    for (const item of allItems) {
      if (!itemsByDispatch[item.dispatch_id]) itemsByDispatch[item.dispatch_id] = [];
      itemsByDispatch[item.dispatch_id].push(item);
    }

    // Resolve shipping name for customer_shipment dispatches too - batched
    // in two grouped queries (one for CO-linked, one for direct-sale-linked)
    // rather than a lookup per dispatch, so identifying which shipment is
    // which doesn't require clicking into each one individually.
    const coIds = [...new Set(results.filter((d) => d.related_customer_order_id).map((d) => d.related_customer_order_id))];
    const saleIds = [...new Set(results.filter((d) => d.related_sale_id).map((d) => d.related_sale_id))];
    const nameByCo = {};
    const nameBySale = {};
    if (coIds.length) {
      const coPlaceholders = coIds.map(() => "?").join(",");
      const { results: coRows } = await env.DB.prepare(`SELECT id, customer_name, reseller_name FROM customer_orders WHERE id IN (${coPlaceholders})`).bind(...coIds).all();
      for (const co of coRows) nameByCo[co.id] = co.customer_name || co.reseller_name;
    }
    if (saleIds.length) {
      const salePlaceholders = saleIds.map(() => "?").join(",");
      const { results: saleRows } = await env.DB.prepare(
        `SELECT s.id, s.customer_name, s.reseller_name, p.name AS party_name FROM sales s LEFT JOIN parties p ON p.id = s.customer_party_id WHERE s.id IN (${salePlaceholders})`
      ).bind(...saleIds).all();
      for (const sale of saleRows) nameBySale[sale.id] = sale.customer_name || sale.reseller_name || sale.party_name;
    }

    for (const dispatch of results) {
      const items = itemsByDispatch[dispatch.id] || [];
      dispatch.item_summary = items.map((i) => `${i.item_name || "?"} (${i.scanned_quantity ?? i.expected_quantity})`).join(", ");
      dispatch.has_receive_mismatch = items.some((i) => i.receive_mismatch_flag === 1);
      if (dispatch.related_customer_order_id) dispatch.shipping_name = nameByCo[dispatch.related_customer_order_id] || null;
      else if (dispatch.related_sale_id) dispatch.shipping_name = nameBySale[dispatch.related_sale_id] || null;
    }
  }

  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id, related_sale_id } = body;

  const validTypes = ["customer_shipment", "stock_transfer", "return_shipment"];
  if (!validTypes.includes(dispatch_type) || !items || !items.length) {
    return Response.json({ error: `dispatch_type (${validTypes.join(", ")}) and at least one item are required` }, { status: 400 });
  }

  const id = await createDispatch(env, { dispatch_type, from_site_id, to_site_id, items, related_work_order_id, related_customer_order_id, related_purchase_order_id, related_sale_id });
  return Response.json({ id });
}
