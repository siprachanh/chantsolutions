#!/usr/bin/env node
/**
 * Backend test suite — real HTTP, real SQLite, real cookies.
 *   node tests/api.test.js
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_PORT || 3411);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-api-"));
const DB = path.join(TMP, "test.db");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? "  → " + detail : ""}`); }
}
function eq(name, a, b) { ok(name, Object.is(a, b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/* ------------------------------------------------------------ test client */

/** One browser-ish client: keeps a cookie jar and echoes the CSRF token. */
class Client {
  constructor(base = BASE) { this.base = base; this.jar = new Map(); }

  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    const raw = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
    for (const line of raw) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      if (i < 1) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*Max-Age=0\s*$/i.test(a));
      if (!v || expired) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  cookie(name) { return this.jar.get(name); }

  async req(pathname, { method = "GET", body, headers = {}, raw, csrf } = {}) {
    const h = Object.assign({ Accept: "application/json" }, headers);
    const jar = this.cookieHeader();
    if (jar) h.Cookie = jar;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const token = csrf === undefined ? this.jar.get("csrf") : csrf;
    if (token) h["X-CSRF-Token"] = token;

    const res = await fetch(this.base + pathname, {
      method, headers: h,
      body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON is fine for some routes */ }
    return { status: res.status, headers: res.headers, json, text: raw ? text : undefined };
  }

  /** Fetch a CSRF token the way the real page does, before signing up. */
  async prime() { await this.req("/api/session"); return this; }

  register(payload) { return this.req("/api/auth/register", { method: "POST", body: payload }); }
  login(payload) { return this.req("/api/auth/login", { method: "POST", body: payload }); }
}

const PW = "correct-horse-battery";   // 21 chars, not on the blocklist

/** SQLite in WAL mode keeps recent writes in a sidecar file. Any test that
 *  inspects raw bytes has to read both, or it inspects a stale snapshot. */
function dbBytes(dbPath = DB) {
  const parts = [];
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { parts.push(fs.readFileSync(f)); } catch { /* may not exist */ }
  }
  return Buffer.concat(parts);
}

/** A brand-new signed-in account. Posting is capped at 5 notes a minute per
 *  account, so bulk-posting tests each get their own. */
let freshSeq = 0;
async function freshUser(label) {
  const c = await new Client().prime();
  const email = label.toLowerCase().replace(/\s+/g, "") + (++freshSeq) + "@example.com";
  const r = await c.register({ email, displayName: label + " " + freshSeq, password: PW, consent: true });
  if (r.status !== 201) throw new Error("could not create " + email + ": " + r.status);
  c.email = email;
  return c;
}

async function waitForServer(base = BASE, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base + "/api/health"); if (r.ok) return; } catch {}
    if (Date.now() - t0 > ms) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 150));
  }
}

function startServer(port, dbPath, env = {}) {
  return spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(port), DB_PATH: dbPath, HOST: "127.0.0.1",
      SESSION_SECRET: "test-secret-that-is-definitely-long-enough-32",
      ADMIN_EMAIL: "boss@example.com",
      REGISTER_MAX_PER_HOUR: "500"
    }, env),
    stdio: ["ignore", "ignore", "pipe"]
  });
}

/* ------------------------------------------------------------------ suite */

(async () => {
  const child = startServer(PORT, DB);
  let serverErr = "";
  child.stderr.on("data", (d) => { serverErr += d.toString(); });

  try {
    await waitForServer();

    /* ============================================================ health */
    console.log("\n\x1b[1mhealth & anonymous access\x1b[0m");
    const anon = new Client();
    {
      const r = await anon.req("/api/health");
      eq("health returns 200", r.status, 200);
      eq("health reports the consent version", typeof r.json.consentVersion, "string");
    }
    {
      const r = await anon.req("/api/session");
      eq("session works signed out", r.status, 200);
      eq("no user when signed out", r.json.user, null);
      ok("a CSRF token is issued to signed-out visitors", !!anon.cookie("csrf"));
    }
    {
      const r = await anon.req("/api/comments");
      eq("anyone may read the guestbook", r.status, 200);
      eq("feed starts empty", r.json.comments.length, 0);
    }

    /* ============================================================== CSRF */
    console.log("\n\x1b[1mCSRF\x1b[0m");
    {
      const r = await anon.req("/api/auth/login", { method: "POST", body: { email: "a@b.co", password: PW }, csrf: null });
      eq("a mutation without the CSRF header is refused", r.status, 403);
    }
    {
      const r = await anon.req("/api/auth/login", { method: "POST", body: { email: "a@b.co", password: PW }, csrf: "not-the-real-token" });
      eq("a mutation with the wrong CSRF token is refused", r.status, 403);
    }

    /* ========================================================= registration */
    console.log("\n\x1b[1mregistration\x1b[0m");
    const alice = await new Client().prime();
    {
      const r = await alice.register({ email: "alice@example.com", displayName: "Alice", password: PW, consent: true });
      eq("registration returns 201", r.status, 201);
      eq("the account is returned", r.json.user.displayName, "Alice");
      eq("new accounts are not moderators", r.json.user.isAdmin, false);
      ok("a session cookie is set", !!alice.cookie("sid"));
      ok("a CSRF cookie is set", !!alice.cookie("csrf"));
      ok("the session cookie is HttpOnly", /HttpOnly/i.test(
        (typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")]).join(" ")));
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "no-consent@example.com", displayName: "Nope", password: PW, consent: false });
      eq("registration without consent is refused", r.status, 400);
      ok("the message explains why", /read how your data/i.test(r.json.error), r.json.error);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "bad-email", displayName: "X", password: PW, consent: true });
      eq("a malformed email is refused", r.status, 400);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "short@example.com", displayName: "Shorty", password: "abc123", consent: true });
      eq("a short password is refused", r.status, 400);
      ok("the message names the length rule", /12 characters/.test(r.json.error), r.json.error);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "weak@example.com", displayName: "Weak", password: "passwordpassword", consent: true });
      eq("a long-but-breached password is refused", r.status, 400);
      ok("the message says why", /breach/i.test(r.json.error), r.json.error);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "selfnamed@example.com", displayName: "Christopher", password: "christopherX99", consent: true });
      eq("a password containing the display name is refused", r.status, 400);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "noname@example.com", displayName: "   ", password: PW, consent: true });
      eq("a blank display name is refused", r.status, 400);
    }
    {
      const c = await new Client().prime();
      const r = await c.register({ email: "ALICE@Example.COM", displayName: "Impostor", password: PW, consent: true });
      eq("a duplicate address (different case) is refused", r.status, 409);
      ok("the refusal does not confirm the address is registered",
        !/already|taken|exists|registered/i.test(r.json.error), r.json.error);
    }

    /* ================================================================ login */
    console.log("\n\x1b[1msign-in\x1b[0m");
    const alice2 = await new Client().prime();
    {
      const r = await alice2.login({ email: "alice@example.com", password: PW });
      eq("correct credentials sign in", r.status, 200);
      eq("the right account comes back", r.json.user.email, "alice@example.com");
      ok("a session cookie is issued", !!alice2.cookie("sid"));
    }
    {
      const c = await new Client().prime();
      const r = await c.login({ email: "alice@example.com", password: "wrong-password-here" });
      eq("a wrong password is rejected", r.status, 401);
      ok("no session is issued", !c.cookie("sid"));
    }
    {
      const c1 = await new Client().prime();
      const rUnknown = await c1.login({ email: "nobody-here@example.com", password: "wrong-password-here" });
      const c2 = await new Client().prime();
      const rKnown = await c2.login({ email: "alice@example.com", password: "wrong-password-here" });
      eq("unknown and known addresses fail with the same status", rUnknown.status, rKnown.status);
      eq("...and with identical wording (no account enumeration)", rUnknown.json.error, rKnown.json.error);
    }
    {
      const before = alice2.cookie("sid");
      const r = await alice2.login({ email: "alice@example.com", password: PW });
      ok("signing in again rotates the session token", r.status === 200 && alice2.cookie("sid") !== before);
    }

    /* ================================================== session validation */
    console.log("\n\x1b[1msessions\x1b[0m");
    {
      const c = await new Client().prime();
      c.jar.set("sid", "a-completely-invented-session-token");
      const r = await c.req("/api/session");
      eq("a forged session cookie is not a session", r.json.user, null);
    }
    {
      const r = await alice2.req("/api/session");
      eq("a real session identifies the account", r.json.user.email, "alice@example.com");
    }
    {
      // A session token must not be stored in a directly reusable form.
      const raw = dbBytes();
      const token = alice2.cookie("sid");
      ok("the raw session token is not present in the database file",
        !raw.includes(Buffer.from(decodeURIComponent(token), "utf8")));
    }
    {
      const raw = dbBytes().toString("latin1");
      ok("no plaintext password is present in the database file", !raw.includes(PW));
      ok("passwords are stored as scrypt hashes", /scrypt\$16384\$8\$1\$/.test(raw));
    }

    /* ============================================== authorisation on posting */
    console.log("\n\x1b[1mposting requires an account\x1b[0m");
    {
      const r = await anon.req("/api/comments", { method: "POST", body: { body: "Sneaking in" } });
      eq("a signed-out visitor cannot post", r.status, 401);
    }
    let aliceComment;
    {
      const r = await alice2.req("/api/comments", { method: "POST", body: { body: "Genuinely useful board." } });
      eq("a signed-in visitor can post", r.status, 201);
      eq("the note carries their display name", r.json.comment.name, "Alice");
      eq("and is marked as theirs", r.json.comment.isMine, true);
      aliceComment = r.json.comment.id;
    }
    const poster = await freshUser("Poster");
    {
      const r = await poster.req("/api/comments", { method: "POST", body: { body: "   " } });
      eq("an empty note is refused", r.status, 400);
    }
    {
      const r = await poster.req("/api/comments", { method: "POST", body: { body: "y".repeat(2001) } });
      eq("an over-long note is refused", r.status, 400);
    }
    {
      const r = await poster.req("/api/comments", { method: "POST", body: { body: "y".repeat(2000) } });
      eq("a note at exactly the cap is accepted", r.status, 201);
    }
    {
      const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      const r = await poster.req("/api/comments", { method: "POST", body: { body: payload } });
      eq("script-shaped input is stored as plain text", r.json.comment.body, payload);
    }
    {
      const noisy = "a" + "\u0000" + "b" + "\u001F" + "c";
      const r = await poster.req("/api/comments", { method: "POST", body: { body: noisy } });
      eq("control characters are stripped", r.json.comment.body, "abc");
    }
    {
      const r = await poster.req("/api/comments", { method: "POST", body: { body: "'); DROP TABLE comments;--" } });
      eq("SQL-shaped input is accepted as text", r.status, 201);
      const f = await anon.req("/api/comments");
      ok("the comments table survives", f.status === 200 && f.json.comments.length > 0);
    }
    {
      const c = await freshUser("Malformed");
      const r = await c.req("/api/comments", { method: "POST", body: "not json" });
      eq("malformed JSON is refused", r.status, 400);
    }
    {
      const big = await freshUser("Oversize");
      const r = await big.req("/api/comments", { method: "POST", body: { body: "z".repeat(200000) } });
      ok("an oversized payload is answered, not dropped", r.status === 413 || r.status === 400, `status ${r.status}`);
    }

    /* ============================================================ reactions */
    console.log("\n\x1b[1mreactions\x1b[0m");
    const bob = await new Client().prime();
    await bob.register({ email: "bob@example.com", displayName: "Bob", password: PW, consent: true });
    {
      const r = await anon.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "up" } });
      eq("a signed-out visitor cannot react", r.status, 401);
    }
    {
      const r = await alice2.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "up" } });
      eq("reacting returns 200", r.status, 200);
      eq("the reaction turns on", r.json.on, true);
      eq("the count is 1", r.json.comment.reactions.up, 1);
      eq("and reads as theirs", r.json.comment.mine.up, true);
    }
    {
      const r = await alice2.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "up" } });
      eq("reacting again toggles it off", r.json.comment.reactions.up, 0);
    }
    {
      for (let i = 0; i < 5; i++) {
        await alice2.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "heart" } });
      }
      const f = await alice2.req("/api/comments");
      const c = f.json.comments.find((x) => x.id === aliceComment);
      eq("five toggles by one account end at 1", c.reactions.heart, 1);
    }
    {
      await bob.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "heart" } });
      const f = await bob.req("/api/comments");
      const c = f.json.comments.find((x) => x.id === aliceComment);
      eq("a second account adds to the count", c.reactions.heart, 2);
      eq("and sees it as theirs", c.mine.heart, true);
      const g = await anon.req("/api/comments");
      eq("a signed-out visitor sees the same public count", g.json.comments.find((x) => x.id === aliceComment).reactions.heart, 2);
      eq("but nothing marked as theirs", g.json.comments.find((x) => x.id === aliceComment).mine.heart, false);
    }
    {
      const r = await alice2.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "thumbsdown" } });
      eq("an unknown reaction kind is refused", r.status, 400);
    }
    {
      const r = await alice2.req("/api/comments/no-such-comment/reactions", { method: "POST", body: { kind: "up" } });
      eq("reacting to a missing note is a 404", r.status, 404);
    }
    {
      const r = await alice2.req("/api/comments", { method: "GET" });
      const all = r.json.comments.every((c) =>
        typeof c.reactions.up === "number" && typeof c.reactions.heart === "number" && typeof c.reactions.rocket === "number");
      ok("all three reaction kinds are carried on every note", all);
    }

    /* ==================================================== deleting comments */
    console.log("\n\x1b[1mdeleting notes\x1b[0m");
    {
      const r = await bob.req(`/api/comments/${aliceComment}`, { method: "DELETE" });
      eq("one account cannot delete another's note", r.status, 403);
      const f = await anon.req("/api/comments");
      ok("the note is still there", f.json.comments.some((c) => c.id === aliceComment));
    }
    {
      const posted = await bob.req("/api/comments", { method: "POST", body: { body: "Bob's own note, to be removed." } });
      const r = await bob.req(`/api/comments/${posted.json.comment.id}`, { method: "DELETE" });
      eq("an account can delete its own note", r.status, 200);
      const f = await anon.req("/api/comments");
      ok("and it is gone", !f.json.comments.some((c) => c.id === posted.json.comment.id));
    }
    {
      const r = await bob.req("/api/comments/does-not-exist", { method: "DELETE" });
      eq("deleting a missing note is a 404", r.status, 404);
    }

    /* ======================================================== moderation */
    console.log("\n\x1b[1mmoderation\x1b[0m");
    const boss = await new Client().prime();
    {
      const r = await boss.register({ email: "boss@example.com", displayName: "Sippy", password: PW, consent: true });
      eq("the ADMIN_EMAIL account is a moderator", r.json.user.isAdmin, true);
    }
    {
      const spam = await bob.req("/api/comments", { method: "POST", body: { body: "Spam to be moderated." } });
      const r = await boss.req(`/api/comments/${spam.json.comment.id}`, { method: "DELETE" });
      eq("a moderator can remove anyone's note", r.status, 200);
    }

    /* ================================================ rectification (PATCH) */
    console.log("\n\x1b[1mcorrecting your details\x1b[0m");
    {
      const c = await freshUser("Renamer");
      const r = await c.req("/api/me", { method: "PATCH", body: { displayName: "Alice R." } });
      eq("a display name can be changed", r.status, 200);
      eq("the new name comes back", r.json.user.displayName, "Alice R.");
      const posted = await c.req("/api/comments", { method: "POST", body: { body: "Posted under the new name." } });
      eq("new notes use the new name", posted.json.comment.name, "Alice R.");
    }
    {
      const r = await anon.req("/api/me", { method: "PATCH", body: { displayName: "Hacker" } });
      eq("a signed-out visitor cannot change anyone's details", r.status, 401);
    }
    {
      const r = await alice2.req("/api/me", { method: "PATCH", body: { currentPassword: "wrong", newPassword: "brand-new-password-1" } });
      eq("changing a password needs the current one", r.status, 403);
    }
    {
      const r = await alice2.req("/api/me", { method: "PATCH", body: { currentPassword: PW, newPassword: "short" } });
      eq("the new password must meet the policy", r.status, 400);
    }
    {
      // A second device for Alice, which a password change must sign out.
      const other = await new Client().prime();
      await other.login({ email: "alice@example.com", password: PW });
      const stillOn = await other.req("/api/session");
      eq("the second device is signed in first", stillOn.json.user.email, "alice@example.com");

      const r = await alice2.req("/api/me", { method: "PATCH", body: { currentPassword: PW, newPassword: "a-brand-new-passphrase" } });
      eq("the password change succeeds", r.status, 200);
      eq("and reports the other sign-outs", r.json.signedOutOtherDevices, true);

      const after = await other.req("/api/session");
      eq("the other device is signed out", after.json.user, null);
      const mine = await alice2.req("/api/session");
      eq("the device that made the change stays signed in", mine.json.user.email, "alice@example.com");

      const back = await alice2.req("/api/me", { method: "PATCH", body: { currentPassword: "a-brand-new-passphrase", newPassword: PW } });
      eq("and the password really changed (old one no longer works)", back.status, 200);
    }

    /* ============================================ access & data portability */
    console.log("\n\x1b[1myour data\x1b[0m");
    {
      const r = await anon.req("/api/me/export");
      eq("export needs a session", r.status, 401);
    }
    {
      const r = await alice2.req("/api/me/export", { raw: true });
      eq("export returns 200", r.status, 200);
      ok("it downloads as a file", /attachment/.test(r.headers.get("content-disposition") || ""));
      const j = r.json;
      eq("it names the account", j.account.email, "alice@example.com");
      ok("it records when consent was given", !!j.account.consentGivenAt);
      ok("it includes their notes", Array.isArray(j.comments) && j.comments.length > 0);
      ok("it includes their reactions", Array.isArray(j.reactions));
      ok("it includes their sessions", Array.isArray(j.sessions) && j.sessions.length > 0);
      ok("it includes the security log", Array.isArray(j.securityLog) && j.securityLog.length > 0);
      ok("it states what is not collected", Array.isArray(j.notCollected) && j.notCollected.length > 0);
      ok("it contains no password hash", !/scrypt\$/.test(r.text), "hash leaked into the export");
      ok("the security log holds no raw IP addresses", !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(JSON.stringify(j.securityLog)));
    }

    /* ============================================================== erasure */
    console.log("\n\x1b[1mdeleting your account\x1b[0m");
    {
      const c = await new Client().prime();
      await c.register({ email: "gone@example.com", displayName: "Gone Soon", password: PW, consent: true });
      const posted = await c.req("/api/comments", { method: "POST", body: { body: "This should vanish with me." } });
      await c.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "rocket" } });

      const wrong = await c.req("/api/me", { method: "DELETE", body: { password: "not-my-password" } });
      eq("deletion requires the password", wrong.status, 403);

      const r = await c.req("/api/me", { method: "DELETE", body: { password: PW, comments: "delete" } });
      eq("deletion succeeds", r.status, 200);
      eq("it reports the notes removed", r.json.deleted.comments, 1);
      ok("the session cookie is cleared", !c.cookie("sid"));

      const feed = await anon.req("/api/comments");
      ok("their note is gone from the guestbook", !feed.json.comments.some((x) => x.id === posted.json.comment.id));
      const reacted = feed.json.comments.find((x) => x.id === aliceComment);
      eq("their reaction is gone from the counts", reacted.reactions.rocket, 0);

      const back = await new Client().prime();
      const relogin = await back.login({ email: "gone@example.com", password: PW });
      eq("the account can no longer sign in", relogin.status, 401);

      const raw = dbBytes().toString("latin1");
      ok("the address is no longer in the database file", !raw.includes("gone@example.com"));
    }
    {
      const c = await new Client().prime();
      await c.register({ email: "keeper@example.com", displayName: "Keeps Notes", password: PW, consent: true });
      const posted = await c.req("/api/comments", { method: "POST", body: { body: "Leave this behind without my name." } });
      const r = await c.req("/api/me", { method: "DELETE", body: { password: PW, comments: "keep" } });
      eq("deleting while keeping notes succeeds", r.status, 200);
      eq("it reports the notes anonymised", r.json.deleted.commentsAnonymised, 1);

      const feed = await anon.req("/api/comments");
      const kept = feed.json.comments.find((x) => x.id === posted.json.comment.id);
      ok("the note is still there", !!kept);
      eq("but the name is stripped", kept && kept.name, "Former visitor");
      const raw = dbBytes().toString("latin1");
      ok("the address is gone from the database file", !raw.includes("keeper@example.com"));
      ok("the display name is gone too", !raw.includes("Keeps Notes"));
    }

    /* ============================================================ sign out */
    console.log("\n\x1b[1msigning out\x1b[0m");
    {
      const c = await new Client().prime();
      await c.login({ email: "bob@example.com", password: PW });
      const token = c.cookie("sid");
      const r = await c.req("/api/auth/logout", { method: "POST", body: {} });
      eq("logout returns 200", r.status, 200);
      ok("the cookie is cleared", !c.cookie("sid"));
      c.jar.set("sid", token);
      const reuse = await c.req("/api/session");
      eq("the old token is dead server-side too", reuse.json.user, null);
    }
    {
      const d1 = await new Client().prime(); await d1.login({ email: "bob@example.com", password: PW });
      const d2 = await new Client().prime(); await d2.login({ email: "bob@example.com", password: PW });
      await d1.req("/api/auth/logout-all", { method: "POST", body: {} });
      const r = await d2.req("/api/session");
      eq("sign-out-everywhere ends the other device's session", r.json.user, null);
    }

    /* ======================================================== login throttle */
    console.log("\n\x1b[1mbrute-force resistance\x1b[0m");
    {
      const c = await new Client().prime();
      await c.register({ email: "target@example.com", displayName: "Target", password: PW, consent: true });
      await c.req("/api/auth/logout", { method: "POST", body: {} });

      let locked = false, attempts = 0;
      for (let i = 0; i < 12; i++) {
        const a = await new Client().prime();
        const r = await a.login({ email: "target@example.com", password: "wrong-password-" + i });
        attempts++;
        if (r.status === 429) { locked = true; break; }
      }
      ok("repeated wrong passwords lock the account", locked, `${attempts} attempts without a lock`);

      const good = await new Client().prime();
      const r = await good.login({ email: "target@example.com", password: PW });
      eq("even the correct password is held off while locked", r.status, 429);
      ok("the lock says when to come back", !!r.headers.get("retry-after"));
    }

    /* ===================================================== security headers */
    console.log("\n\x1b[1msecurity headers\x1b[0m");
    {
      const r = await fetch(BASE + "/");
      const csp = r.headers.get("content-security-policy") || "";
      ok("a Content-Security-Policy is sent", !!csp);
      ok("it has no 'unsafe-inline'", !/unsafe-inline/.test(csp), csp.slice(0, 120));
      ok("it has no 'unsafe-eval'", !/unsafe-eval/.test(csp));
      ok("scripts are pinned to a hash", /script-src 'sha256-/.test(csp));
      ok("the page cannot be framed", /frame-ancestors 'none'/.test(csp));
      ok("default-src is closed", /default-src 'none'/.test(csp));
      eq("X-Content-Type-Options is set", r.headers.get("x-content-type-options"), "nosniff");
      eq("X-Frame-Options is set", r.headers.get("x-frame-options"), "DENY");
      eq("Referrer-Policy is set", r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      ok("Permissions-Policy locks down device APIs", /camera=\(\)/.test(r.headers.get("permissions-policy") || ""));
    }
    {
      const r = await fetch(BASE + "/api/health");
      ok("API responses are not cached", /no-store/.test(r.headers.get("cache-control") || ""));
    }
    {
      const r = await fetch(BASE + "/csp.json");
      ok("build metadata is not served", r.status === 404, `status ${r.status}`);
    }
    {
      const s = startServer(PORT + 3, path.join(TMP, "https.db"), { SECURE_COOKIES: "1" });
      await waitForServer(`http://127.0.0.1:${PORT + 3}`);
      const c = new Client(`http://127.0.0.1:${PORT + 3}`);
      await c.prime();
      const r = await c.register({ email: "secure@example.com", displayName: "Sec", password: PW, consent: true });
      const setCookie = (typeof r.headers.getSetCookie === "function"
        ? r.headers.getSetCookie() : [r.headers.get("set-cookie")]).join(" ");
      ok("with SECURE_COOKIES=1 the session cookie is marked Secure", /Secure/.test(setCookie), setCookie.slice(0, 120));
      ok("...and SameSite is set", /SameSite=Lax/.test(setCookie));
      const h = await fetch(`http://127.0.0.1:${PORT + 3}/`);
      ok("...and HSTS is sent", !!h.headers.get("strict-transport-security"));
      s.kill("SIGKILL");
    }

    /* ============================================================ traversal */
    console.log("\n\x1b[1mfile serving\x1b[0m");
    {
      const r = await fetch(BASE + "/../../etc/passwd");
      const t = await r.text();
      ok("path traversal leaks nothing", !t.includes("root:x:"));
    }
    {
      const r = await fetch(BASE + "/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
      const t = await r.text();
      ok("encoded traversal leaks nothing", !t.includes("root:x:"));
    }
    {
      const r = await fetch(BASE + "/");
      const html = await r.text();
      ok("the page carries her name", html.includes("Chanthaphaychith"));
      ok("the portrait is embedded", html.includes("data:image/jpeg;base64,"));
      ok("the privacy notice ships with the page", html.includes("What this site knows about you"));
      ok("no inline style attributes remain (they would break the CSP)",
        !/<[^>]+\sstyle="/.test(html));
    }

    /* ========================================================== concurrency */
    console.log("\n\x1b[1mconcurrency\x1b[0m");
    {
      const clients = [];
      for (let i = 0; i < 10; i++) {
        const c = await new Client().prime();
        await c.register({ email: `conc${i}@example.com`, displayName: `Conc ${i}`, password: PW, consent: true });
        clients.push(c);
      }
      const results = await Promise.all(clients.map((c, i) =>
        c.req(`/api/comments/${aliceComment}/reactions`, { method: "POST", body: { kind: "rocket" } })));
      eq("ten simultaneous reactions all succeed", results.filter((r) => r.status === 200).length, 10);
      const f = await anon.req("/api/comments");
      eq("the count is exactly ten", f.json.comments.find((x) => x.id === aliceComment).reactions.rocket, 10);
    }

    /* ========================================================== persistence */
    console.log("\n\x1b[1mrestart\x1b[0m");
    {
      const sessionToken = alice2.cookie("sid");
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));

      const second = startServer(PORT + 1, DB);
      const B2 = `http://127.0.0.1:${PORT + 1}`;
      await waitForServer(B2);

      const c = new Client(B2);
      c.jar.set("sid", sessionToken);
      const r = await c.req("/api/session");
      eq("a session survives a restart", r.json && r.json.user && r.json.user.email, "alice@example.com");

      const feed = await c.req("/api/comments");
      ok("notes survive a restart", feed.json.comments.length > 3, `${feed.json.comments.length} notes`);
      ok("reaction counts survive a restart",
        feed.json.comments.find((x) => x.id === aliceComment).reactions.rocket === 10);

      const login = new Client(B2);
      await login.prime();
      const li = await login.login({ email: "bob@example.com", password: PW });
      eq("accounts survive a restart", li.status, 200);
      second.kill("SIGKILL");
    }
  } catch (e) {
    fail++;
    failures.push("suite crashed: " + (e && e.message));
    console.error("\n\x1b[31mSUITE ERROR\x1b[0m", e);
    if (serverErr) console.error("server stderr:\n" + serverErr);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n\x1b[1mBackend: ${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  • " + f)); }
  process.exit(fail ? 1 : 0);
})();
