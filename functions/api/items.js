export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const typeFilter = url.searchParams.get("item_type");

  let query = `
    SELECT i.*, c.name AS category_name, f.name AS fabric_name, w.name AS work_type_name, p.name AS pattern_name
    FROM items i
    LEFT JOIN item_categories c ON c.id = i.category_id
    LEFT JOIN item_fabrics f ON f.id = i.fabric_id
    LEFT JOIN item_work_types w ON w.id = i.work_type_id
    LEFT JOIN item_patterns p ON p.id = i.pattern_id
    WHERE i.active = 1`;
  const params = [];
  if (typeFilter) { query += " AND i.item_type = ?"; params.push(typeFilter); }
  query += " ORDER BY i.created_at DESC";

  const { results } = await env.DB.prepare(query).bind(...params).all();

  // Attach current total stock (sum of lot balances across all sites) and a cover photo.
  const { results: lotSums } = await env.DB.prepare(
    "SELECT item_id, SUM(quantity_balance) AS total_stock FROM item_lots GROUP BY item_id"
  ).all();
  const stockByItem = {};
  for (const row of lotSums) stockByItem[row.item_id] = row.total_stock;

  const { results: photos } = await env.DB.prepare(
    "SELECT item_id, r2_key, uploaded_at FROM item_photos ORDER BY uploaded_at ASC"
  ).all();
  const coverByItem = {};
  for (const p of photos) if (!coverByItem[p.item_id]) coverByItem[p.item_id] = p.r2_key;

  const withExtras = results.map((r) => ({
    ...r,
    total_stock: stockByItem[r.id] || 0,
    cover_photo: coverByItem[r.id] || null,
  }));

  return Response.json(withExtras);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const {
    item_type, name, category_id, fabric_id, work_type_id, pattern_id, design_id,
    color, price, cost, description, unit_of_measure,
  } = body;

  if (!["raw_material", "finished_good"].includes(item_type)) {
    return Response.json({ error: "item_type must be 'raw_material' or 'finished_good'" }, { status: 400 });
  }
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM items").first();
  const id = "ITM-" + String((countRow?.c || 0) + 1).padStart(6, "0");

  let itemCode = null;
  if (category_id && fabric_id && work_type_id && pattern_id) {
    const cat = await env.DB.prepare("SELECT code FROM item_categories WHERE id = ?").bind(category_id).first();
    const fab = await env.DB.prepare("SELECT code FROM item_fabrics WHERE id = ?").bind(fabric_id).first();
    const wrk = await env.DB.prepare("SELECT code FROM item_work_types WHERE id = ?").bind(work_type_id).first();
    const pat = await env.DB.prepare("SELECT code FROM item_patterns WHERE id = ?").bind(pattern_id).first();
    if (cat && fab && wrk && pat) {
      const sameComboCount = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM items WHERE category_id = ? AND fabric_id = ? AND work_type_id = ? AND pattern_id = ?"
      ).bind(category_id, fabric_id, work_type_id, pattern_id).first();
      const seq = String((sameComboCount?.c || 0) + 1).padStart(4, "0");
      itemCode = `FR-${cat.code}-${fab.code}-${wrk.code}-${pat.code}-${seq}`;
    }
  }

  await env.DB.prepare(
    `INSERT INTO items (id, item_type, name, category_id, fabric_id, work_type_id, pattern_id, design_id, item_code, color, price, cost, description, unit_of_measure)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, item_type, name, category_id || null, fabric_id || null, work_type_id || null, pattern_id || null, design_id || null,
    itemCode, color || null, price || null, cost || null, description || null, unit_of_measure || "piece"
  ).run();

  return Response.json({ id, item_code: itemCode });
}
