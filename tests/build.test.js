#!/usr/bin/env node
/**
 * Fails when the committed build outputs are stale.
 *
 * Why this file exists: on 2026-09-09 the hero had said "ChantSolutions LLC"
 * and "Conflict resolution" in src/page.html for weeks, and the live site had
 * been serving "ChantSolutions" and "Mediator" the whole time. The commit that
 * made the change edited the source and never re-ran the build, so
 * docs/index.html — the only file GitHub Pages actually serves — still held
 * the old HTML. Every test passed, because every test ran against a fresh
 * build in memory rather than against what was committed.
 *
 * So this runs FIRST, before anything else in `npm test`: it hashes the
 * outputs as they sit on disk, rebuilds, and hashes them again. Any difference
 * means what is committed is not what the source produces.
 *
 *   node tests/build.test.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");

// Every file build.js writes that is also committed. .nojekyll is omitted —
// it is always empty, so it cannot go stale.
const OUTPUTS = [
  "docs/index.html",
  "public/index.html",
  "public/csp.json",
  "dist/artifact.html",
];

const fingerprint = (rel) => {
  const f = path.join(root, rel);
  if (!fs.existsSync(f)) return null;

  let buf = fs.readFileSync(f);

  // csp.json records a generatedAt timestamp, so it differs on every build by
  // design and a raw hash would always report it stale. The hashes inside it
  // are what matter: if the inline script changes and this file is not
  // rebuilt, the server sends a CSP that blocks its own script.
  if (rel.endsWith("csp.json")) {
    const j = JSON.parse(buf.toString("utf8"));
    delete j.generatedAt;
    buf = Buffer.from(JSON.stringify(j));
  }

  return crypto.createHash("sha256").update(buf).digest("hex");
};

const before = Object.fromEntries(OUTPUTS.map((p) => [p, fingerprint(p)]));

// Rebuild. Output is swallowed; the build prints its own file sizes and the
// later suites will report anything genuinely broken.
execFileSync(process.execPath, [path.join(root, "build.js")], { stdio: "ignore" });

const after = Object.fromEntries(OUTPUTS.map((p) => [p, fingerprint(p)]));

let pass = 0;
const stale = [];

console.log("\n\x1b[1mbuild outputs match the source\x1b[0m");
for (const p of OUTPUTS) {
  if (before[p] !== null && before[p] === after[p]) {
    pass++;
    console.log("  \x1b[32m✓\x1b[0m " + p);
  } else {
    stale.push(p);
    console.log(
      "  \x1b[31m✗\x1b[0m " + p +
      (before[p] === null ? "  — missing, never built" : "  — stale")
    );
  }
}

if (stale.length) {
  console.log(
    "\n  docs/index.html is the file GitHub Pages serves. It is generated from\n" +
    "  src/, so editing the source without rebuilding changes nothing that a\n" +
    "  visitor can see — and nothing else in this suite would catch it.\n" +
    "\n  The files above have just been rebuilt, so the fix is to commit them:\n" +
    "\n      git add -A && git commit -m \"Rebuild\"\n"
  );
}

console.log(
  `\n\x1b[1mBuild freshness: ${pass} passed, ${stale.length} failed\x1b[0m`
);
process.exit(stale.length ? 1 : 0);
