async function nextId(env, table, prefix, pad = 6) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
  return `${prefix}-` + String((row?.c || 0) + 1).padStart(pad, "0");
}

function deriveStatus(items) {
  const isLineComplete = (i) => i.quantity_received >= i.quantity_ordered || i.status === "short_closed";
  if (items.every(isLineComplete)) return "received";
  if (items.some((i) => i.quantity_received > 0)) return "partially_received";
  return "ordered";
}

export async function onRequestGet({ request, env }) {
  const url = request ? new URL(request.url) : null;
  const supplierPartyId = url?.searchParams.get("supplier_party_id");
  const from = url?.searchParams.get("from");
  const to = url?.searchParams.get("to");
  const includeClosed = url ? url.searchParams.get("include_closed") === "true" : true;

  const conditions = [];
  const params = [];
  if (supplierPartyId) { conditions.push("supplier_party_id = ?"); params.push(supplierPartyId); }
  if (from) { conditions.push("date(created_at) >= date(?)"); params.push(from); }
  if (to) { conditions.push("date(created_at) <= date(?)"); params.push(to); }
  const whereClause = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const { results: orders } = await env.DB.prepare(`SELECT * FROM purchase_orders ${whereClause} ORDER BY created_at DESC`).bind(...params).all();

  if (!orders.length) return Response.json([]);

  const poIds = orders.map((po) => po.id);
  const poPlaceholders = poIds.map(() => "?").join(",");
  const { results: allItems } = await env.DB.prepare(
    `SELECT poi.*, i.name AS item_name FROM purchase_order_items poi LEFT JOIN items i ON i.id = poi.item_id WHERE poi.purchase_order_id IN (${poPlaceholders})`
  ).bind(...poIds).all();

  const billedByLineId = {};
  if (allItems.length) {
    const lineIds = allItems.map((l) => l.id);
    const linePlaceholders = lineIds.map(() => "?").join(",");
    const { results: billedRows } = await env.DB.prepare(
      `SELECT purchase_order_item_id, COALESCE(SUM(quantity),0) AS t FROM supplier_bill_items WHERE purchase_order_item_id IN (${linePlaceholders}) GROUP BY purchase_order_item_id`
    ).bind(...lineIds).all();
    for (const row of billedRows) billedByLineId[row.purchase_order_item_id] = row.t;
  }

  const itemsByPo = {};
  for (const line of allItems) {
    line.quantity_billed = billedByLineId[line.id] || 0;
    if (!itemsByPo[line.purchase_order_id]) itemsByPo[line.purchase_order_id] = [];
    itemsByPo[line.purchase_order_id].push(line);
  }

  const withItems = [];
  for (const po of orders) {
    const items = itemsByPo[po.id] || [];
    const trueStatus = deriveStatus(items);
    // The raw stored status column never actually reflects real state (it's
    // only ever computed at read time), so "open vs closed" must be judged
    // here, after computing the true status, not via a SQL WHERE clause.
    if (!includeClosed && trueStatus === "received" && po.bill_status === "billed") continue;
    withItems.push({ ...po, items, status: trueStatus });
  }
  return Response.json(withItems);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { supplier_party_id, supplier_name, expected_date, notes, items } = body;
  if (!supplier_name || !items || !items.length) {
    return Response.json({ error: "supplier_name and at least one line item are required" }, { status: 400 });
  }
  for (const item of items) {
    if (!item.item_id || !item.quantity_ordered) return Response.json({ error: "Each line needs item_id and quantity_ordered" }, { status: 400 });
    const exists = await env.DB.prepare("SELECT id FROM items WHERE id = ?").bind(item.item_id).first();
    if (!exists) return Response.json({ error: `Item ${item.item_id} not found` }, { status: 404 });
  }

  const id = await nextId(env, "purchase_orders", "PO");
  await env.DB.prepare("INSERT INTO purchase_orders (id, supplier_party_id, supplier_name, expected_date, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, supplier_party_id || null, supplier_name, expected_date || null, notes || null).run();

  for (const item of items) {
    await env.DB.prepare("INSERT INTO purchase_order_items (purchase_order_id, item_id, quantity_ordered, rate) VALUES (?, ?, ?, ?)")
      .bind(id, item.item_id, item.quantity_ordered, item.rate || null).run();
  }

  return Response.json({ id });
}
