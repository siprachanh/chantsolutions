#!/usr/bin/env node
/**
 * Portfolio server — zero npm dependencies. Node 22+ (built-in node:sqlite).
 *
 *   node build.js && node server.js        # http://localhost:3000
 *
 * Environment
 *   PORT             default 3000
 *   HOST             default 0.0.0.0
 *   DB_PATH          default ./data/portfolio.db
 *   SESSION_SECRET   REQUIRED in production (>= 32 chars)
 *   ADMIN_EMAIL      this account gets moderation powers on sign-up
 *   TRUST_PROXY      set to 1 behind a load balancer that sets X-Forwarded-For
 *   SECURE_COOKIES   set to 1 to force the Secure flag (auto-on when TRUST_PROXY=1)
 *
 * API
 *   GET    /api/health
 *   GET    /api/session                       who am I
 *   POST   /api/auth/register                 { email, displayName, password, consent }
 *   POST   /api/auth/login                    { email, password }
 *   POST   /api/auth/logout
 *   POST   /api/auth/logout-all
 *   PATCH  /api/me                            { displayName? , currentPassword?, newPassword? }
 *   GET    /api/me/export                     everything held about the caller
 *   DELETE /api/me                            { password, comments: "delete" | "keep" }
 *   GET    /api/comments
 *   POST   /api/comments                      { body }            (sign-in required)
 *   DELETE /api/comments/:id                  (own comment, or admin)
 *   POST   /api/comments/:id/reactions        { kind }            (sign-in required)
 *
 * Every state-changing request must carry the CSRF header (X-CSRF-Token) that
 * matches the csrf cookie.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const store = require("./lib/db");
const A = require("./lib/auth");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "portfolio.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SECURE_COOKIES = process.env.SECURE_COOKIES === "1" || TRUST_PROXY;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

/** New accounts allowed per hour from one source. Successful sign-ups only —
 *  a failed validation never spends the budget. Raise it if you share the link
 *  somewhere a roomful of people are behind one address. */
const REGISTER_MAX_PER_HOUR = Math.max(1, Number(process.env.REGISTER_MAX_PER_HOUR || 10));

const NAME_MAX = 60;
const BODY_MAX = 2000;
const LIST_LIMIT = 200;
const KINDS = new Set(["up", "heart", "rocket"]);

/** Bumped whenever the privacy notice or terms change materially. Stored
 *  against each account so there is a record of what they actually agreed to. */
const CONSENT_VERSION = "2026-09-01";

const { db, q, hardErase } = store.open(DB_PATH);
const SECRET = A.loadSecret(path.dirname(DB_PATH));
const hashIp = A.makeIpHasher(SECRET);

/**
 * Keyed hash of an email address for the security log. Throttling only ever
 * compares addresses for equality, and a hash preserves that — so a failed
 * sign-in can be counted without writing down whose address it was. Matters
 * most for addresses that have no account here: those people never chose to
 * give us anything.
 */
const crypto = require("node:crypto");
function hashEmail(key) {
  if (!key) return null;
  return crypto.createHmac("sha256", SECRET).update("email:" + String(key)).digest("hex").slice(0, 32);
}

/* -------------------------------------------------------------- helpers -- */

function clean(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
function collapseWs(s) { return clean(s).replace(/\s+/g, " ").trim(); }
function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd || "").split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "";
}

function tooLarge() {
  return Object.assign(new Error("That request is too large."), { status: 413, closeAfter: true });
}

function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) return finish(reject, tooLarge());

    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limitBytes) { chunks.length = 0; return finish(reject, tooLarge()); }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      if (!chunks.length) return finish(resolve, {});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return finish(reject, Object.assign(new Error("Body must be a JSON object"), { status: 400 }));
        }
        finish(resolve, parsed);
      } catch {
        finish(reject, Object.assign(new Error("Body must be valid JSON"), { status: 400 }));
      }
    });
    req.on("error", (e) => finish(reject, e));
    req.on("aborted", () => finish(reject, Object.assign(new Error("Request aborted"), { status: 400 })));
  });
}

/* ----------------------------------------------------- security headers -- */

let CSP_HASHES = { script: [], style: [] };
try {
  CSP_HASHES = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "csp.json"), "utf8"));
} catch {
  console.warn("! public/csp.json missing — run `node build.js`. Falling back to a permissive style/script policy.");
}

function contentSecurityPolicy() {
  const scriptSrc = CSP_HASHES.script.length
    ? CSP_HASHES.script.map((h) => `'${h}'`).join(" ")
    : "'unsafe-inline'";
  const styleSrc = CSP_HASHES.style.length
    ? CSP_HASHES.style.map((h) => `'${h}'`).join(" ")
    : "'unsafe-inline'";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src https://fonts.gstatic.com",
    `style-src ${styleSrc} https://fonts.googleapis.com`,
    `script-src ${scriptSrc}`,
    "connect-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests"
  ].join("; ");
}

const CSP = contentSecurityPolicy();

function securityHeaders(isHtml) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
    "X-Frame-Options": "DENY"
  };
  if (isHtml) h["Content-Security-Policy"] = CSP;
  if (SECURE_COOKIES) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return h;
}

function send(res, status, payload, extra) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  }, securityHeaders(false), extra || {}));
  res.end(body);
}

/* ----------------------------------------------------------- rate limit -- */

const buckets = new Map();
function bucketFor(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  return b;
}
function rateCheck(key, max, windowMs) {
  const b = bucketFor(key, windowMs);
  return { ok: b.count < max, retryAfter: Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) };
}
function rateSpend(key, windowMs) { bucketFor(key, windowMs).count++; }
function rateHit(key, max, windowMs) {
  const b = bucketFor(key, windowMs);
  b.count++;
  return { ok: b.count <= max, retryAfter: Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref?.();

/* ---------------------------------------------------------- audit trail -- */

function logEvent(event, { ok = true, userId = null, emailKey = null, ip = null, detail = null } = {}) {
  const now = Date.now();
  try {
    q.logEvent.run(now, new Date(now).toISOString(), event, ok ? 1 : 0,
      userId, hashEmail(emailKey), ip ? hashIp(ip) : null, detail);
  } catch (e) {
    console.error("[audit] could not write event", event, e.message);
  }
}

/* -------------------------------------------------------------- retention -- */

function runRetention() {
  const now = Date.now();
  try {
    q.purgeExpiredSessions.run(now);
    q.purgeOldEvents.run(now - A.EVENT_RETENTION_MS);
  } catch (e) {
    console.error("[retention]", e.message);
  }
}
runRetention();
setInterval(runRetention, 60 * 60 * 1000).unref?.();

/* --------------------------------------------------------------- session -- */

function currentSession(req) {
  const cookies = A.parseCookies(req.headers.cookie);
  const raw = cookies[A.SESSION_COOKIE];
  if (!raw) return null;
  const row = q.sessionByHash.get(A.hashToken(raw));
  if (!row) return null;
  if (row.expires_ms < Date.now()) {
    q.deleteSession.run(row.token_hash);
    return null;
  }
  // Cheap liveness stamp; at most once a minute.
  if (Date.now() - (row.last_seen_ms || 0) > 60_000) {
    try { q.touchSession.run(Date.now(), row.token_hash); } catch { /* not critical */ }
  }
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    userCreatedAt: row.user_created_at
  };
}

function sessionCookieHeaders(token, csrf) {
  return [
    A.serialiseCookie(A.SESSION_COOKIE, token, {
      maxAge: A.SESSION_TTL_MS / 1000, httpOnly: true, secure: SECURE_COOKIES, sameSite: "Lax"
    }),
    // Readable by the page on purpose — it has to echo the value back in a header.
    A.serialiseCookie(A.CSRF_COOKIE, csrf, {
      maxAge: A.SESSION_TTL_MS / 1000, httpOnly: false, secure: SECURE_COOKIES, sameSite: "Lax"
    })
  ];
}

function clearCookieHeaders() {
  return [
    A.serialiseCookie(A.SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: SECURE_COOKIES }),
    A.serialiseCookie(A.CSRF_COOKIE, "", { maxAge: 0, httpOnly: false, secure: SECURE_COOKIES })
  ];
}

function issueSession(userId) {
  const token = A.newSessionToken();
  const csrf = A.newCsrfToken();
  const now = Date.now();
  q.createSession.run(A.hashToken(token), userId, now, now + A.SESSION_TTL_MS, now);
  return { token, csrf };
}

/* ------------------------------------------------------------------ CSRF -- */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfOk(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const cookies = A.parseCookies(req.headers.cookie);
  const header = req.headers["x-csrf-token"];
  const supplied = Array.isArray(header) ? header[0] : header;
  return A.csrfMatches(cookies[A.CSRF_COOKIE], supplied);
}

/* ------------------------------------------------------------ the feed -- */

function buildFeed(viewerId) {
  const comments = q.listComments.all(LIST_LIMIT);
  const rows = q.listReactions.all();

  const byComment = new Map();
  for (const r of rows) {
    let e = byComment.get(r.comment_id);
    if (!e) {
      e = { counts: { up: 0, heart: 0, rocket: 0 }, mine: { up: false, heart: false, rocket: false } };
      byComment.set(r.comment_id, e);
    }
    if (e.counts[r.kind] === undefined) continue;
    e.counts[r.kind]++;
    if (viewerId && r.user_id === viewerId) e.mine[r.kind] = true;
  }

  return comments.map((c) => {
    const e = byComment.get(c.id);
    return {
      id: c.id,
      name: c.author_name,
      body: c.body,
      createdAt: c.created_at,
      isMine: !!viewerId && c.user_id === viewerId,
      reactions: e ? e.counts : { up: 0, heart: 0, rocket: 0 },
      mine: e ? e.mine : { up: false, heart: false, rocket: false }
    };
  });
}

function publicUser(session) {
  if (!session) return null;
  return {
    id: session.userId,
    email: session.email,
    displayName: session.displayName,
    isAdmin: session.isAdmin,
    memberSince: session.userCreatedAt
  };
}

/* --------------------------------------------------------- static files -- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  } catch {
    return send(res, 400, { error: "Bad request" });
  }
  if (rel.includes("\0")) return send(res, 400, { error: "Bad request" });

  const target = path.resolve(PUBLIC_DIR, "." + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: "Forbidden" });
  }
  // csp.json is build metadata, not public content.
  if (path.basename(target) === "csp.json") return send(res, 404, { error: "Not found" });

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      const idx = path.join(PUBLIC_DIR, "index.html");
      return fs.readFile(idx, (e2, buf) => {
        if (e2) return send(res, 404, { error: "Not found" });
        res.writeHead(404, Object.assign({
          "Content-Type": MIME[".html"], "Content-Length": buf.length, "Cache-Control": "no-cache"
        }, securityHeaders(true)));
        res.end(buf);
      });
    }
    const ext = path.extname(target).toLowerCase();
    const isHtml = ext === ".html";
    res.writeHead(200, Object.assign({
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=3600"
    }, securityHeaders(isHtml)));
    if (req.method === "HEAD") return res.end();
    const stream = fs.createReadStream(target);
    stream.pipe(res);
    stream.on("error", () => res.destroy());
  });
}

/* ----------------------------------------------------------------- routes -- */

async function handleApi(req, res, p, url) {
  const ip = clientIp(req);
  const session = currentSession(req);

  /* --- flood guard on everything --- */
  const floodKey = "all:" + (session ? session.userId : hashIp(ip) || "anon");
  const flood = rateHit(floodKey, 300, 60_000);
  if (!flood.ok) {
    return send(res, 429, { error: "Too many requests. Wait a moment and try again." },
      { "Retry-After": String(flood.retryAfter) });
  }

  /* --- CSRF on every mutation --- */
  if (!csrfOk(req)) {
    logEvent("csrf_reject", { ok: false, userId: session && session.userId, ip, detail: p });
    return send(res, 403, { error: "Your session token didn't match. Reload the page and try again." });
  }

  /* ---------------------------------------------------------- health --- */
  if (p === "/api/health" && req.method === "GET") {
    return send(res, 200, { ok: true, service: "portfolio-guestbook", consentVersion: CONSENT_VERSION });
  }

  /* --------------------------------------------------------- session --- */
  if (p === "/api/session" && req.method === "GET") {
    // Hand the page a CSRF token even when signed out, so the sign-up form works.
    const cookies = A.parseCookies(req.headers.cookie);
    let extra;
    if (!cookies[A.CSRF_COOKIE]) {
      extra = { "Set-Cookie": A.serialiseCookie(A.CSRF_COOKIE, A.newCsrfToken(), {
        maxAge: A.SESSION_TTL_MS / 1000, httpOnly: false, secure: SECURE_COOKIES, sameSite: "Lax"
      }) };
    }
    return send(res, 200, { user: publicUser(session), consentVersion: CONSENT_VERSION }, extra);
  }

  /* -------------------------------------------------------- register --- */
  if (p === "/api/auth/register" && req.method === "POST") {
    if (session) return send(res, 400, { error: "You're already signed in." });

    const rlKey = "register:" + (hashIp(ip) || "anon");
    const rl = rateCheck(rlKey, REGISTER_MAX_PER_HOUR, 60 * 60_000);
    if (!rl.ok) {
      return send(res, 429, { error: "Too many accounts created from here recently. Try again later." },
        { "Retry-After": String(rl.retryAfter) });
    }

    const body = await readJson(req);
    const parsedEmail = A.normaliseEmail(body.email);
    const displayName = collapseWs(body.displayName ?? "");
    const password = String(body.password ?? "");
    const consent = body.consent === true;

    if (!parsedEmail) return send(res, 400, { error: "That doesn't look like an email address." });
    if (!displayName) return send(res, 400, { error: "Pick a display name — it's what shows beside your notes." });
    if (displayName.length > NAME_MAX) return send(res, 400, { error: `Display names cap at ${NAME_MAX} characters.` });
    if (!consent) {
      return send(res, 400, { error: "Please tick the box to confirm you've read how your data is handled." });
    }
    const pwProblem = A.checkPasswordPolicy(password, { email: parsedEmail.email, displayName });
    if (pwProblem) return send(res, 400, { error: pwProblem });

    if (q.userByEmailKey.get(parsedEmail.key)) {
      // Do not confirm that the address is taken — that would leak who has an
      // account here. Cost the same time as a real sign-up, then say the same
      // thing a successful one says.
      await A.burnPasswordTime(password);
      logEvent("register_duplicate", { ok: false, emailKey: parsedEmail.key, ip });
      return send(res, 409, {
        error: "That address can't be used to create a new account. If it's yours, sign in instead."
      });
    }

    const now = new Date();
    const id = makeId("u");
    const pwHash = await A.hashPassword(password);
    const isAdmin = ADMIN_EMAIL && parsedEmail.key === ADMIN_EMAIL ? 1 : 0;

    try {
      q.createUser.run(id, parsedEmail.email, parsedEmail.key, displayName, pwHash, isAdmin,
        CONSENT_VERSION, now.toISOString(), now.toISOString(), now.getTime(), now.getTime());
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) {
        return send(res, 409, { error: "That address can't be used to create a new account." });
      }
      throw e;
    }

    rateSpend(rlKey, 60 * 60_000);
    const { token, csrf } = issueSession(id);
    logEvent("register", { userId: id, emailKey: parsedEmail.key, ip });

    return send(res, 201,
      { user: { id, email: parsedEmail.email, displayName, isAdmin: !!isAdmin, memberSince: now.toISOString() } },
      { "Set-Cookie": sessionCookieHeaders(token, csrf) });
  }

  /* ------------------------------------------------------------ login --- */
  if (p === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const parsedEmail = A.normaliseEmail(body.email);
    const password = String(body.password ?? "");
    const emailKey = parsedEmail ? parsedEmail.key : null;
    const since = Date.now() - A.LOGIN_WINDOW_MS;
    const ipHash = hashIp(ip);

    // Throttle by account and by source, so neither a single account nor a
    // single machine can be used to grind through passwords.
    if (emailKey) {
      const perAccount = q.recentFailures.get(hashEmail(emailKey), since);
      if (perAccount && perAccount.n >= A.LOGIN_MAX_PER_ACCOUNT) {
        logEvent("login_locked", { ok: false, emailKey, ip });
        return send(res, 429,
          { error: "Too many failed attempts on this account. Wait 15 minutes and try again." },
          { "Retry-After": "900" });
      }
    }
    if (ipHash) {
      const perIp = q.recentFailuresByIp.get(ipHash, since);
      if (perIp && perIp.n >= A.LOGIN_MAX_PER_IP) {
        logEvent("login_locked_ip", { ok: false, ip });
        return send(res, 429, { error: "Too many failed attempts from here. Wait 15 minutes and try again." },
          { "Retry-After": "900" });
      }
    }

    const user = emailKey ? q.userByEmailKey.get(emailKey) : null;

    // Identical work and identical wording either way — the form must not
    // reveal whether an address has an account.
    let good = false;
    if (user) good = await A.verifyPassword(password, user.pw_hash);
    else await A.burnPasswordTime(password);

    if (!good) {
      logEvent("login", { ok: false, userId: user ? user.id : null, emailKey, ip });
      return send(res, 401, { error: "That email and password don't match." });
    }

    const { token, csrf } = issueSession(user.id);
    logEvent("login", { ok: true, userId: user.id, emailKey, ip });

    return send(res, 200, {
      user: {
        id: user.id, email: user.email, displayName: user.display_name,
        isAdmin: !!user.is_admin, memberSince: user.created_at
      }
    }, { "Set-Cookie": sessionCookieHeaders(token, csrf) });
  }

  /* ----------------------------------------------------------- logout --- */
  if (p === "/api/auth/logout" && req.method === "POST") {
    if (session) {
      q.deleteSession.run(session.tokenHash);
      logEvent("logout", { userId: session.userId, ip });
    }
    return send(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeaders() });
  }

  if (p === "/api/auth/logout-all" && req.method === "POST") {
    if (!session) return send(res, 401, { error: "Sign in first." });
    q.deleteUserSessions.run(session.userId);
    logEvent("logout_all", { userId: session.userId, ip });
    return send(res, 200, { ok: true }, { "Set-Cookie": clearCookieHeaders() });
  }

  /* --------------------------------------------- rectification (PATCH) --- */
  if (p === "/api/me" && req.method === "PATCH") {
    if (!session) return send(res, 401, { error: "Sign in first." });
    const body = await readJson(req);
    const changes = [];

    if (body.displayName !== undefined) {
      const name = collapseWs(body.displayName);
      if (!name) return send(res, 400, { error: "Display name can't be empty." });
      if (name.length > NAME_MAX) return send(res, 400, { error: `Display names cap at ${NAME_MAX} characters.` });
      q.setDisplayName.run(name, Date.now(), session.userId);
      changes.push("displayName");
    }

    if (body.newPassword !== undefined) {
      const user = q.userById.get(session.userId);
      const okCurrent = await A.verifyPassword(String(body.currentPassword ?? ""), user.pw_hash);
      if (!okCurrent) {
        logEvent("password_change", { ok: false, userId: session.userId, ip });
        return send(res, 403, { error: "Your current password didn't match." });
      }
      const problem = A.checkPasswordPolicy(body.newPassword, {
        email: user.email, displayName: user.display_name
      });
      if (problem) return send(res, 400, { error: problem });

      q.setPassword.run(await A.hashPassword(String(body.newPassword)), Date.now(), session.userId);
      // Changing a password ends every other session — that is the whole point
      // of changing it after a scare.
      q.deleteUserSessions.run(session.userId);
      const { token, csrf } = issueSession(session.userId);
      logEvent("password_change", { ok: true, userId: session.userId, ip });
      changes.push("password");
      return send(res, 200, { ok: true, changed: changes, signedOutOtherDevices: true },
        { "Set-Cookie": sessionCookieHeaders(token, csrf) });
    }

    if (!changes.length) return send(res, 400, { error: "Nothing to change." });
    logEvent("profile_update", { userId: session.userId, ip, detail: changes.join(",") });
    const fresh = q.userById.get(session.userId);
    return send(res, 200, {
      ok: true, changed: changes,
      user: {
        id: fresh.id, email: fresh.email, displayName: fresh.display_name,
        isAdmin: !!fresh.is_admin, memberSince: fresh.created_at
      }
    });
  }

  /* ------------------------------------------- access & portability --- */
  if (p === "/api/me/export" && req.method === "GET") {
    if (!session) return send(res, 401, { error: "Sign in first." });
    const user = q.userById.get(session.userId);
    if (!user) return send(res, 401, { error: "Sign in first." });

    const payload = {
      exportedAt: new Date().toISOString(),
      format: "portfolio-guestbook-export/1",
      note: "This is everything this site holds about you. Passwords are not included because the password itself is never stored — only a scrypt hash used to check sign-in.",
      account: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isAdmin: !!user.is_admin,
        createdAt: user.created_at,
        consentVersion: user.consent_version,
        consentGivenAt: user.consent_at
      },
      comments: q.commentsByUser.all(user.id),
      reactions: q.reactionsByUser.all(user.id).map((r) => ({
        commentId: r.comment_id, kind: r.kind, at: new Date(r.created_ms).toISOString()
      })),
      sessions: q.listUserSessions.all(user.id).map((s) => ({
        startedAt: new Date(s.created_ms).toISOString(),
        lastSeenAt: new Date(s.last_seen_ms).toISOString(),
        expiresAt: new Date(s.expires_ms).toISOString()
      })),
      securityLog: q.eventsForUser.all(user.id),
      notCollected: [
        "IP addresses against your comments",
        "Analytics, advertising or tracking identifiers",
        "Location, device fingerprints or browsing history",
        "Anything from third-party embeds — there are none"
      ]
    };
    logEvent("data_export", { userId: user.id, ip });
    const json = JSON.stringify(payload, null, 2);
    res.writeHead(200, Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(json),
      "Content-Disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store"
    }, securityHeaders(false)));
    return res.end(json);
  }

  /* ---------------------------------------------------------- erasure --- */
  if (p === "/api/me" && req.method === "DELETE") {
    if (!session) return send(res, 401, { error: "Sign in first." });
    const body = await readJson(req);
    const user = q.userById.get(session.userId);
    if (!user) return send(res, 401, { error: "Sign in first." });

    const okPassword = await A.verifyPassword(String(body.password ?? ""), user.pw_hash);
    if (!okPassword) {
      logEvent("account_delete", { ok: false, userId: user.id, ip });
      return send(res, 403, { error: "Enter your password to confirm deletion." });
    }

    const keepComments = body.comments === "keep";
    const summary = {
      comments: q.commentsByUser.all(user.id).length,
      reactions: q.reactionsByUser.all(user.id).length
    };

    // Order matters: detach or remove the content first, then drop the account.
    if (keepComments) q.anonymiseCommentsByUser.run("Former visitor", user.id);
    else q.deleteCommentsByUser.run(user.id);

    q.deleteUserSessions.run(user.id);
    q.clearUserFromEvents.run(user.id);   // keep the counts, lose the identity
    q.deleteUser.run(user.id);            // cascades to reactions

    // Zero the freed pages and rebuild the file, so the data is gone from
    // disk and not merely unlinked from the tables.
    const compacted = hardErase();

    logEvent("account_delete", { ok: true, ip, detail: keepComments ? "comments kept, anonymised" : "comments removed" });

    return send(res, 200, {
      ok: true,
      deleted: {
        account: true,
        comments: keepComments ? 0 : summary.comments,
        commentsAnonymised: keepComments ? summary.comments : 0,
        reactions: summary.reactions,
        sessions: true,
        erasedFromDisk: compacted
      }
    }, { "Set-Cookie": clearCookieHeaders() });
  }

  /* --------------------------------------------------------- comments --- */
  if (p === "/api/comments" && req.method === "GET") {
    return send(res, 200, { comments: buildFeed(session && session.userId) });
  }

  if (p === "/api/comments" && req.method === "POST") {
    if (!session) return send(res, 401, { error: "Sign in to leave a note." });

    const rlKey = "post:" + session.userId;
    const rl = rateCheck(rlKey, 5, 60_000);
    if (!rl.ok) {
      return send(res, 429, { error: "Too many notes in a row. Wait a moment and try again." },
        { "Retry-After": String(rl.retryAfter) });
    }

    const body = await readJson(req);
    const text = clean(body.body ?? "").trim();
    if (!text) return send(res, 400, { error: "Write a note before posting." });
    if (text.length > BODY_MAX) return send(res, 400, { error: `Notes cap at ${BODY_MAX} characters.` });

    const id = makeId("c");
    const now = new Date();
    q.insertComment.run(id, session.userId, session.displayName, text, now.toISOString(), now.getTime());
    rateSpend(rlKey, 60_000);

    return send(res, 201, {
      comment: {
        id, name: session.displayName, body: text, createdAt: now.toISOString(), isMine: true,
        reactions: { up: 0, heart: 0, rocket: 0 }, mine: { up: false, heart: false, rocket: false }
      }
    });
  }

  const delMatch = p.match(/^\/api\/comments\/([^/]+)$/);
  if (delMatch && req.method === "DELETE") {
    if (!session) return send(res, 401, { error: "Sign in first." });
    const id = decodeURIComponent(delMatch[1]);
    const comment = q.commentById.get(id);
    if (!comment) return send(res, 404, { error: "That note no longer exists." });
    if (comment.user_id !== session.userId && !session.isAdmin) {
      logEvent("comment_delete", { ok: false, userId: session.userId, ip, detail: "not owner" });
      return send(res, 403, { error: "You can only delete your own notes." });
    }
    q.deleteComment.run(id);
    logEvent("comment_delete", { ok: true, userId: session.userId, ip, detail: session.isAdmin && comment.user_id !== session.userId ? "moderated" : "own" });
    return send(res, 200, { ok: true, id });
  }

  /* -------------------------------------------------------- reactions --- */
  const reactMatch = p.match(/^\/api\/comments\/([^/]+)\/reactions$/);
  if (reactMatch && req.method === "POST") {
    if (!session) return send(res, 401, { error: "Sign in to react." });

    const rl = rateHit("react:" + session.userId, 60, 60_000);
    if (!rl.ok) {
      return send(res, 429, { error: "Too many reactions at once. Wait a moment." },
        { "Retry-After": String(rl.retryAfter) });
    }

    const commentId = decodeURIComponent(reactMatch[1]);
    const body = await readJson(req);
    const kind = String(body.kind ?? "");
    if (!KINDS.has(kind)) return send(res, 400, { error: "Reaction must be one of: up, heart, rocket." });
    if (!q.commentById.get(commentId)) return send(res, 404, { error: "That note no longer exists." });

    const had = !!q.hasReaction.get(commentId, session.userId, kind);
    if (had) q.delReaction.run(commentId, session.userId, kind);
    else q.addReaction.run(commentId, session.userId, kind, Date.now());

    const updated = buildFeed(session.userId).find((c) => c.id === commentId);
    return send(res, 200, { on: !had, comment: updated });
  }

  /* ------------------------------------------------------------ 404/405 -- */
  const known = ["/api/health", "/api/session", "/api/comments", "/api/me", "/api/me/export",
    "/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/logout-all"];
  if (known.includes(p) || delMatch || reactMatch) {
    return send(res, 405, { error: "Method not allowed" });
  }
  return send(res, 404, { error: "Not found" });
}

/* ---------------------------------------------------------------- server -- */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch { return send(res, 400, { error: "Bad request" }); }

  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (!p.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    }
    return serveStatic(req, res, url.pathname);
  }

  try {
    await handleApi(req, res, p, url);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error("[server]", err);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    const extra = err && err.closeAfter ? { Connection: "close" } : undefined;
    send(res, status, { error: status === 500 ? "Something went wrong on our side." : err.message }, extra);
    if (err && err.closeAfter) res.on("finish", () => { try { req.destroy(); } catch {} });
  }
});

if (require.main === module) {
  if (!process.env.SESSION_SECRET) {
    console.warn("! Running without SESSION_SECRET. Fine locally; set it before you deploy.");
  }
  if (!SECURE_COOKIES) {
    console.warn("! Cookies are not marked Secure. Set SECURE_COOKIES=1 (or TRUST_PROXY=1) when serving over HTTPS.");
  }
  server.listen(PORT, HOST, () => {
    console.log(`portfolio running at http://localhost:${PORT}`);
    console.log(`  database   ${DB_PATH}`);
    console.log(`  accounts   ${q.countUsers.get().n}`);
    console.log(`  admin      ${ADMIN_EMAIL || "(ADMIN_EMAIL not set — no moderator account)"}`);
    console.log(`  sign-ups   ${REGISTER_MAX_PER_HOUR}/hour per source`);
  });
}

module.exports = server;
