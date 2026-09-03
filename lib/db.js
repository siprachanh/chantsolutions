"use strict";
/**
 * Schema and every SQL statement in the app.
 *
 * DATA INVENTORY — what this database holds about a person, and why.
 * Keep this table honest; it is the source for the privacy notice and for
 * answering a data-subject access request.
 *
 *   users.email            identify the account, sign in, contact about the account
 *   users.display_name     shown publicly beside their notes
 *   users.pw_hash          verify sign-in (scrypt; the password itself is never stored)
 *   users.consent_*        proof of what they agreed to and when
 *   comments.body          the note they chose to publish
 *   reactions              which notes they reacted to
 *   auth_events.ip_hash    abuse defence only; keyed HMAC, never the raw IP,
 *                          salt rotates daily, rows purged after 30 days
 *   auth_events.email_hash keyed HMAC of the address a sign-in was attempted
 *                          with — never the address itself, so a failed
 *                          attempt records nothing readable about someone who
 *                          does not even have an account here
 *
 * Nothing else is collected. No analytics, no trackers, no third-party
 * embeds, no IP address stored against a comment.
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Without this, DELETE only marks a page free: the bytes of a deleted row —
  -- an email address, a display name — stay readable in the file until some
  -- later write happens to land on top of them. "Delete my data" has to mean
  -- the data is gone, so make SQLite overwrite it.
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL,
    email_key        TEXT NOT NULL UNIQUE,
    display_name     TEXT NOT NULL,
    pw_hash          TEXT NOT NULL,
    is_admin         INTEGER NOT NULL DEFAULT 0,
    consent_version  TEXT NOT NULL,
    consent_at       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    created_ms       INTEGER NOT NULL,
    updated_ms       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_ms   INTEGER NOT NULL,
    expires_ms   INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_ms);

  CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    created_ms  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_created ON comments (created_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments (user_id);

  CREATE TABLE IF NOT EXISTS reactions (
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (comment_id, user_id, kind)
  );

  CREATE INDEX IF NOT EXISTS idx_reactions_comment ON reactions (comment_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_user    ON reactions (user_id);

  -- Security log. Retained 30 days, then purged. IPs are keyed hashes with a
  -- salt that rotates daily, so a row cannot be walked back to an address.
  CREATE TABLE IF NOT EXISTS auth_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms      INTEGER NOT NULL,
    ts         TEXT NOT NULL,
    event      TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    user_id    TEXT,
    email_hash TEXT,
    ip_hash    TEXT,
    detail     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_auth_events_ts    ON auth_events (ts_ms);
  CREATE INDEX IF NOT EXISTS idx_auth_events_email ON auth_events (email_hash, ts_ms);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const q = {
    /* --- users --- */
    createUser: db.prepare(`
      INSERT INTO users (id, email, email_key, display_name, pw_hash, is_admin,
                         consent_version, consent_at, created_at, created_ms, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    userByEmailKey: db.prepare(`SELECT * FROM users WHERE email_key = ?`),
    userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
    countUsers: db.prepare(`SELECT COUNT(*) AS n FROM users`),
    setDisplayName: db.prepare(`UPDATE users SET display_name = ?, updated_ms = ? WHERE id = ?`),
    setPassword: db.prepare(`UPDATE users SET pw_hash = ?, updated_ms = ? WHERE id = ?`),
    deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),

    /* --- sessions --- */
    createSession: db.prepare(`
      INSERT INTO sessions (token_hash, user_id, created_ms, expires_ms, last_seen_ms)
      VALUES (?, ?, ?, ?, ?)`),
    sessionByHash: db.prepare(`
      SELECT s.token_hash, s.user_id, s.expires_ms, s.created_ms,
             u.email, u.display_name, u.is_admin, u.created_at AS user_created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`),
    touchSession: db.prepare(`UPDATE sessions SET last_seen_ms = ? WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
    listUserSessions: db.prepare(`
      SELECT created_ms, expires_ms, last_seen_ms FROM sessions WHERE user_id = ? ORDER BY created_ms DESC`),
    purgeExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_ms < ?`),

    /* --- comments --- */
    listComments: db.prepare(`
      SELECT id, user_id, author_name, body, created_at FROM comments
      ORDER BY created_ms DESC LIMIT ?`),
    commentById: db.prepare(`SELECT * FROM comments WHERE id = ?`),
    insertComment: db.prepare(`
      INSERT INTO comments (id, user_id, author_name, body, created_at, created_ms)
      VALUES (?, ?, ?, ?, ?, ?)`),
    deleteComment: db.prepare(`DELETE FROM comments WHERE id = ?`),
    commentsByUser: db.prepare(`
      SELECT id, body, created_at FROM comments WHERE user_id = ? ORDER BY created_ms DESC`),
    deleteCommentsByUser: db.prepare(`DELETE FROM comments WHERE user_id = ?`),
    anonymiseCommentsByUser: db.prepare(`
      UPDATE comments SET user_id = NULL, author_name = ? WHERE user_id = ?`),
    countCommentsInWindow: db.prepare(`
      SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_ms > ?`),

    /* --- reactions --- */
    listReactions: db.prepare(`SELECT comment_id, user_id, kind FROM reactions`),
    hasReaction: db.prepare(`
      SELECT 1 FROM reactions WHERE comment_id = ? AND user_id = ? AND kind = ?`),
    addReaction: db.prepare(`
      INSERT OR IGNORE INTO reactions (comment_id, user_id, kind, created_ms) VALUES (?, ?, ?, ?)`),
    delReaction: db.prepare(`
      DELETE FROM reactions WHERE comment_id = ? AND user_id = ? AND kind = ?`),
    reactionsByUser: db.prepare(`
      SELECT comment_id, kind, created_ms FROM reactions WHERE user_id = ?`),

    /* --- security log --- */
    logEvent: db.prepare(`
      INSERT INTO auth_events (ts_ms, ts, event, ok, user_id, email_hash, ip_hash, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    recentFailures: db.prepare(`
      SELECT COUNT(*) AS n FROM auth_events
      WHERE email_hash = ? AND event = 'login' AND ok = 0 AND ts_ms > ?`),
    recentFailuresByIp: db.prepare(`
      SELECT COUNT(*) AS n FROM auth_events
      WHERE ip_hash = ? AND event = 'login' AND ok = 0 AND ts_ms > ?`),
    eventsForUser: db.prepare(`
      SELECT ts, event, ok, detail FROM auth_events WHERE user_id = ? ORDER BY ts_ms DESC LIMIT 500`),
    purgeOldEvents: db.prepare(`DELETE FROM auth_events WHERE ts_ms < ?`),
    clearUserFromEvents: db.prepare(`
      UPDATE auth_events SET user_id = NULL, email_hash = NULL WHERE user_id = ?`)
  };

  /**
   * Make an erasure final on disk. secure_delete zeroes the freed rows, the
   * checkpoint folds the write-ahead log into the main file (the log can still
   * hold older page images), and VACUUM rebuilds the file without the freed
   * pages. Account deletions are rare, so paying for a rebuild is the right
   * trade for actually keeping the promise.
   */
  function hardErase() {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.exec("VACUUM;");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      return true;
    } catch (e) {
      console.error("[erase] could not compact the database:", e.message);
      return false;
    }
  }

  return { db, q, hardErase };
}

module.exports = { open, SCHEMA };
