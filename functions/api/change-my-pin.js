import { generateSalt, hashPin, verifyPin } from "./_auth.js";

const MIN_PIN_LENGTH = 6;

export async function onRequestPost({ request, env, data }) {
  const body = await request.json();
  const { current_pin, new_pin } = body;
  const userId = data.user?.id;
  if (!userId) return Response.json({ error: "Not logged in" }, { status: 401 });
  if (!current_pin || !new_pin) return Response.json({ error: "current_pin and new_pin are both required" }, { status: 400 });
  if (new_pin.length < MIN_PIN_LENGTH) return Response.json({ error: `New PIN must be at least ${MIN_PIN_LENGTH} characters` }, { status: 400 });

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const currentValid = await verifyPin(current_pin, user.pin_salt, user.pin_hash);
  if (!currentValid) return Response.json({ error: "Current PIN is incorrect" }, { status: 400 });

  const salt = generateSalt();
  const hash = await hashPin(new_pin, salt);
  await env.DB.prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?").bind(hash, salt, userId).run();

  return Response.json({ ok: true });
}
