export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const existing = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(params.id).first();
  if (!existing) return Response.json({ error: "Party not found" }, { status: 404 });

  const updates = [];
  const values = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return Response.json({ error: "Name can't be empty" }, { status: 400 });
    const nameClash = await env.DB.prepare("SELECT id FROM parties WHERE name = ? AND id != ?").bind(body.name.trim(), params.id).first();
    if (nameClash) return Response.json({ error: "Another party already uses that name" }, { status: 400 });
    updates.push("name = ?"); values.push(body.name.trim());
  }
  if (body.type !== undefined) { updates.push("type = ?"); values.push(body.type); }
  if (body.phone !== undefined) { updates.push("phone = ?"); values.push(body.phone || null); }
  if (body.address !== undefined) { updates.push("address = ?"); values.push(body.address || null); }
  if (body.notes !== undefined) { updates.push("notes = ?"); values.push(body.notes || null); }
  if (body.manual_level_override !== undefined) { updates.push("manual_level_override = ?"); values.push(body.manual_level_override || null); }

  if (!updates.length) return Response.json({ error: "Nothing to update" }, { status: 400 });

  values.push(params.id);
  await env.DB.prepare(`UPDATE parties SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
  return Response.json({ ok: true });
}
