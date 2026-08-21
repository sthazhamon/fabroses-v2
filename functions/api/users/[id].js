import { generateSalt, hashPin } from "../_auth.js";

const MIN_PIN_LENGTH = 6;

export async function onRequestPatch({ request, env, params }) {
  const body = await request.json();
  const action = body.action;

  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(params.id).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  if (action === "edit") {
    const name = (body.name || "").trim();
    const username = (body.username || "").trim().toLowerCase();
    const role = body.role;
    const VALID_ROLES = ["admin", "accountant", "worker", "dispatch", "reseller"];
    if (!name || !username || !VALID_ROLES.includes(role)) {
      return Response.json({ error: `name, username, and a valid role (${VALID_ROLES.join(", ")}) are required` }, { status: 400 });
    }
    if (!/^[a-z0-9_.-]+$/.test(username)) return Response.json({ error: "Username can only contain letters, numbers, dots, dashes, underscores" }, { status: 400 });
    try {
      await env.DB.prepare("UPDATE users SET name = ?, username = ?, role = ? WHERE id = ?").bind(name, username, role, params.id).run();
    } catch (e) {
      return Response.json({ error: "That username is already in use — pick a different one" }, { status: 400 });
    }
    return Response.json({ ok: true });
  }
  if (action === "revoke_sessions") {
    await env.DB.prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }
  if (action === "deactivate") {
    await env.DB.prepare("UPDATE users SET active = 0, token_version = token_version + 1 WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }
  if (action === "activate") {
    await env.DB.prepare("UPDATE users SET active = 1, failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(params.id).run();
    return Response.json({ ok: true });
  }
  if (action === "reset_pin") {
    const newPin = body.new_pin || "";
    if (newPin.length < MIN_PIN_LENGTH) return Response.json({ error: `PIN must be at least ${MIN_PIN_LENGTH} characters` }, { status: 400 });
    const salt = generateSalt();
    const hash = await hashPin(newPin, salt);
    await env.DB.prepare(
      "UPDATE users SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = ?"
    ).bind(hash, salt, params.id).run();
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
