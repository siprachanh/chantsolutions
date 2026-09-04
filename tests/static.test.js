#!/usr/bin/env node
/**
 * Tests for the STATIC build (docs/index.html) — the one hosted on GitHub Pages.
 *
 * This file exists because of a shipped bug. The static build replaces the
 * guestbook with a Contact section, and the jump-link handler did
 *
 *     document.getElementById("guestbook").offsetParent
 *
 * which throws in a build that has no guestbook. preventDefault() had already
 * run, so the Contact link looked fine and did nothing. Every existing test
 * asserted the link was PRESENT and VISIBLE. None clicked it.
 *
 * So: this suite clicks things, and fails on any uncaught page error.
 */

const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");

const PAGE = "file://" + path.join(__dirname, "..", "docs", "index.html");
const CHROMIUM = process.env.CHROMIUM_PATH || undefined;

let passed = 0, failed = 0, group = "";
const g = (name) => { group = name; console.log("\n\x1b[1m" + name + "\x1b[0m"); };
function ok(label, cond) {
  if (cond) { passed++; console.log("  \x1b[32m✓\x1b[0m " + label); }
  else { failed++; console.log("  \x1b[31m✗\x1b[0m " + label); }
}

/**
 * "Did we arrive?" — not "is scrollY equal to the element's offset".
 * #contact is the last section on the page, so the document runs out of scroll
 * before its top reaches the top of the viewport. The honest question is
 * whether the section is on screen and above the fold.
 */
async function arrivedAtContact(page) {
  return page.evaluate(() => {
    const r = document.getElementById("contact").getBoundingClientRect();
    return r.top >= -2 && r.top < window.innerHeight * 0.6 && r.bottom > 0;
  });
}

async function newPage(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // The test box has no network, so the Google Fonts <link> logs a failed
    // resource. That is the harness, not the page.
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  page.errors = errors;
  return page;
}

/** Wait for smooth scrolling to stop moving. */
async function settle(page) {
  await page.waitForFunction(() => new Promise((done) => {
    let last = -1, still = 0;
    const tick = () => {
      if (window.scrollY === last) { if (++still > 8) return done(true); }
      else { still = 0; last = window.scrollY; }
      requestAnimationFrame(tick);
    };
    tick();
  }), null, { timeout: 8000 });
}

(async () => {
  if (!fs.existsSync(path.join(__dirname, "..", "docs", "index.html"))) {
    console.error("docs/index.html missing — run `node build.js` first");
    process.exit(1);
  }
  const browser = await chromium.launch({ executablePath: CHROMIUM });

  /* ------------------------------------------------------------ shape ---- */
  g("static build shape");
  {
    const page = await newPage(browser, 1280, 900);
    await page.goto(PAGE, { waitUntil: "load" });
    ok("no guestbook in this build", await page.$("#guestbook") === null);
    ok("a contact section instead", await page.$("#contact") !== null);
    ok("no auth card", await page.$("#authcard") === null);
    ok("no JS errors on load", page.errors.length === 0);
    const reqs = [];
    page.on("request", (r) => { if (/\/api\//.test(r.url())) reqs.push(r.url()); });
    await page.waitForTimeout(600);
    ok("never calls a backend", reqs.length === 0);
    await page.close();
  }

  /* ------------------------------------------- the bug that shipped ------ */
  g("Contact link actually navigates");
  {
    const page = await newPage(browser, 1280, 900);
    await page.goto(PAGE, { waitUntil: "load" });

    const before = await page.evaluate(() => window.scrollY);
    await page.click('.navlinks a[href="#contact"]');
    await settle(page);
    const after = await page.evaluate(() => window.scrollY);

    ok("clicking Contact throws nothing", page.errors.length === 0);
    ok("the page actually moved", after > before);
    ok("it landed on the contact section", await arrivedAtContact(page));
    ok("the heading is in view", await page.isVisible("#contact h2"));
    await page.close();
  }

  g("Contact works from every view");
  for (const route of ["#/work", "#/privacy"]) {
    const page = await newPage(browser, 1280, 900);
    await page.goto(PAGE + route, { waitUntil: "load" });
    await page.click('.navlinks a[href="#contact"]');
    await settle(page);
    ok("from " + route + ": no error", page.errors.length === 0);
    ok("from " + route + ": reaches contact", await arrivedAtContact(page));
    await page.close();
  }

  g("the hero button and a direct link");
  {
    const page = await newPage(browser, 1280, 900);
    await page.goto(PAGE, { waitUntil: "load" });
    await page.click('.cta-row a[href="#contact"]');
    await settle(page);
    ok("hero 'Get in touch' scrolls there", await arrivedAtContact(page));
    ok("no error from the hero button", page.errors.length === 0);
    await page.close();

    const p2 = await newPage(browser, 1280, 900);
    await p2.goto(PAGE + "#contact", { waitUntil: "load" });
    await settle(p2);
    ok("landing straight on #contact scrolls there", await arrivedAtContact(p2));
    ok("no error landing on #contact", p2.errors.length === 0);
    await p2.close();
  }

  /* --------------------------------------------------------- contents ---- */
  g("what the contact section offers");
  {
    const page = await newPage(browser, 1280, 900);
    await page.goto(PAGE, { waitUntil: "load" });
    const mail = await page.getAttribute('#contact a[href^="mailto:"]', "href");
    ok("an email link", mail === "mailto:sipra.chant@gmail.com");
    const buy = await page.$('#contact a[href*="gumroad.com"]');
    ok("a link to The Patient Paddle", buy !== null);
    ok("that link is safe to open in a new tab",
       (await buy.getAttribute("rel") || "").includes("noopener"));
    await page.close();
  }

  /* ------------------------------------------------------------- phone --- */
  g("on a phone");
  for (const w of [320, 375, 414]) {
    const page = await newPage(browser, w, 800);
    await page.goto(PAGE, { waitUntil: "load" });
    const visible = await page.$$eval(".navlinks a", (as) =>
      as.filter((a) => getComputedStyle(a).display !== "none").map((a) => a.textContent.trim()));
    ok(w + "px: Contact is in the nav", visible.includes("Contact"));
    await page.click('.navlinks a[href="#contact"]');
    await settle(page);
    ok(w + "px: tapping it reaches contact", await arrivedAtContact(page));
    const over = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll("*")]
        .filter((el) => !el.classList.contains("skip"))
        .some((el) => el.getBoundingClientRect().right > vw + 1);
    });
    ok(w + "px: nothing overflows sideways", !over);
    ok(w + "px: no JS errors", page.errors.length === 0);
    await page.close();
  }

  /* ---------------------------------------------------------- portrait --- */
  g("the portrait renders");
  for (const [w, expect] of [[1280, 501], [900, 420], [500, 300], [375, 240]]) {
    const page = await newPage(browser, w, 900);
    await page.goto(PAGE, { waitUntil: "load" });
    const r = await page.evaluate(() => {
      const i = document.getElementById("portrait");
      const b = i.getBoundingClientRect();
      return { nat: i.naturalWidth, w: Math.round(b.width), h: Math.round(b.height) };
    });
    ok(w + "px: image decodes", r.nat > 0);
    ok(w + "px: box is " + expect + "px square", r.w === expect && r.h === expect);
    await page.close();
  }

  /* ------------------------------------------------------------ routes --- */
  g("the three views still route");
  {
    const page = await newPage(browser, 1280, 900);
    for (const [hash, title] of [["#/", "Sippy"], ["#/work", "Library"], ["#/privacy", "Privacy"]]) {
      await page.goto(PAGE + hash, { waitUntil: "load" });
      ok(hash + " → " + title, (await page.title()).includes(title));
    }
    ok("no JS errors across the routes", page.errors.length === 0);
    await page.close();
  }

  await browser.close();
  console.log("\n\x1b[1mStatic: " + passed + " passed, " + failed + " failed\x1b[0m");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
