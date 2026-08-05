export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM expense_categories ORDER BY name ASC").all();
  return Response.json(results);
}
export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  try {
    const res = await env.DB.prepare("INSERT INTO expense_categories (name) VALUES (?)").bind(name).run();
    return Response.json({ id: res.meta.last_row_id });
  } catch (e) {
    return Response.json({ error: "That category already exists" }, { status: 400 });
  }
}
