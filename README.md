# Sippy Chanthaphaychith — portfolio

A portfolio with three views (Home, Library, Privacy) and a guestbook with real
accounts: visitors sign up, post notes, and react with 👍 ❤️ 🚀.

One HTML source file, a small Node server, and **zero runtime dependencies** —
no framework, no npm install to run it.

---

## Run it

Needs **Node 22 or newer** (the server uses the built-in `node:sqlite` driver).

```bash
node build.js      # renders src/ into public/index.html + public/csp.json
node server.js     # http://localhost:3000
```

Copy `.env.example` and fill it in before you deploy. The one setting you must
not skip is `SESSION_SECRET`:

```bash
npm run secret     # prints a good one
```

## Test it

```bash
npm test                 # both suites
node tests/api.test.js   # 145 backend assertions
node tests/ui.test.js    # 190 browser assertions (needs: npm i -D playwright)
```

The UI suite drives real headless Chromium against a real server, a real
database and real cookies. Screenshots land in `tests/screens/`.

**Current state: 335 of 335 assertions pass.**

| Area | Covers |
|---|---|
| Accounts | sign-up, consent gate, password policy, sign-in, sign-out, sign-out-everywhere, session rotation |
| Session security | forged cookies rejected, tokens stored only as hashes, HttpOnly / SameSite / Secure flags, survival across restart |
| Enumeration | duplicate sign-up and failed sign-in answer identically whether or not the account exists |
| CSRF | every mutation refused without a matching token; refused with a wrong one |
| Brute force | per-account and per-source lockout, `Retry-After`, correct password held off while locked |
| Authorization | only the author or a moderator can delete a note; signed-out visitors can read but not write |
| Your data | export contains everything and no password hash; erasure removes account, sessions, reactions and (optionally) notes, and compacts the file |
| Headers | CSP with no `unsafe-inline`, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy |
| Rendering | script/img/svg payloads render as text and never execute; CSP blocks an injected inline script |
| Responsive | 375 / 768 / 1440 — no horizontal scroll, nav bar fits, nothing spills |
| Accessibility | labels, alt text, skip link, focus ring, heading order, keyboard-only sign-up **and** posting, reduced motion |
| Degraded | API unreachable and API returning 500 — the page still works and says so |

---

## How it fits together

```
src/page.html          the assembled page — markup, CSS and JS in one file
src/parts/             the pieces it is assembled from, for editing
  guestbook.html         auth card, posting card, account panel
  privacy.html           the privacy notice view
  auth.css               styles for all of the above
  app.js                 the client
lib/db.js              schema, the data inventory, every SQL statement
lib/auth.js            passwords, sessions, CSRF, IP pseudonymisation
server.js              routes. The whole backend.
build.js               renders src/ → public/ and dist/, and hashes the
                       inline script and style for the CSP
public/                generated — do not edit
dist/artifact.html     generated — the Claude Artifact preview build
data/portfolio.db      created on first write
data/.secret           auto-generated fallback secret (set SESSION_SECRET instead)
```

Edit under `src/parts/`, re-assemble into `src/page.html`, run `node build.js`,
restart.

### Security design, in short

- **Passwords** — scrypt (N=16384), per-account random salt. The plaintext is
  never written anywhere. Policy is NIST-style: 12 characters minimum, checked
  against a blocklist of common choices, no composition rules.
- **Sessions** — 256-bit random tokens; only their SHA-256 hash is stored, so a
  stolen database grants no live sessions. Rotated on sign-in and on password
  change. 30-day expiry, swept hourly.
- **CSRF** — double-submit token plus `SameSite=Lax`. Enforced on every
  non-idempotent request.
- **Enumeration** — sign-in does identical work and returns identical wording
  whether or not the address exists, including a dummy hash for unknown
  accounts so the timing matches.
- **CSP** — `default-src 'none'` with the page's own script and style pinned by
  SHA-256 hash. No `unsafe-inline`, which is why there is not a single
  `style="..."` attribute in the markup; the test suite fails if one appears.
- **Erasure means erasure** — `PRAGMA secure_delete` zeroes freed rows, and an
  account deletion checkpoints the write-ahead log and VACUUMs, so the data is
  gone from the file rather than merely unlinked from the tables.

### What is stored about a person

| | Why | Retention |
|---|---|---|
| Email | Sign-in and account identity | Until deletion |
| Display name | Shown beside their notes | Until deletion |
| scrypt hash | Verify sign-in | Until deletion |
| Notes, reactions | The guestbook itself | Until deletion |
| Session hash | Keep them signed in | 30 days |
| Security log | Spot a break-in attempt | 30 days, auto-purged |

IP addresses are **never** stored — the security log keeps a keyed HMAC whose
salt rotates daily. Email addresses in that log are hashed too, so a failed
sign-in records nothing readable about someone who has no account here.
No analytics, no trackers, no third-party embeds.

### API

| Method | Path | Auth | Body |
|---|---|---|---|
| `GET` | `/api/health` | — | |
| `GET` | `/api/session` | — | issues a CSRF token |
| `POST` | `/api/auth/register` | — | `{ email, displayName, password, consent }` |
| `POST` | `/api/auth/login` | — | `{ email, password }` |
| `POST` | `/api/auth/logout` | session | |
| `POST` | `/api/auth/logout-all` | session | |
| `PATCH` | `/api/me` | session | `{ displayName? }` or `{ currentPassword, newPassword }` |
| `GET` | `/api/me/export` | session | downloads everything held about the caller |
| `DELETE` | `/api/me` | session | `{ password, comments: "delete" \| "keep" }` |
| `GET` | `/api/comments` | — | anyone may read |
| `POST` | `/api/comments` | session | `{ body }` |
| `DELETE` | `/api/comments/:id` | author or moderator | |
| `POST` | `/api/comments/:id/reactions` | session | `{ kind: "up" \| "heart" \| "rocket" }` |

Every mutation needs `X-CSRF-Token` matching the `csrf` cookie.

### Limits

- Display name 60 chars, note 2000 chars, request body 64 KB.
- 5 notes/minute and 60 reactions/minute per account.
- `REGISTER_MAX_PER_HOUR` new accounts per hour per source (default 10).
- 8 failed sign-ins per account and 25 per source in 15 minutes, then a lockout.
- **Failed validation never spends rate-limit budget** — someone fixing a typo
  is not locked out by their typos.

---

## Deploying

Any host that runs a long-lived Node process with a writable disk: Render,
Railway, Fly.io, a VPS.

```
Build:  node build.js
Start:  node server.js
Env:    SESSION_SECRET (required), ADMIN_EMAIL, DB_PATH=/data/portfolio.db,
        TRUST_PROXY=1, PORT (set by the host)
```

`DB_PATH` must point at persistent storage or the guestbook resets on every
deploy. `TRUST_PROXY=1` turns on Secure cookies, HSTS, and reading the real
client address from `X-Forwarded-For` — set it only when a proxy you control
sets that header, or the value can be spoofed.

Serverless hosts (Vercel, Netlify Functions) will not work as-is: the filesystem
is ephemeral and SQLite has nowhere to live. Swap the query layer in `lib/db.js`
for hosted Postgres — the schema transfers directly and the routes do not change.

### Back it up

The database is one file. `cp data/portfolio.db backup.db` after a
`wal_checkpoint`, or use `sqlite3 data/portfolio.db ".backup backup.db"`. There
is no other copy of anyone's account.

---

## Things worth deciding

- **Moderation is reactive.** Notes post live and you remove what you don't
  want. If it ever attracts spam, add an `approved` column defaulting to `0` and
  filter `buildFeed` on it.
- **No password reset.** There is no email sender wired in, so a forgotten
  password currently means creating another account. Adding reset means adding
  an email provider — that is the next real piece of work if people start using it.
- **Requiring sign-in cuts participation.** Most visitors will not create an
  account to leave a note. That is the cost of the authentication, and it is
  worth being deliberate about rather than surprised by.
- **The privacy notice must stay true.** It is a description of how the code
  actually behaves. If you change what is stored, change `lib/db.js`'s data
  inventory, `src/parts/privacy.html`, and bump `CONSENT_VERSION` in `server.js`
  together.
