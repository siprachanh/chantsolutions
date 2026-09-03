"use strict";
/**
 * Passwords, sessions, CSRF, throttling, and IP pseudonymisation.
 *
 * Design notes worth keeping in mind if you change any of this:
 *
 * - Passwords are hashed with scrypt and a per-user random salt. The plaintext
 *   is never written anywhere — not to the database, not to a log.
 * - Session tokens are random 256-bit values. Only their SHA-256 hash is
 *   stored, so a stolen copy of the database does not hand anyone a live
 *   session.
 * - Sign-in answers the same way whether or not the email exists, so the form
 *   cannot be used to discover who has an account.
 * - IP addresses are never stored. The security log keeps a keyed hash with a
 *   salt that changes daily, which is enough to spot a burst of failed
 *   sign-ins and not enough to trace anyone.
 */

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");

const scrypt = promisify(crypto.scrypt);

/* ------------------------------------------------------------ constants -- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const SESSION_COOKIE = "sid";
const CSRF_COOKIE = "csrf";

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_ACCOUNT = 8;
const LOGIN_MAX_PER_IP = 25;

const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

/**
 * Passwords that are long enough to pass the length rule but are among the
 * first things any attacker tries. NIST SP 800-63B asks for exactly this —
 * a blocklist check — instead of composition rules like "one capital, one
 * symbol", which push people toward weaker, more predictable passwords.
 */
const WEAK_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234",
  "passw0rd123", "123456789012", "1234567890123", "12345678901234",
  "qwertyuiop123", "qwertyuiopasd", "letmein12345", "iloveyou1234",
  "administrator", "adminadmin12", "welcome12345", "monkey123456",
  "dragon123456", "football1234", "baseball1234", "sunshine1234",
  "princess1234", "trustno12345", "passwordpassword", "qwerty123456",
  "abc123456789", "111111111111", "000000000000", "aaaaaaaaaaaa",
  "changeme1234", "secret123456", "temporary123", "guestguest12"
]);

/* --------------------------------------------------------------- secret -- */

/**
 * A server secret keys the IP hashes and the CSRF tokens. Set SESSION_SECRET
 * in production. If it is absent we generate one and persist it beside the
 * database so restarts do not invalidate everything — but we say so loudly,
 * because a secret on disk is weaker than a secret in the environment.
 */
function loadSecret(dataDir, log = console) {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, "utf8");
  if (fromEnv) {
    log.warn("! SESSION_SECRET is shorter than 32 characters — ignoring it and generating one.");
  }
  const file = path.join(dataDir, ".secret");
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch { /* first run */ }
  const generated = crypto.randomBytes(48);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  log.warn(`! SESSION_SECRET not set. Generated one at ${file} (mode 600). Set the environment variable in production.`);
  return generated;
}

/* ------------------------------------------------------------ passwords -- */

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(plain, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64");
    const key = Buffer.from(keyB64, "base64");
    if (!salt.length || !key.length) return false;
    const test = await scrypt(plain.normalize("NFKC"), salt, key.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
    });
    return crypto.timingSafeEqual(test, key);
  } catch {
    return false;
  }
}

/** A dummy verify, so a sign-in attempt for an unknown email costs the same
 *  wall-clock time as one for a real account. */
const DUMMY_HASH_PROMISE = hashPassword("dummy-password-for-timing-equalisation");
async function burnPasswordTime(plain) {
  try { await verifyPassword(String(plain || "x"), await DUMMY_HASH_PROMISE); } catch { /* ignore */ }
}

function checkPasswordPolicy(plain, { email, displayName } = {}) {
  const pw = String(plain ?? "");
  if (pw.length < PASSWORD_MIN) {
    return `Passwords need at least ${PASSWORD_MIN} characters. Length beats symbols — a short phrase you'll remember works well.`;
  }
  if (pw.length > PASSWORD_MAX) return `Passwords cap at ${PASSWORD_MAX} characters.`;
  const flat = pw.toLowerCase().replace(/\s+/g, "");
  if (WEAK_PASSWORDS.has(flat)) {
    return "That password appears on public breach lists. Pick something less common.";
  }
  if (email && flat.includes(String(email).toLowerCase().split("@")[0]) && String(email).split("@")[0].length >= 4) {
    return "Your password can't contain your email address.";
  }
  if (displayName && String(displayName).length >= 4 && flat.includes(String(displayName).toLowerCase().replace(/\s+/g, ""))) {
    return "Your password can't contain your display name.";
  }
  return null;
}

/* --------------------------------------------------------------- email -- */

/** Conservative check. The goal is to reject obvious nonsense, not to police
 *  the full RFC — deliverability is proven by use, not by a regex. */
function normaliseEmail(raw) {
  const s = String(raw ?? "").trim();
  if (s.length < 3 || s.length > 254) return null;
  if (!/^[^\s@,;<>()[\]\\"]+@[^\s@.,;<>()[\]\\"]+(\.[^\s@.,;<>()[\]\\"]+)+$/.test(s)) return null;
  return { email: s, key: s.toLowerCase() };
}

/* ------------------------------------------------------------ sessions -- */

function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/* ---------------------------------------------------------------- CSRF -- */

/**
 * Double-submit: a random value goes out in a readable cookie and must come
 * back in a header. A cross-origin page can cause the cookie to be sent but
 * cannot read it, so it cannot produce the matching header. SameSite=Lax on
 * the session cookie is the first line of defence; this is the second.
 */
function newCsrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function csrfMatches(cookieValue, headerValue) {
  const a = Buffer.from(String(cookieValue ?? ""), "utf8");
  const b = Buffer.from(String(headerValue ?? ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------- IP pseudonymisation -- */

/**
 * HMAC the address with a salt derived from the server secret and today's
 * date. Yesterday's hashes cannot be correlated with today's, and no hash can
 * be reversed without the secret. Rows are purged after 30 days regardless.
 */
function makeIpHasher(secret) {
  let cachedDay = null;
  let cachedSalt = null;
  return function hashIp(ip) {
    if (!ip) return null;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== cachedDay) {
      cachedDay = day;
      cachedSalt = crypto.createHmac("sha256", secret).update("ip-salt:" + day).digest();
    }
    return crypto.createHmac("sha256", cachedSalt).update(String(ip)).digest("hex").slice(0, 32);
  };
}

/* ------------------------------------------------------------- cookies -- */

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

function serialiseCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || "/"}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`SameSite=${opts.sameSite || "Lax"}`);
  if (opts.httpOnly !== false) bits.push("HttpOnly");
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

module.exports = {
  SCRYPT,
  SESSION_TTL_MS, SESSION_COOKIE, CSRF_COOKIE,
  PASSWORD_MIN, PASSWORD_MAX,
  LOGIN_WINDOW_MS, LOGIN_MAX_PER_ACCOUNT, LOGIN_MAX_PER_IP,
  EVENT_RETENTION_MS,
  loadSecret,
  hashPassword, verifyPassword, burnPasswordTime, checkPasswordPolicy,
  normaliseEmail,
  newSessionToken, hashToken,
  newCsrfToken, csrfMatches,
  makeIpHasher,
  parseCookies, serialiseCookie
};
