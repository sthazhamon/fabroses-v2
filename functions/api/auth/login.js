import { signToken, verifyPin } from "../_auth.js";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const username = (body.username || "").trim().toLowerCase();
  const pin = body.pin || "";

  if (!username || !pin) return Response.json({ error: "Username and PIN are required" }, { status: 400 });

  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  const genericError = Response.json({ error: "Invalid username or PIN" }, { status: 401 });
  if (!user) return genericError;

  if (user.active !== 1) {
    return Response.json({ error: "This login has been disabled. Contact an admin." }, { status: 401 });
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    return Response.json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` }, { status: 429 });
  }

  const isValid = user.pin_hash && user.pin_salt ? await verifyPin(pin, user.pin_salt, user.pin_hash) : false;
  if (!isValid) {
    const attempts = (user.failed_attempts || 0) + 1;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
      await env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?").bind(lockUntil, user.id).run();
      return Response.json({ error: `Too many failed attempts. Locked for ${LOCKOUT_MINUTES} minutes.` }, { status: 429 });
    }
    await env.DB.prepare("UPDATE users SET failed_attempts = ? WHERE id = ?").bind(attempts, user.id).run();
    return genericError;
  }

  await env.DB.prepare(
    "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?"
  ).bind(user.id).run();

  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const secret = env.AUTH_SECRET || "dev-secret-change-me";
  const token = await signToken(
    { id: user.id, name: user.name, role: user.role, resellerPartyId: user.reseller_party_id, siteId: user.site_id, tokenVersion: user.token_version, exp },
    secret
  );

  return Response.json({ token, name: user.name, role: user.role, site_id: user.site_id });
}
