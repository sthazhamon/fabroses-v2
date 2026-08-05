// Shared auth helpers: credential hashing (PBKDF2) and session token sign/verify.
const PBKDF2_ITERATIONS = 50000;

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export function generateSalt() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPin(pin, saltHex) {
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256
  );
  return bufToHex(derived);
}

export async function verifyPin(pin, saltHex, expectedHashHex) {
  const actualHashHex = await hashPin(pin, saltHex);
  if (actualHashHex.length !== expectedHashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actualHashHex.length; i++) diff |= actualHashHex.charCodeAt(i) ^ expectedHashHex.charCodeAt(i);
  return diff === 0;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
}

export async function signToken(payload, secret) {
  const payloadStr = btoa(JSON.stringify(payload));
  const sig = await hmacSign(payloadStr, secret);
  return `${payloadStr}.${sig}`;
}

export async function verifyToken(token, secret) {
  try {
    const [payloadStr, sig] = token.split(".");
    if (!payloadStr || !sig) return null;
    const expectedSig = await hmacSign(payloadStr, secret);
    if (expectedSig !== sig) return null;
    const payload = JSON.parse(atob(payloadStr));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
