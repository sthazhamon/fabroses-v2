#!/usr/bin/env node
// One-time bootstrap: creates the SQL for the very first admin login.
// Usage: node scripts/create-admin.js <name> <username> <pin>

const crypto = require("node:crypto").webcrypto;
const PBKDF2_ITERATIONS = 50000; // must match functions/api/_auth.js

function bufToHex(buf) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
function hexToBuf(hex) { const b = new Uint8Array(hex.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16); return b; }
function generateSalt() { return bufToHex(crypto.getRandomValues(new Uint8Array(16))); }
async function hashPin(pin, saltHex) {
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return bufToHex(derived);
}

async function main() {
  const [name, username, pin] = process.argv.slice(2);
  if (!name || !username || !pin) {
    console.error("Usage: node scripts/create-admin.js <name> <username> <pin>");
    process.exit(1);
  }
  if (pin.length < 6) { console.error("PIN must be at least 6 characters."); process.exit(1); }

  const salt = generateSalt();
  const hash = await hashPin(pin, salt);
  const usernameNorm = username.trim().toLowerCase();
  const sql = `INSERT INTO users (name, username, pin_hash, pin_salt, role, token_version, active) VALUES ('${name.replace(/'/g, "''")}', '${usernameNorm}', '${hash}', '${salt}', 'admin', 1, 1);\n`;

  require("node:fs").writeFileSync("create-admin.sql", sql);
  console.log("\nWrote ./create-admin.sql — run:\n");
  console.log("wrangler d1 execute fabroses-db --remote --file=./create-admin.sql\n");
  console.log(`Then sign in with username "${usernameNorm}" and the PIN you chose.`);
  console.log("This script never sent your PIN anywhere — only the hash goes into the file.\n");
}
main();
