import { nextId, createWorkerSite } from "./_ledger.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, u.name AS worker_name, u.username AS worker_username
     FROM sites s LEFT JOIN users u ON u.id = s.worker_user_id
     WHERE s.active = 1 ORDER BY s.site_type ASC, s.name ASC`
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { name, site_type, worker_user_id, address, notes } = body;
  const validTypes = ["store", "worker"];

  if (!name || !validTypes.includes(site_type)) {
    return Response.json({ error: `name and a valid site_type (${validTypes.join(", ")}) are required` }, { status: 400 });
  }

  if (site_type === "worker") {
    if (worker_user_id) {
      const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(worker_user_id).first();
      if (!user) return Response.json({ error: "worker_user_id does not match an existing user" }, { status: 404 });
      const existingLink = await env.DB.prepare("SELECT id FROM sites WHERE worker_user_id = ?").bind(worker_user_id).first();
      if (existingLink) return Response.json({ error: "That user is already linked to a different site" }, { status: 400 });
    }
    const { siteId, partyId } = await createWorkerSite(env, { name, worker_user_id });
    if (address || notes) await env.DB.prepare("UPDATE sites SET address = ?, notes = ? WHERE id = ?").bind(address || null, notes || null, siteId).run();
    return Response.json({ id: siteId, worker_party_id: partyId });
  }

  const id = await nextId(env, "sites", "SITE");
  await env.DB.prepare("INSERT INTO sites (id, name, site_type, address, notes) VALUES (?, ?, 'store', ?, ?)")
    .bind(id, name, address || null, notes || null).run();
  return Response.json({ id });
}
