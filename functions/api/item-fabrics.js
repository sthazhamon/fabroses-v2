function suggestCode(name) {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return letters.slice(0, 3).padEnd(3, "X");
}
export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM item_fabrics ORDER BY name ASC").all();
  return Response.json(results);
}
export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  let code = (body.code || suggestCode(name)).toUpperCase().slice(0, 3);
  if (code.length < 3) code = code.padEnd(3, "X");
  try {
    const res = await env.DB.prepare("INSERT INTO item_fabrics (name, code) VALUES (?, ?)").bind(name, code).run();
    return Response.json({ id: res.meta.last_row_id, code });
  } catch (e) {
    return Response.json({ error: "That name or code is already used — try a different one" }, { status: 400 });
  }
}
