export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, c.name AS category_name, f.name AS fabric_name, w.name AS work_type_name, p.name AS pattern_name
     FROM item_designs d
     LEFT JOIN item_categories c ON c.id = d.default_category_id
     LEFT JOIN item_fabrics f ON f.id = d.default_fabric_id
     LEFT JOIN item_work_types w ON w.id = d.default_work_type_id
     LEFT JOIN item_patterns p ON p.id = d.default_pattern_id
     ORDER BY d.name ASC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  try {
    const res = await env.DB.prepare(
      `INSERT INTO item_designs (name, description, default_category_id, default_fabric_id, default_work_type_id, default_pattern_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      name, body.description || null, body.default_category_id || null,
      body.default_fabric_id || null, body.default_work_type_id || null, body.default_pattern_id || null
    ).run();
    return Response.json({ id: res.meta.last_row_id });
  } catch (e) {
    return Response.json({ error: "That design name is already in use" }, { status: 400 });
  }
}
