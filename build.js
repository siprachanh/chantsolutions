#!/usr/bin/env node
/**
 * Builds three outputs from one source:
 *   public/index.html   full standalone document for the Node server
 *   public/csp.json     sha256 hashes of the inline <style> and <script>, so
 *                       the server can send a strict CSP with no 'unsafe-inline'
 *   dist/artifact.html  content-only copy for the Claude Artifact publisher
 *
 * The portrait is inlined as a data URI so both HTML outputs are self-contained.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = __dirname;
const src = fs.readFileSync(path.join(root, "src", "page.html"), "utf8");

let portrait = "";
const b64Path = path.join(root, "src", "headshot.b64");
if (fs.existsSync(b64Path)) {
  portrait = "data:image/jpeg;base64," + fs.readFileSync(b64Path, "utf8").trim();
} else {
  console.warn("! src/headshot.b64 missing — portrait will be blank");
}

const page = src.replace("PORTRAIT_SRC", portrait);

/* --------------------------------------------------- static site variant -- */

/**
 * The guestbook is the only part of this site that needs a server, and a
 * server with a disk costs money. So we also emit a static build: the same
 * page with the guestbook swapped for a way to actually get in touch. It
 * hosts free anywhere — Cloudflare Pages, Firebase, Netlify, GitHub Pages —
 * with a custom domain and SSL.
 *
 * Nothing is thrown away. Add the server whenever the guestbook earns its
 * keep, and the full build is still here.
 */
const CONTACT = `<section class="gb" id="contact">
  <div class="wrap">
    <div class="sec-head">
      <p class="eyebrow">Get in touch</p>
      <h2>One conversation</h2>
      <div class="span-rule" role="presentation"><i></i></div>
    </div>
    <p class="lede mb-28">If something here is close to what you need &mdash; a team that isn&rsquo;t landing, a business trying to use AI without understanding it, a conversation you&rsquo;re dreading &mdash; write to me. I read everything myself.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="mailto:sipra.chant@gmail.com">Email me</a>
      <a class="btn btn-ghost" href="https://siprachant.gumroad.com/l/ibckmi" target="_blank" rel="noopener noreferrer">Get The Patient Paddle</a>
    </div>
  </div>
</section>`;

function toStatic(html) {
  const start = html.indexOf('<section class="gb" id="guestbook">');
  if (start === -1) {
    console.warn("! guestbook section not found — static build is unchanged");
    return html;
  }
  const end = html.indexOf("</section>", html.indexOf('id="coffline"')) + "</section>".length;
  let out = html.slice(0, start) + CONTACT + html.slice(end);
  // the nav link pointed at the guestbook; point it at the contact block
  out = out.replace('<a href="#guestbook" data-jump>Guestbook</a>', '<a href="#contact" data-jump>Contact</a>');
  out = out.replace('<a class="btn btn-ghost" href="#guestbook" data-jump>Leave a note</a>',
                    '<a class="btn btn-ghost" href="#contact" data-jump>Get in touch</a>');
  return out;
}

const staticPage = toStatic(page);

/* ------------------------------------------------------------ CSP hashes -- */

/**
 * A CSP hash covers the EXACT bytes between the tags. Compute them from the
 * final output, after substitution, or the browser will silently refuse to run
 * the page's own script.
 */
function hashInline(html, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const digest = crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
    out.push(`sha256-${digest}`);
  }
  return out;
}

const csp = {
  generatedAt: new Date().toISOString(),
  style: hashInline(page, "style"),
  script: hashInline(page, "script")
};

if (!csp.script.length) console.warn("! no inline <script> found — check the build");
if (!csp.style.length) console.warn("! no inline <style> found — check the build");

/* ------------------------------------------------------- write the files -- */

const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Siprachanh &quot;Sippy&quot; Chanthaphaychith — mediator, Agile coach, and builder of conflict-resolution and AI tools. Portfolio, library, and guestbook.">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="strict-origin-when-cross-origin">
${page}
</body>
</html>
`;

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "index.html"), doc);
fs.writeFileSync(path.join(root, "public", "csp.json"), JSON.stringify(csp, null, 2));
fs.writeFileSync(path.join(root, "dist", "artifact.html"), page);

// docs/ (not static/) because that is the one folder GitHub Pages will serve
// from without any build step, CLI, or extra account.
const staticDoc = doc.replace(page, staticPage);
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "index.html"), staticDoc);
fs.writeFileSync(path.join(root, "docs", ".nojekyll"), "");

console.log("built public/index.html   (%d KB)", Math.round(doc.length / 1024));
console.log("built dist/artifact.html  (%d KB)", Math.round(page.length / 1024));
console.log("built public/csp.json     (%d script, %d style hash)", csp.script.length, csp.style.length);
console.log("built docs/index.html     (%d KB) — free hosting, no guestbook", Math.round(staticDoc.length / 1024));
