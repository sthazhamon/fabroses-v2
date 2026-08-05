import { generateSalt, hashPin } from "./_auth.js";
import { createWorkerSite } from "./_ledger.js";

const VALID_ROLES = ["admin", "accountant", "worker", "dispatch", "reseller"];
const MIN_PIN_LENGTH = 6;

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, username, role, reseller_party_id, site_id, active, last_login_at, created_at FROM users ORDER BY id"
  ).all();
  return Response.json(results);
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const name = (body.name || "").trim();
  const username = (body.username || "").trim().toLowerCase();
  const pin = body.pin || "";
  const role = body.role;
  const resellerPartyId = body.reseller_party_id || null;
  const createSite = body.create_worker_site;

  if (!name || !username || !VALID_ROLES.includes(role)) {
    return Response.json({ error: `name, username, and a valid role (${VALID_ROLES.join(", ")}) are required` }, { status: 400 });
  }
  if (pin.length < MIN_PIN_LENGTH) return Response.json({ error: `PIN must be at least ${MIN_PIN_LENGTH} characters` }, { status: 400 });
  if (role === "reseller" && !resellerPartyId) return Response.json({ error: "reseller_party_id is required for reseller logins" }, { status: 400 });
  if (!/^[a-z0-9_.-]+$/.test(username)) return Response.json({ error: "Username can only contain letters, numbers, dots, dashes, underscores" }, { status: 400 });

  const salt = generateSalt();
  const hash = await hashPin(pin, salt);

  let userId;
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (name, username, pin_hash, pin_salt, role, reseller_party_id, token_version, active) VALUES (?, ?, ?, ?, ?, ?, 1, 1)"
    ).bind(name, username, hash, salt, role, resellerPartyId).run();
    userId = res.meta.last_row_id;
  } catch (e) {
    return Response.json({ error: "That username is already in use — pick a different one" }, { status: 400 });
  }

  let siteId = null;
  if (role === "worker" && createSite) {
    const result = await createWorkerSite(env, { name: name + "'s workspace", worker_user_id: userId });
    siteId = result.siteId;
  }

  return Response.json({ id: userId, site_id: siteId });
}
