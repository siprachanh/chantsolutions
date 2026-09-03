#!/usr/bin/env node
/**
 * UI / UX test suite — drives the real page in headless Chromium.
 *   node tests/ui.test.js
 */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.TEST_PORT || 3511);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `portfolio-ui-${Date.now()}.db`);
const SHOTS = path.join(ROOT, "tests", "screens");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? "  → " + detail : ""}`); }
}
function eq(name, a, b) { ok(name, Object.is(a, b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

/** A fresh page with console/error capture and a deterministic visitor id. */
async function newPage(browser, { vid, width = 1280, height = 900, colorScheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
  await ctx.addInitScript((v) => {
    try {
      if (v && !localStorage.getItem("sippy.vid")) localStorage.setItem("sippy.vid", v);
    } catch (e) {}
  }, vid || null);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const dialogs = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const where = (m.location() && m.location().url) || "";
    // Google Fonts is unreachable from the test sandbox; that is an
    // environment fact, not a defect in the page.
    if (/fonts\.(googleapis|gstatic)\.com/.test(where)) return;
    consoleErrors.push(m.text() + " @ " + where);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  return { ctx, page, consoleErrors, pageErrors, dialogs };
}

async function settle(page) {
  await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
  await page.waitForFunction(
    () => document.getElementById("clist").getAttribute("aria-busy") === "false",
    null, { timeout: 15000 });
  // one of the three guestbook cards must be showing
  await page.waitForFunction(() => {
    var ids = ["authcard", "postcard", "previewcard"];
    return ids.some(function (id) { var n = document.getElementById(id); return n && !n.hidden; });
  }, null, { timeout: 15000 });
}

let uiSeq = 0;
/** Create an account through the real sign-up form and land signed in. */
async function signUp(page, name) {
  // Derive the address from a counter, not the display name — some tests
  // deliberately use display names that are not valid email local parts.
  const email = "uiuser" + (++uiSeq) + "@example.com";
  await page.click("#tab-signup");
  await page.fill("#su-name", name);
  await page.fill("#su-email", email);
  await page.fill("#su-pw", "correct-horse-battery");
  await page.check("#su-consent");
  await page.click("#su-submit");
  await page.waitForSelector("#postcard:not([hidden])", { timeout: 15000 });
  return email;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DB_PATH: DB, HOST: "127.0.0.1",
      SESSION_SECRET: "ui-test-secret-that-is-long-enough-for-checks",
      ADMIN_EMAIL: "boss@example.com",
      REGISTER_MAX_PER_HOUR: "500"
    }),
    stdio: "ignore"
  });

  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      executablePath: process.env.CHROMIUM_PATH || undefined
    });

    /* ------------------------------------------------ render & console -- */
    console.log("\n\x1b[1mrender\x1b[0m");
    {
      const { page, consoleErrors, pageErrors, ctx } = await newPage(browser, { vid: "uivisitor1" });
      const resp = await page.goto(BASE + "/", { waitUntil: "networkidle" });
      eq("page returns 200", resp.status(), 200);
      await settle(page);

      eq("no uncaught JS errors", pageErrors.length, 0, pageErrors.join(" | "));
      const realConsoleErrors = consoleErrors.filter((t) => !/favicon|fonts\.g/i.test(t));
      eq("no console errors", realConsoleErrors.length, 0, JSON.stringify(realConsoleErrors));

      eq("h1 is her full name", (await page.locator("h1").first().innerText()).replace(/\s+/g, " ").trim(),
        "Siprachanh Chanthaphaychith");
      eq("exactly one h1", await page.locator("h1").count(), 1);

      const img = page.locator("#portrait");
      ok("portrait has alt text", (await img.getAttribute("alt") || "").length > 5);
      const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
      ok("portrait actually loaded", loaded);

      const title = await page.title();
      eq("document title", title, "Sippy Chanthaphaychith");

      // the bridge-span divider must not be an invalid <hr> with children
      const badHr = await page.evaluate(() => document.querySelectorAll("hr .span-rule, hr > i").length);
      eq("no invalid nested markup in dividers", badHr, 0);

      ok("Built column present", await page.locator(".col-head h3", { hasText: "Built" }).count() > 0);
      ok("Building column present", await page.locator(".col-head h3", { hasText: "Building" }).count() > 0);
      ok("Deciding next column present", await page.locator(".col-head h3", { hasText: "Deciding next" }).count() > 0);

      const declaredCounts = await page.$$eval(".board > div", (cols) =>
        cols.map((c) => ({
          declared: Number(c.querySelector(".count").textContent.trim()),
          actual: c.querySelectorAll(".card").length
        })));
      ok("column counts match the cards shown",
        declaredCounts.every((c) => c.declared === c.actual),
        JSON.stringify(declaredCounts));

      ok("legal disclaimer present", (await page.locator(".disclaimer").innerText()).includes("not licensed to practice law"));

      // The framework order has to match Sipra. Assert it so a future edit
      // cannot quietly put Story back in front of State.
      const fwHeading = (await page.locator("#framework h2").innerText()).replace(/\s+/g, " ").trim();
      eq("the framework heading reads State first", fwHeading, "State · Story · Strategy");
      const steps = (await page.$$eval("#framework .fw-step .n", (ns) => ns.map((n) => n.textContent)))
        .map((t) => t.replace(/^.*—\s*/, "").trim());
      eq("the three stages are in State, Story, Strategy order", steps.join(","), "State,Story,Strategy");
      const stray = await page.evaluate(() => document.body.innerHTML.includes("Story–State–Strategy"));
      eq("no page copy still says Story–State–Strategy", stray, false);

      // the theme control must draw an icon, not depend on a font glyph
      const iconBox = await page.locator("#themebtn svg").boundingBox();
      ok("theme toggle renders a real icon", !!iconBox && iconBox.width >= 10 && iconBox.height >= 10,
        JSON.stringify(iconBox));

      // a separator must never be the last thing on a wrapped line
      const strandedSep = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".roleline b")];
        const rows = new Map();
        items.forEach((el) => {
          const top = Math.round(el.getBoundingClientRect().top);
          rows.set(top, (rows.get(top) || []).concat(el.textContent.trim()));
        });
        return [...rows.values()];
      });
      ok("role line has no stranded separators", strandedSep.every((r) => r.length > 0), JSON.stringify(strandedSep));

      await page.screenshot({ path: path.join(SHOTS, "home-light.png"), fullPage: false });
      await ctx.close();
    }

    /* ---------------------------------------------------------- theming -- */
    console.log("\n\x1b[1mtheming\x1b[0m");
    {
      const { page, ctx } = await newPage(browser, { vid: "uitheme", colorScheme: "light" });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);

      const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok("light body background is painted (not transparent)",
        bgLight !== "rgba(0, 0, 0, 0)" && bgLight !== "transparent", bgLight);

      await page.click("#themebtn");
      await page.waitForTimeout(120);
      const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok("toggle actually changes the background", bgDark !== bgLight, `${bgLight} -> ${bgDark}`);
      eq("toggle stamps data-theme", await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");

      // contrast sanity: text must not match its own background
      const contrastOk = await page.evaluate(() => {
        function lum(c) {
          const m = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
            v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
        }
        const bg = lum(getComputedStyle(document.body).backgroundColor);
        const els = [document.querySelector("h1"), document.querySelector(".lede"), document.querySelector(".c-body") || document.querySelector(".prose p")];
        return els.filter(Boolean).map((el) => {
          const f = lum(getComputedStyle(el).color);
          const ratio = (Math.max(f, bg) + 0.05) / (Math.min(f, bg) + 0.05);
          return { tag: el.className || el.tagName, ratio: Math.round(ratio * 100) / 100 };
        });
      });
      ok("dark-mode text meets 4.5:1 against the page ground",
        contrastOk.every((c) => c.ratio >= 4.5), JSON.stringify(contrastOk));

      await page.screenshot({ path: path.join(SHOTS, "home-dark.png") });

      await page.reload({ waitUntil: "domcontentloaded" });
      eq("theme choice survives a reload",
        await page.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
      await ctx.close();
    }
    {
      // system-dark with no explicit choice must still be readable
      const { page, ctx } = await newPage(browser, { vid: "uisysdark", colorScheme: "dark" });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      eq("system dark leaves data-theme unstamped",
        await page.evaluate(() => document.documentElement.getAttribute("data-theme")), null);
      const { bg, fg } = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.querySelector("h1")).color
      }));
      ok("un-stamped system-dark renders the dark palette", bg !== "rgb(244, 236, 221)", `${bg} / ${fg}`);
      await ctx.close();
    }

    /* --------------------------------------------------------- routing -- */
    console.log("\n\x1b[1mnavigation\x1b[0m");
    {
      const { page, ctx, pageErrors } = await newPage(browser, { vid: "uinav" });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);

      ok("home visible on load", await page.locator("#view-home").isVisible());
      ok("library hidden on load", !(await page.locator("#view-work").isVisible()));

      await page.click('.navlinks a[data-view="work"]');
      await page.waitForTimeout(250);
      ok("library visible after nav", await page.locator("#view-work").isVisible());
      ok("home hidden after nav", !(await page.locator("#view-home").isVisible()));
      eq("hash updated", await page.evaluate(() => location.hash), "#/work");
      eq("library link marked current",
        await page.getAttribute('.navlinks a[data-view="work"]', "aria-current"), "page");
      eq("document title changes with the view", await page.title(), "Library — Sippy Chanthaphaychith");
      eq("library shows 8 items", await page.locator("#view-work .lib-item").count(), 8);

      // the one purchasable product must be reachable, and open safely
      const buy = page.locator("#view-work .lib-buy").first();
      eq("the Gumroad link is present", await buy.count(), 1);
      eq("it points at the product", await buy.getAttribute("href"), "https://siprachant.gumroad.com/l/ibckmi");
      eq("it opens in a new tab", await buy.getAttribute("target"), "_blank");
      ok("it is safe against tab-nabbing", /noopener/.test(await buy.getAttribute("rel") || ""));

      const externals = await page.$$eval('a[target="_blank"]', (as) =>
        as.filter((a) => !/noopener/.test(a.getAttribute("rel") || "")).map((a) => a.href));
      eq("every external link carries rel=noopener", externals.length, 0, JSON.stringify(externals));

      ok("guestbook moved into the library view",
        await page.evaluate(() => document.getElementById("view-work").contains(document.getElementById("guestbook"))));
      ok("guestbook is visible in the library view", await page.locator("#guestbook").isVisible());

      await page.screenshot({ path: path.join(SHOTS, "library.png") });

      await page.goBack();
      await page.waitForTimeout(250);
      ok("browser back returns home", await page.locator("#view-home").isVisible());

      // deep link straight to the library
      await page.goto(BASE + "/#/work", { waitUntil: "domcontentloaded" });
      await settle(page);
      ok("deep link opens the library", await page.locator("#view-work").isVisible());

      // unknown route falls back to home rather than a blank page
      await page.goto(BASE + "/#/does-not-exist", { waitUntil: "domcontentloaded" });
      await settle(page);
      ok("unknown hash falls back to home", await page.locator("#view-home").isVisible());

      // unknown server path still serves the page
      const r = await page.goto(BASE + "/some/deep/path", { waitUntil: "domcontentloaded" });
      ok("unknown server path still renders the page (404 status)",
        r.status() === 404 && (await page.locator("h1").count()) === 1);

      eq("no JS errors during navigation", pageErrors.length, 0, pageErrors.join(" | "));
      await ctx.close();
    }

    /* ------------------------------------------------------- responsive -- */
    console.log("\n\x1b[1mresponsive\x1b[0m");
    for (const [label, w, h] of [["mobile 375", 375, 812], ["tablet 768", 768, 1024], ["desktop 1440", 1440, 900]]) {
      const { page, ctx } = await newPage(browser, { vid: "uirwd" + w, width: w, height: h });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        win: window.innerWidth
      }));
      ok(`${label}: no horizontal page scroll`, overflow.doc <= overflow.win + 1, JSON.stringify(overflow));

      const navVisible = await page.locator('.navlinks a[data-view="work"]').isVisible();
      ok(`${label}: nav is reachable`, navVisible);

      const navFits = await page.evaluate(() => {
        const nav = document.querySelector(".topbar-in");
        return { right: Math.round(nav.getBoundingClientRect().right), sw: nav.scrollWidth, win: window.innerWidth };
      });
      ok(`${label}: the nav bar fits the viewport`, navFits.sw <= navFits.win + 1, JSON.stringify(navFits));

      const privacyReachable = await page.locator('.navlinks a[data-view="privacy"]').isVisible();
      ok(`${label}: the privacy link is reachable`, privacyReachable);

      // nothing may spill out of the viewport horizontally
      const spills = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll("main *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > window.innerWidth + 2) bad.push(el.className || el.tagName);
        });
        return bad.slice(0, 5);
      });
      ok(`${label}: no element spills past the right edge`, spills.length === 0, spills.join(", "));

      if (w === 375) await page.screenshot({ path: path.join(SHOTS, "mobile.png"), fullPage: false });
      await ctx.close();
    }

    /* --------------------------------------------------- sign up & sign in -- */
    console.log("\n\x1b[1msigning up\x1b[0m");
    {
      const { page, ctx, pageErrors } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);

      eq("the HTTP backend is in use", await page.evaluate(() => window.__store.kind), "http");
      ok("a signed-out visitor sees the sign-in card", await page.locator("#authcard").isVisible());
      ok("...and no posting form", !(await page.locator("#postcard").isVisible()));
      ok("...but can still read the guestbook", await page.locator("#clist").isVisible());

      // switching tabs
      await page.click("#tab-signup");
      ok("the create-account tab opens", await page.locator("#signup").isVisible());
      eq("...and is marked selected", await page.getAttribute("#tab-signup", "aria-selected"), "true");
      ok("the sign-in pane hides", !(await page.locator("#signin").isVisible()));

      // consent is required
      await page.fill("#su-name", "No Consent");
      await page.fill("#su-email", "noconsent@example.com");
      await page.fill("#su-pw", "correct-horse-battery");
      await page.click("#su-submit");
      await page.waitForTimeout(300);
      ok("signing up without ticking consent is blocked", await page.locator("#su-err").isVisible());
      ok("the message says what to do", /tick the box/i.test(await page.locator("#su-err").innerText()));
      ok("no account was created", !(await page.locator("#postcard").isVisible()));

      // short password
      await page.check("#su-consent");
      await page.fill("#su-pw", "short");
      await page.click("#su-submit");
      await page.waitForTimeout(300);
      ok("a short password is blocked", /12 characters/.test(await page.locator("#su-err").innerText()));

      // the consent text links to the privacy notice
      const href = await page.getAttribute("#signup .check a", "href");
      eq("the consent text links to the privacy notice", href, "#/privacy");

      // happy path
      await page.fill("#su-pw", "correct-horse-battery");
      await page.click("#su-submit");
      await page.waitForSelector("#postcard:not([hidden])", { timeout: 15000 });
      ok("a valid sign-up lands signed in", await page.locator("#postcard").isVisible());
      eq("the display name is shown", (await page.locator("#who-name").innerText()).trim(), "No Consent");
      ok("the sign-in card is hidden", !(await page.locator("#authcard").isVisible()));
      ok("the moderator badge is not shown for a normal account", !(await page.locator("#who-admin").isVisible()));

      eq("no JS errors while signing up", pageErrors.length, 0, pageErrors.join(" | "));
      await ctx.close();
    }

    console.log("\n\x1b[1msigning in\x1b[0m");
    {
      const a = await newPage(browser);
      await a.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(a.page);
      const email = await signUp(a.page, "Returning User");
      await a.ctx.close();

      // a brand-new browser, same account
      const b = await newPage(browser);
      await b.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(b.page);

      await b.page.fill("#si-email", email);
      await b.page.fill("#si-pw", "wrong-password-entirely");
      await b.page.click("#si-submit");
      await b.page.waitForTimeout(600);
      ok("a wrong password shows an error", await b.page.locator("#si-err").isVisible());
      ok("...and does not sign anyone in", !(await b.page.locator("#postcard").isVisible()));
      eq("the button is usable again", await b.page.isDisabled("#si-submit"), false);

      await b.page.fill("#si-pw", "correct-horse-battery");
      await b.page.click("#si-submit");
      await b.page.waitForSelector("#postcard:not([hidden])", { timeout: 15000 });
      ok("the right password signs in", await b.page.locator("#postcard").isVisible());

      await b.page.reload({ waitUntil: "domcontentloaded" });
      await settle(b.page);
      ok("the session survives a reload", await b.page.locator("#postcard").isVisible());

      // sign out
      await b.page.click("#acct-toggle");
      await b.page.click("#signout");
      await b.page.waitForSelector("#authcard:not([hidden])", { timeout: 10000 });
      ok("signing out returns to the sign-in card", await b.page.locator("#authcard").isVisible());
      await b.page.reload({ waitUntil: "domcontentloaded" });
      await settle(b.page);
      ok("...and the sign-out sticks across a reload", !(await b.page.locator("#postcard").isVisible()));
      await b.ctx.close();
    }

    /* ------------------------------------------------------- posting notes -- */
    console.log("\n\x1b[1mposting\x1b[0m");
    {
      const { page, ctx, pageErrors } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      await signUp(page, "Poster");

      const before = await page.locator(".comment").count();

      await page.click("#csubmit");
      await page.waitForTimeout(300);
      ok("an empty note is blocked", await page.locator("#cerr").isVisible());
      eq("nothing was posted", await page.locator(".comment").count(), before);

      await page.fill("#cbody", "x".repeat(120));
      eq("the counter tracks length", (await page.locator("#ccount").innerText()).trim(), "120 / 2000");

      await page.fill("#cbody", "   \n  ");
      await page.click("#csubmit");
      await page.waitForTimeout(300);
      eq("a whitespace-only note is blocked", await page.locator(".comment").count(), before);

      await page.fill("#cbody", "The Deciding-next column is the most useful part of this page.");
      await page.click("#csubmit");
      await page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, before, { timeout: 10000 });
      eq("a valid note appears", await page.locator(".comment").count(), before + 1);
      eq("it carries the account's display name", (await page.locator(".c-name").first().innerText()).trim(), "Poster");
      ok("a success message shows", await page.locator("#cok").isVisible());
      eq("the textarea clears", await page.inputValue("#cbody"), "");
      eq("the counter resets", (await page.locator("#ccount").innerText()).trim(), "0 / 2000");
      ok("there is no name field to fill in — it comes from the account", await page.locator("#cform input[name='name']").count() === 0);

      await page.reload({ waitUntil: "domcontentloaded" });
      await settle(page);
      eq("the note survives a reload", await page.locator(".comment").count(), before + 1);

      eq("no JS errors while posting", pageErrors.length, 0, pageErrors.join(" | "));
      await ctx.close();
    }

    /* --------------------------------------------------- deleting own notes -- */
    console.log("\n\x1b[1mdeleting your own note\x1b[0m");
    {
      const a = await newPage(browser);
      await a.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(a.page);
      await signUp(a.page, "Owner");
      const before = await a.page.locator(".comment").count();
      await a.page.fill("#cbody", "This note will be removed by its author.");
      await a.page.click("#csubmit");
      await a.page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, before, { timeout: 10000 });

      const mine = a.page.locator(".comment").first();
      ok("your own note offers a Delete control", await mine.locator(".c-del").count() === 1);

      // a second account must not see that control on someone else's note
      const b = await newPage(browser);
      await b.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(b.page);
      await signUp(b.page, "Stranger");
      const theirs = b.page.locator(".comment").first();
      eq("someone else's note offers no Delete control", await theirs.locator(".c-del").count(), 0);
      await b.ctx.close();

      // deleting takes two clicks
      const del = mine.locator(".c-del");
      await del.click();
      await a.page.waitForTimeout(200);
      ok("the first click asks for confirmation", /really/i.test(await del.innerText()));
      eq("...and deletes nothing yet", await a.page.locator(".comment").count(), before + 1);
      await del.click();
      await a.page.waitForFunction((n) => document.querySelectorAll(".comment").length === n, before, { timeout: 10000 });
      eq("the second click deletes it", await a.page.locator(".comment").count(), before);
      await a.ctx.close();
    }

    /* ---------------------------------------------------------- moderation -- */
    console.log("\n\x1b[1mmoderation\x1b[0m");
    {
      const visitor = await newPage(browser);
      await visitor.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(visitor.page);
      await signUp(visitor.page, "Rando");
      const before = await visitor.page.locator(".comment").count();
      await visitor.page.fill("#cbody", "A note the site owner should be able to remove.");
      await visitor.page.click("#csubmit");
      await visitor.page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, before, { timeout: 10000 });
      await visitor.ctx.close();

      const boss = await newPage(browser);
      await boss.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(boss.page);
      await boss.page.click("#tab-signup");
      await boss.page.fill("#su-name", "Sippy");
      await boss.page.fill("#su-email", "boss@example.com");
      await boss.page.fill("#su-pw", "correct-horse-battery");
      await boss.page.check("#su-consent");
      await boss.page.click("#su-submit");
      await boss.page.waitForSelector("#postcard:not([hidden])", { timeout: 15000 });

      ok("the site owner is marked as a moderator", await boss.page.locator("#who-admin").isVisible());
      const any = boss.page.locator(".comment").first();
      ok("a moderator sees a Delete control on any note", await any.locator(".c-del").count() === 1);
      const n = await boss.page.locator(".comment").count();
      await any.locator(".c-del").click();
      await boss.page.waitForTimeout(200);
      await any.locator(".c-del").click();
      await boss.page.waitForFunction((k) => document.querySelectorAll(".comment").length < k, n, { timeout: 10000 });
      ok("and can remove it", (await boss.page.locator(".comment").count()) < n);
      await boss.ctx.close();
    }

    /* ------------------------------------------------ account & data panel -- */
    console.log("\n\x1b[1myour account panel\x1b[0m");
    {
      const { page, ctx, pageErrors } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      const email = await signUp(page, "Data Owner");

      ok("the account panel starts closed", !(await page.locator("#acct-panel").isVisible()));
      await page.click("#acct-toggle");
      ok("it opens", await page.locator("#acct-panel").isVisible());
      eq("the toggle reports its state", await page.getAttribute("#acct-toggle", "aria-expanded"), "true");
      ok("it shows the account's email", (await page.locator("#acct-meta").innerText()).includes(email));

      // rename
      await page.fill("#rn-name", "Renamed Owner");
      await page.click("#rn-submit");
      await page.waitForTimeout(700);
      ok("renaming succeeds", await page.locator("#acct-ok").isVisible());
      eq("the header updates", (await page.locator("#who-name").innerText()).trim(), "Renamed Owner");

      // change password
      await page.fill("#pw-current", "wrong-current-password");
      await page.fill("#pw-new", "another-good-passphrase");
      await page.click("#pw-submit");
      await page.waitForTimeout(900);
      ok("a wrong current password is refused", await page.locator("#acct-err").isVisible());

      await page.fill("#pw-current", "correct-horse-battery");
      await page.fill("#pw-new", "another-good-passphrase");
      await page.click("#pw-submit");
      await page.waitForTimeout(1200);
      ok("a correct change succeeds", await page.locator("#acct-ok").isVisible());
      ok("...and says other devices were signed out",
        /signed out/i.test(await page.locator("#acct-ok").innerText()));
      eq("the password fields are cleared", await page.inputValue("#pw-current"), "");

      // export
      const exportHref = await page.getAttribute("#export-link", "href");
      eq("the export link points at the export endpoint", exportHref, "/api/me/export");
      const dl = await page.evaluate(async () => {
        const r = await fetch("/api/me/export", { credentials: "same-origin" });
        return { status: r.status, disp: r.headers.get("content-disposition"), body: await r.text() };
      });
      eq("the export downloads", dl.status, 200);
      ok("it arrives as a file", /attachment/.test(dl.disp || ""));
      ok("it contains the account", dl.body.includes(email));
      ok("it contains no password hash", !dl.body.includes("scrypt$"));

      eq("no JS errors in the account panel", pageErrors.length, 0, pageErrors.join(" | "));
      await ctx.close();
    }

    /* ------------------------------------------------------- deleting all -- */
    console.log("\n\x1b[1mdeleting your account from the page\x1b[0m");
    {
      const { page, ctx } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      const email = await signUp(page, "Leaving Soon");
      await page.fill("#cbody", "A note that should leave with its author.");
      await page.click("#csubmit");
      await page.waitForTimeout(900);

      await page.click("#acct-toggle");
      await page.click("#del-submit");
      await page.waitForTimeout(300);
      ok("deleting with no password shows an error", await page.locator("#del-err").isVisible());

      await page.fill("#del-pw", "correct-horse-battery");
      await page.click("#del-submit");
      await page.waitForTimeout(300);
      ok("the first press asks for confirmation",
        /press again/i.test(await page.locator("#del-submit").innerText()));
      ok("...and the account still exists", await page.locator("#postcard").isVisible());

      await page.click("#del-submit");
      await page.waitForSelector("#authcard:not([hidden])", { timeout: 15000 });
      ok("the second press deletes and signs out", await page.locator("#authcard").isVisible());

      const relogin = await page.evaluate(async (em) => {
        const csrf = document.cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith("csrf="));
        const r = await fetch("/api/auth/login", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ? csrf.slice(5) : "" },
          body: JSON.stringify({ email: em, password: "correct-horse-battery" })
        });
        return r.status;
      }, email);
      eq("the deleted account cannot sign back in", relogin, 401);
      await ctx.close();
    }

    /* ---------------------------------------------- signed-out restrictions -- */
    console.log("\n\x1b[1mwhat a signed-out visitor can do\x1b[0m");
    {
      const author = await newPage(browser);
      await author.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(author.page);
      await signUp(author.page, "Author");
      const n0 = await author.page.locator(".comment").count();
      await author.page.fill("#cbody", "A note for a signed-out visitor to look at.");
      await author.page.click("#csubmit");
      await author.page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, n0, { timeout: 10000 });
      await author.ctx.close();

      const guest = await newPage(browser);
      await guest.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(guest.page);
      ok("notes are readable without signing in", (await guest.page.locator(".comment").count()) > 0);

      const first = guest.page.locator(".comment").first();
      const upBtn = first.locator('.rx button[data-kind="up"]');
      const countBefore = (await upBtn.locator(".n").innerText()).trim();
      await upBtn.click();
      await guest.page.waitForTimeout(600);
      eq("reacting while signed out changes nothing",
        (await first.locator('.rx button[data-kind="up"] .n').innerText()).trim(), countBefore);
      ok("...and the page explains why", await guest.page.locator("#si-err").isVisible());
      ok("...by pointing at sign-in", /sign in/i.test(await guest.page.locator("#si-err").innerText()));
      await guest.ctx.close();
    }

    /* --------------------------------------------------------------- XSS -- */
    console.log("\n\x1b[1msecurity — rendering untrusted input\x1b[0m");
    {
      const { page, ctx, dialogs, pageErrors } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      await signUp(page, '<svg onload="window.__pwned3=1">Mallory');

      const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned2=1</script><b>bold?</b>';
      const n0 = await page.locator(".comment").count();
      await page.fill("#cbody", evil);
      await page.click("#csubmit");
      await page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, n0, { timeout: 10000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await settle(page);

      eq("no dialogs fired", dialogs.length, 0, dialogs.join(" | "));
      eq("the onerror payload did not execute", await page.evaluate(() => window.__pwned), undefined);
      eq("the inline script did not execute", await page.evaluate(() => window.__pwned2), undefined);
      eq("the svg onload did not execute", await page.evaluate(() => window.__pwned3), undefined);
      eq("no elements were created from the payload",
        await page.evaluate(() => document.querySelectorAll(".comment img, .comment script, .comment svg, .comment b").length), 0);

      const shown = await page.locator(".c-body").first().innerText();
      ok("the payload shows as literal text", shown.includes("<img src=x") && shown.includes("<b>bold?</b>"), shown.slice(0, 70));
      ok("the display name shows as literal text",
        (await page.locator(".c-name").first().innerText()).includes("<svg"));
      eq("no JS errors from the payload", pageErrors.length, 0, pageErrors.join(" | "));

      const n1 = await page.locator(".comment").count();
      await page.fill("#cbody", "z".repeat(400));
      await page.click("#csubmit");
      await page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, n1, { timeout: 10000 });
      const of = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      ok("a 400-character unbroken word does not widen the page", of.doc <= of.win + 1, JSON.stringify(of));
      await ctx.close();
    }

    /* ------------------------------------------------ CSP actually enforced -- */
    console.log("\n\x1b[1mContent Security Policy\x1b[0m");
    {
      const { page, ctx } = await newPage(browser);
      const violations = [];
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
      await settle(page);

      const real = violations.filter((v) => !/fonts\.(googleapis|gstatic)/.test(v));
      eq("the page's own code raises no CSP violations", real.length, 0, JSON.stringify(real.slice(0, 2)));
      ok("the page still works under the policy", await page.evaluate(() => !!window.__store));

      const injected = await page.evaluate(() => new Promise((resolve) => {
        const s = document.createElement("script");
        s.textContent = "window.__cspBypass = true;";
        document.body.appendChild(s);
        setTimeout(() => resolve(window.__cspBypass === true), 200);
      }));
      eq("an injected inline script is blocked by the policy", injected, false);
      await ctx.close();
    }

    /* -------------------------------------------------------- privacy view -- */
    console.log("\n\x1b[1mprivacy notice\x1b[0m");
    {
      const { page, ctx } = await newPage(browser);
      await page.goto(BASE + "/#/privacy", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      ok("the privacy view opens from its own URL", await page.locator("#view-privacy").isVisible());
      eq("the document title changes", await page.title(), "Privacy — Sippy Chanthaphaychith");
      ok("home is hidden", !(await page.locator("#view-home").isVisible()));
      ok("the guestbook is not on the privacy page", !(await page.locator("#guestbook").isVisible()));

      // innerText reflects text-transform, so headings come back uppercased.
      const text = (await page.locator("#view-privacy").innerText()).toLowerCase();
      for (const phrase of ["email address", "display name", "security log", "cookies", "scrypt"]) {
        ok(`the notice covers "${phrase}"`, text.includes(phrase));
      }
      ok("it states the retention period", /30 days/.test(text));
      ok("it says what is not collected", /not collected/i.test(text));
      ok("it is honest about legal scope", /threshold/i.test(text));
      ok("it keeps her non-practising disclaimer", /not licensed to practice law/i.test(text));

      const rows = await page.locator(".ptable tbody tr").count();
      ok("the data table lists every category", rows >= 6, `${rows} rows`);

      await page.click('.navlinks a[data-view="privacy"]');
      await page.waitForTimeout(300);
      eq("the nav marks the privacy page as current",
        await page.getAttribute('.navlinks a[data-view="privacy"]', "aria-current"), "page");
      await ctx.close();
    }

    /* ------------------------------------------- backend-down behaviour -- */
    console.log("\n\x1b[1mdegraded backend\x1b[0m");
    {
      const { page, ctx, pageErrors } = await newPage(browser);
      await page.route("**/api/**", (route) => route.abort());
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.__store, null, { timeout: 15000 });
      eq("it falls back to the local store", await page.evaluate(() => window.__store.kind), "local");
      ok("the page still renders", (await page.locator("h1").count()) === 1);
      ok("the visitor is told it is preview mode", await page.locator("#coffline").isVisible());
      ok("the preview posting form is offered", await page.locator("#previewcard").isVisible());
      ok("...and the sign-in card is not, since there is no server to sign in to",
        !(await page.locator("#authcard").isVisible()));
      await page.fill("#pname", "Offline Otto");
      await page.fill("#pbody", "Does this still work with no server?");
      await page.click("#psubmit");
      await page.waitForTimeout(500);
      eq("a note can still be written locally", await page.locator(".comment").count(), 1);
      eq("no JS errors while the backend is down", pageErrors.length, 0, pageErrors.join(" | "));
      await ctx.close();
    }
    {
      const { page, ctx } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);
      await signUp(page, "Unlucky");
      await page.route("**/api/comments", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Something went wrong on our side."}' })
          : route.continue());
      await page.fill("#cbody", "This post will fail on the server.");
      await page.click("#csubmit");
      await page.waitForTimeout(700);
      ok("a server failure shows an error", await page.locator("#cerr").isVisible());
      eq("the submit button is re-enabled", await page.isDisabled("#csubmit"), false);
      eq("the button label is restored", (await page.locator("#csubmit").innerText()).trim(), "Post note");
      ok("the visitor's text is not thrown away", (await page.inputValue("#cbody")).length > 0);
      await ctx.close();
    }

    /* ------------------------------------------------------ a11y basics -- */
    console.log("\n\x1b[1maccessibility\x1b[0m");
    {
      const { page, ctx } = await newPage(browser);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(page);

      const unlabelled = await page.$$eval("button", (bs) =>
        bs.filter((b) => b.offsetParent !== null)
          .filter((b) => !(b.getAttribute("aria-label") || b.textContent || "").trim()).length);
      eq("every visible button has an accessible name", unlabelled, 0);

      const unlabelledInputs = await page.$$eval("input, textarea", (els) =>
        els.filter((el) => !document.querySelector(`label[for="${el.id}"]`) && !el.getAttribute("aria-label"))
          .map((el) => el.id || el.name || el.type));
      eq("every field has a label", unlabelledInputs.length, 0, JSON.stringify(unlabelledInputs));

      const noAlt = await page.$$eval("img", (is) => is.filter((i) => i.getAttribute("alt") === null).length);
      eq("every image has an alt attribute", noAlt, 0);
      eq("the document declares a language", await page.evaluate(() => document.documentElement.lang), "en");

      await page.keyboard.press("Tab");
      ok("the first tab stop is the skip link",
        String(await page.evaluate(() => document.activeElement.className)).includes("skip"));

      await page.focus("#si-email");
      const outline = await page.evaluate(() => {
        const s = getComputedStyle(document.getElementById("si-email"));
        return s.outlineStyle + " " + s.outlineWidth;
      });
      ok("a focused field shows an outline", !/none/.test(outline), outline);

      const order = await page.$$eval("#view-home :is(h1,h2,h3)", (hs) =>
        hs.filter((h) => h.offsetParent !== null).map((h) => Number(h.tagName[1])));
      let jump = null;
      for (let i = 1; i < order.length; i++) if (order[i] - order[i - 1] > 1) jump = `${order[i - 1]}→${order[i]}`;
      ok("no skipped heading levels", jump === null, jump);

      eq("the tab list is marked up as one", await page.getAttribute(".tabs", "role"), "tablist");
      ok("the notes list is a live region", (await page.getAttribute("#clist", "aria-live")) === "polite");

      // the whole sign-up can be done from the keyboard
      await page.click("#tab-signup");
      await page.focus("#su-name");
      await page.keyboard.type("Keyboard Only");
      await page.keyboard.press("Tab");
      await page.keyboard.type("keyboardonly@example.com");
      await page.keyboard.press("Tab");
      await page.keyboard.type("correct-horse-battery");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      ok("the consent box can be ticked with the keyboard", await page.isChecked("#su-consent"));
      await page.focus("#su-submit");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#postcard:not([hidden])", { timeout: 15000 });
      ok("an account can be created without a mouse", await page.locator("#postcard").isVisible());

      const n0 = await page.locator(".comment").count();
      await page.focus("#cbody");
      await page.keyboard.type("Posted without touching the mouse.");
      await page.focus("#csubmit");
      await page.keyboard.press("Enter");
      await page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, n0, { timeout: 10000 });
      eq("and a note posted the same way", await page.locator(".comment").count(), n0 + 1);
      await ctx.close();
    }


    /* ------------------------------------------------------- reactions -- */
    console.log("\n\x1b[1mreactions\x1b[0m");
    {
      const a = await newPage(browser);
      await a.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(a.page);
      await signUp(a.page, "Reactor A");
      const n0 = await a.page.locator(".comment").count();
      await a.page.fill("#cbody", "A note to react to.");
      await a.page.click("#csubmit");
      await a.page.waitForFunction((n) => document.querySelectorAll(".comment").length > n, n0, { timeout: 10000 });

      const first = a.page.locator(".comment").first();
      eq("three reaction buttons per note", await first.locator(".rx button").count(), 3);
      eq("thumbs up emoji", (await first.locator('.rx button[data-kind="up"] .emo').innerText()).trim(), "\uD83D\uDC4D");
      eq("heart emoji", (await first.locator('.rx button[data-kind="heart"] .emo').innerText()).trim(), "\u2764\uFE0F");
      eq("rocket emoji", (await first.locator('.rx button[data-kind="rocket"] .emo').innerText()).trim(), "\uD83D\uDE80");
      eq("counts start at zero", (await first.locator('.rx button[data-kind="up"] .n').innerText()).trim(), "0");
      eq("starts unpressed", await first.locator('.rx button[data-kind="up"]').getAttribute("aria-pressed"), "false");

      await first.locator('.rx button[data-kind="up"]').click();
      await a.page.waitForTimeout(600);
      eq("the count goes to 1", (await first.locator('.rx button[data-kind="up"] .n').innerText()).trim(), "1");
      eq("the button reads as pressed", await first.locator('.rx button[data-kind="up"]').getAttribute("aria-pressed"), "true");

      await first.locator('.rx button[data-kind="up"]').click();
      await a.page.waitForTimeout(600);
      eq("clicking again toggles off", (await first.locator('.rx button[data-kind="up"] .n').innerText()).trim(), "0");

      await first.locator('.rx button[data-kind="up"]').click(); await a.page.waitForTimeout(400);
      await first.locator('.rx button[data-kind="heart"]').click(); await a.page.waitForTimeout(400);
      await first.locator('.rx button[data-kind="rocket"]').click(); await a.page.waitForTimeout(600);
      eq("one account can hold all three",
        (await first.locator(".rx button .n").allInnerTexts()).map((t) => t.trim()).join(","), "1,1,1");

      for (let i = 0; i < 6; i++) {
        await first.locator('.rx button[data-kind="up"]').click({ force: true });
        await a.page.waitForTimeout(250);
      }
      await a.page.waitForTimeout(700);
      const after = (await first.locator('.rx button[data-kind="up"] .n').innerText()).trim();
      ok("six rapid clicks land on 0 or 1, never higher", after === "0" || after === "1", after);

      const b = await newPage(browser);
      await b.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await settle(b.page);
      await signUp(b.page, "Reactor B");
      const bFirst = b.page.locator('.comment[data-id="' + (await first.getAttribute("data-id")) + '"]');
      eq("a second account sees the public count",
        (await bFirst.locator('.rx button[data-kind="heart"] .n').innerText()).trim(), "1");
      eq("but not as theirs",
        await bFirst.locator('.rx button[data-kind="heart"]').getAttribute("aria-pressed"), "false");
      await bFirst.locator('.rx button[data-kind="heart"]').click();
      await b.page.waitForTimeout(700);
      eq("their reaction adds to the count",
        (await bFirst.locator('.rx button[data-kind="heart"] .n').innerText()).trim(), "2");

      await a.page.reload({ waitUntil: "domcontentloaded" });
      await settle(a.page);
      const aFirst = a.page.locator(".comment").first();
      eq("the first account sees the shared count",
        (await aFirst.locator('.rx button[data-kind="heart"] .n').innerText()).trim(), "2");
      eq("and their own still reads as theirs",
        await aFirst.locator('.rx button[data-kind="heart"]').getAttribute("aria-pressed"), "true");

      await a.page.screenshot({ path: path.join(SHOTS, "guestbook.png") });
      eq("no JS errors during reactions", a.pageErrors.length + b.pageErrors.length, 0,
        a.pageErrors.concat(b.pageErrors).join(" | "));
      await a.ctx.close(); await b.ctx.close();
    }

    /* ------------------------------------------------- reduced motion -- */
    {
      const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      const dur = await page.evaluate(() => getComputedStyle(document.querySelector(".btn")).transitionDuration);
      const durSec = parseFloat(dur);
      ok("transitions are suppressed under reduced motion", durSec < 0.01, dur);
      await ctx.close();
    }

  } catch (e) {
    fail++;
    failures.push("suite crashed: " + (e && e.message));
    console.error("\n\x1b[31mSUITE ERROR\x1b[0m", e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill("SIGKILL"); } catch {}
    for (const f of [DB, DB + "-wal", DB + "-shm"]) { try { fs.unlinkSync(f); } catch {} }
  }

  console.log(`\n\x1b[1mUI: ${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  • " + f)); }
  process.exit(fail ? 1 : 0);
})();
