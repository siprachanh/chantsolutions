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

console.log("built public/index.html   (%d KB)", Math.round(doc.length / 1024));
console.log("built dist/artifact.html  (%d KB)", Math.round(page.length / 1024));
console.log("built public/csp.json     (%d script, %d style hash)", csp.script.length, csp.style.length);
