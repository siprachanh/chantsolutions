(function () {
  "use strict";

  /* =================================================================== theme */
  var root = document.documentElement;
  var THEME_KEY = "sippy.theme";
  function readStored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeStored(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var stored = readStored(THEME_KEY);
  if (stored === "dark" || stored === "light") root.setAttribute("data-theme", stored);

  function currentTheme() {
    var attr = root.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  var themebtn = document.getElementById("themebtn");
  if (themebtn) {
    themebtn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      writeStored(THEME_KEY, next);
      themebtn.setAttribute("aria-label", next === "dark" ? "Switch to light theme" : "Switch to dark theme");
    });
  }
  var yr = document.getElementById("yr");
  if (yr) yr.textContent = String(new Date().getFullYear());

  /* ================================================================= routing */
  var panels = {
    home: document.getElementById("view-home"),
    work: document.getElementById("view-work"),
    privacy: document.getElementById("view-privacy")
  };
  var gb = document.getElementById("guestbook");
  var slots = {
    home: document.getElementById("guestbook-home"),
    work: document.getElementById("guestbook-work")
  };
  var TITLES = {
    home: "Sippy Chanthaphaychith",
    work: "Library — Sippy Chanthaphaychith",
    privacy: "Privacy — Sippy Chanthaphaychith"
  };

  function viewFromHash(h) {
    var s = String(h || "").replace(/^#/, "").replace(/^\//, "");
    if (s === "work") return "work";
    if (s === "privacy") return "privacy";
    return "home";
  }

  function render(view, opts) {
    opts = opts || {};
    Object.keys(panels).forEach(function (k) {
      if (panels[k]) panels[k].hidden = k !== view;
    });
    // One guestbook node, moved into whichever view should show it. Views with
    // no slot — the privacy notice — park it inside the hidden Home panel, so
    // landing straight on #/privacy never leaves a guestbook floating below it.
    var slot = slots[view] || slots.home;
    if (gb && slot && gb.parentNode !== slot) slot.appendChild(gb);
    document.querySelectorAll(".navlinks a[data-view]").forEach(function (a) {
      if (a.getAttribute("data-view") === view) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.title = TITLES[view] || TITLES.home;
    if (!opts.silent) window.scrollTo({ top: 0, behavior: opts.instant ? "auto" : "smooth" });
  }

  function applyHash(instant) {
    var raw = String(location.hash || "");
    if (raw === "#guestbook") {
      var el = document.getElementById("guestbook");
      if (el) el.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
      return;
    }
    render(viewFromHash(raw), { instant: instant });
  }

  document.addEventListener("click", function (e) {
    var jump = e.target.closest && e.target.closest("a[data-jump]");
    if (jump) {
      e.preventDefault();
      // The guestbook only lives on Home and Library — bounce back if we're elsewhere.
      if (!document.getElementById("guestbook").offsetParent) location.hash = "#/";
      var el = document.getElementById(jump.getAttribute("href").slice(1));
      if (el) setTimeout(function () { el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 30);
      return;
    }
    var nav = e.target.closest && e.target.closest("a[data-nav]");
    if (nav) {
      e.preventDefault();
      var href = nav.getAttribute("href") || "#/";
      if (location.hash === href) applyHash(true);
      else location.hash = href;
    }
  });
  window.addEventListener("hashchange", function () { applyHash(false); });
  applyHash(true);

  /* ============================================================ http client */
  var KINDS = ["up", "heart", "rocket"];
  var EMOJI = { up: "👍", heart: "❤️", rocket: "🚀" };
  var LABEL = { up: "Thumbs up", heart: "Heart", rocket: "Rocket" };

  function cookie(name) {
    var parts = String(document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0].trim() === name) {
        try { return decodeURIComponent(kv.slice(1).join("=").trim()); }
        catch (e) { return kv.slice(1).join("=").trim(); }
      }
    }
    return null;
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { "Accept": "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    var token = cookie("csrf");
    if (token) headers["X-CSRF-Token"] = token;
    return fetch(path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error((j && j.error) || "That didn't work. Try again in a moment.");
          e.status = r.status;
          throw e;
        }
        return j;
      });
    });
  }

  function newId() {
    var b = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(b);
    var s = "c" + Date.now().toString(36);
    for (var i = 0; i < b.length; i++) s += b[i].toString(36);
    return s.slice(0, 48);
  }

  /* ================================================================= stores */

  /** The deployed site: real accounts, real sessions. */
  function httpStore() {
    var listeners = [];
    var cache = [];
    var timer = null;

    function emit() { listeners.forEach(function (fn) { fn(cache); }); }
    function refresh() {
      return api("/api/comments").then(function (j) {
        cache = (j && j.comments) || [];
        emit();
        return cache;
      });
    }
    return {
      kind: "http",
      hasAccounts: true,
      subscribe: function (fn) {
        listeners.push(fn);
        refresh().catch(function () { emit(); });
        if (!timer) timer = setInterval(function () { refresh().catch(function () {}); }, 20000);
        return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
      },
      session: function () { return api("/api/session"); },
      register: function (payload) { return api("/api/auth/register", { method: "POST", body: payload }); },
      login: function (payload) { return api("/api/auth/login", { method: "POST", body: payload }); },
      logout: function () { return api("/api/auth/logout", { method: "POST", body: {} }); },
      logoutAll: function () { return api("/api/auth/logout-all", { method: "POST", body: {} }); },
      patchMe: function (payload) { return api("/api/me", { method: "PATCH", body: payload }); },
      deleteMe: function (payload) { return api("/api/me", { method: "DELETE", body: payload }); },
      add: function (_name, body) { return api("/api/comments", { method: "POST", body: { body: body } }).then(refresh); },
      remove: function (id) { return api("/api/comments/" + encodeURIComponent(id), { method: "DELETE" }).then(refresh); },
      react: function (id, kind) {
        return api("/api/comments/" + encodeURIComponent(id) + "/reactions", { method: "POST", body: { kind: kind } })
          .then(refresh);
      },
      refresh: refresh
    };
  }

  /** Published-artifact preview: shared store, no accounts to sign in to. */
  function dbStore(db) {
    var vid = readStored("sippy.vid");
    if (!vid || !/^[A-Za-z0-9_-]{4,64}$/.test(vid)) {
      var bytes = new Uint8Array(12);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      vid = "v";
      for (var i = 0; i < bytes.length; i++) vid += bytes[i].toString(36);
      vid = vid.slice(0, 40);
      writeStored("sippy.vid", vid);
    }

    var comments = [];
    var reactions = {};
    var listeners = [];
    var ready = false;

    function shape() {
      return comments.map(function (c) {
        var per = reactions[c.id] || {};
        var counts = { up: 0, heart: 0, rocket: 0 };
        var mine = { up: false, heart: false, rocket: false };
        Object.keys(per).forEach(function (who) {
          (per[who] || []).forEach(function (k) {
            if (counts[k] === undefined) return;
            counts[k]++;
            if (who === vid) mine[k] = true;
          });
        });
        return {
          id: c.id, name: c.name, body: c.body, createdAt: c.createdAt,
          isMine: c.vid === vid, reactions: counts, mine: mine
        };
      });
    }
    function emit() { if (ready) listeners.forEach(function (fn) { fn(shape()); }); }

    db.collection("comments").orderBy("ts", "desc").limit(200).onSnapshot(function (snap) {
      comments = snap.docs.map(function (d) {
        var v = d.data() || {};
        return {
          id: d.id,
          name: typeof v.name === "string" ? v.name : "",
          body: typeof v.body === "string" ? v.body : "",
          vid: typeof v.vid === "string" ? v.vid : "",
          createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date(Number(v.ts) || Date.now()).toISOString()
        };
      });
      ready = true;
      emit();
    }, function () { ready = true; emit(); });

    db.collection("reactions").limit(1000).onSnapshot(function (snap) {
      var next = {};
      snap.docs.forEach(function (d) {
        var v = d.data() || {};
        var cid = String(v.cid || ""), who = String(v.vid || "");
        if (!cid || !who) return;
        var ks = Array.isArray(v.kinds) ? v.kinds.filter(function (k) { return KINDS.indexOf(k) !== -1; }) : [];
        if (!next[cid]) next[cid] = {};
        next[cid][who] = ks;
      });
      reactions = next;
      emit();
    }, function () { emit(); });

    return {
      kind: "db",
      hasAccounts: false,
      subscribe: function (fn) {
        listeners.push(fn);
        if (ready) fn(shape());
        return function () { listeners = listeners.filter(function (l) { return l !== fn; }); };
      },
      add: function (name, body) {
        var id = newId();
        return db.doc("comments/" + id).set({
          name: name, body: body, vid: vid, ts: Date.now(), createdAt: new Date().toISOString()
        });
      },
      remove: function (id) { return db.doc("comments/" + id).delete(); },
      react: function (cid, kind) {
        var per = (reactions[cid] || {})[vid] || [];
        var next = per.indexOf(kind) === -1 ? per.concat([kind]) : per.filter(function (k) { return k !== kind; });
        if (!reactions[cid]) reactions[cid] = {};
        reactions[cid][vid] = next;
        emit();
        return db.doc("reactions/" + cid + "__" + vid).set({ cid: cid, vid: vid, kinds: next, ts: Date.now() });
      }
    };
  }

  /** Nothing reachable: this browser only, and the page says so. */
  function localStore() {
    var KEY = "sippy.guestbook";
    var listeners = [];
    function load() {
      try { var v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    }
    function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
    function emit() { var v = load(); listeners.forEach(function (fn) { fn(v); }); }
    return {
      kind: "local",
      hasAccounts: false,
      subscribe: function (fn) { listeners.push(fn); fn(load()); return function () { listeners = listeners.filter(function (l) { return l !== fn; }); }; },
      add: function (name, body) {
        var v = load();
        v.unshift({
          id: newId(), name: name, body: body, createdAt: new Date().toISOString(), isMine: true,
          reactions: { up: 0, heart: 0, rocket: 0 }, mine: { up: false, heart: false, rocket: false }
        });
        save(v.slice(0, 200)); emit();
        return Promise.resolve();
      },
      remove: function (id) { save(load().filter(function (c) { return c.id !== id; })); emit(); return Promise.resolve(); },
      react: function (id, kind) {
        var v = load();
        for (var i = 0; i < v.length; i++) {
          if (v[i].id === id) {
            v[i].mine = v[i].mine || { up: false, heart: false, rocket: false };
            v[i].reactions = v[i].reactions || { up: 0, heart: 0, rocket: 0 };
            var on = !!v[i].mine[kind];
            v[i].mine[kind] = !on;
            v[i].reactions[kind] = Math.max(0, (v[i].reactions[kind] || 0) + (on ? -1 : 1));
            break;
          }
        }
        save(v); emit();
        return Promise.resolve();
      }
    };
  }

  /* ===================================================================== UI */
  var el = function (id) { return document.getElementById(id); };

  var list = el("clist");
  var totalEl = el("ccount-total");
  var offlineEl = el("coffline");
  var authcard = el("authcard");
  var postcard = el("postcard");
  var previewcard = el("previewcard");

  var store = null;
  var user = null;
  var busy = {};

  function show(node, on) { if (node) node.hidden = !on; }
  function setMsg(node, text) {
    if (!node) return;
    if (text) { node.textContent = text; node.hidden = false; }
    else { node.textContent = ""; node.hidden = true; }
  }

  function when(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var diff = Math.floor((Date.now() - t) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
    try { return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return new Date(t).toDateString(); }
  }

  function draw(items) {
    list.setAttribute("aria-busy", "false");
    list.textContent = "";
    totalEl.textContent = items.length ? items.length + (items.length === 1 ? " note" : " notes") : "";

    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No notes yet. Yours would be the first.";
      list.appendChild(empty);
      return;
    }

    items.forEach(function (c) {
      var art = document.createElement("article");
      art.className = "comment";
      art.setAttribute("data-id", c.id);

      var top = document.createElement("div");
      top.className = "c-top";
      var nm = document.createElement("span");
      nm.className = "c-name";
      nm.textContent = c.name;                        // textContent, never innerHTML
      var wh = document.createElement("time");
      wh.className = "c-when";
      wh.textContent = when(c.createdAt);
      if (c.createdAt) wh.setAttribute("datetime", c.createdAt);
      top.appendChild(nm);
      top.appendChild(wh);

      var canDelete = store && store.remove && (c.isMine || (user && user.isAdmin));
      if (canDelete) {
        var del = document.createElement("button");
        del.type = "button";
        del.className = "c-del";
        del.textContent = "Delete";
        del.setAttribute("aria-label", "Delete this note by " + c.name);
        del.addEventListener("click", function () { onDelete(c.id, del); });
        top.appendChild(del);
      }

      var bd = document.createElement("p");
      bd.className = "c-body";
      bd.textContent = c.body;                        // textContent, never innerHTML

      var rx = document.createElement("div");
      rx.className = "rx";
      KINDS.forEach(function (k) {
        var n = (c.reactions && c.reactions[k]) || 0;
        var on = !!(c.mine && c.mine[k]);
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rx-btn";
        b.setAttribute("data-kind", k);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.setAttribute("aria-label", LABEL[k] + ", " + n + (n === 1 ? " reaction" : " reactions"));
        var e1 = document.createElement("span"); e1.className = "emo"; e1.setAttribute("aria-hidden", "true"); e1.textContent = EMOJI[k];
        var e2 = document.createElement("span"); e2.className = "n"; e2.textContent = String(n);
        b.appendChild(e1); b.appendChild(e2);
        b.addEventListener("click", function () { onReact(c.id, k, b); });
        rx.appendChild(b);
      });

      art.appendChild(top); art.appendChild(bd); art.appendChild(rx);
      list.appendChild(art);
    });
  }

  function onReact(id, kind, btn) {
    if (!store) return;
    if (store.hasAccounts && !user) {
      setMsg(el("si-err"), "Sign in to react to a note.");
      var t = el("tab-signin"); if (t) t.click();
      var f = el("si-email"); if (f) f.focus();
      return;
    }
    var key = id + ":" + kind;
    if (busy[key]) return;
    busy[key] = true;
    btn.disabled = true;
    Promise.resolve(store.react(id, kind))
      .catch(function (err) { setMsg(el("cerr"), (err && err.message) || "That reaction didn't save."); })
      .then(function () { busy[key] = false; btn.disabled = false; });
  }

  function onDelete(id, btn) {
    if (!store || !store.remove) return;
    if (btn.getAttribute("data-confirm") !== "1") {
      btn.setAttribute("data-confirm", "1");
      btn.textContent = "Really delete?";
      setTimeout(function () {
        if (btn.isConnected) { btn.removeAttribute("data-confirm"); btn.textContent = "Delete"; }
      }, 4000);
      return;
    }
    btn.disabled = true;
    Promise.resolve(store.remove(id))
      .catch(function (err) { setMsg(el("cerr"), (err && err.message) || "Couldn't delete that note."); btn.disabled = false; });
  }

  /* ------------------------------------------------------- account state -- */

  function applyUser(u) {
    user = u || null;
    if (!store || !store.hasAccounts) return;
    // Signing out clears the CSRF cookie along with the session. Without a
    // fresh one the next sign-in would be refused, so ask for one straight away.
    if (!user && !cookie("csrf") && store.session) {
      store.session().catch(function () {});
    }
    show(authcard, !user);
    show(postcard, !!user);
    show(previewcard, false);
    if (user) {
      el("who-name").textContent = user.displayName;
      show(el("who-admin"), !!user.isAdmin);
      el("rn-name").value = user.displayName;
      var since = user.memberSince ? new Date(user.memberSince) : null;
      el("acct-meta").textContent = user.email + (since && isFinite(since) ? " · here since " + since.toLocaleDateString(undefined, { year: "numeric", month: "long" }) : "");
    }
    if (store.refresh) store.refresh().catch(function () {});
  }

  /* --------------------------------------------------------- auth wiring -- */

  function wireTabs() {
    var tSignin = el("tab-signin"), tSignup = el("tab-signup");
    var pSignin = el("signin"), pSignup = el("signup");
    if (!tSignin) return;
    function select(which) {
      var inSignin = which === "signin";
      tSignin.setAttribute("aria-selected", inSignin ? "true" : "false");
      tSignup.setAttribute("aria-selected", inSignin ? "false" : "true");
      pSignin.hidden = !inSignin;
      pSignup.hidden = inSignin;
    }
    tSignin.addEventListener("click", function () { select("signin"); });
    tSignup.addEventListener("click", function () { select("signup"); });
  }

  function submitting(btn, label) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
    return function () { btn.disabled = false; btn.textContent = btn.dataset.label; };
  }

  function wireAuth() {
    var signin = el("signin");
    if (signin) {
      signin.addEventListener("submit", function (e) {
        e.preventDefault();
        setMsg(el("si-err"), "");
        var email = el("si-email").value.trim();
        var pw = el("si-pw").value;
        if (!email) { setMsg(el("si-err"), "Enter your email."); el("si-email").focus(); return; }
        if (!pw) { setMsg(el("si-err"), "Enter your password."); el("si-pw").focus(); return; }
        var done = submitting(el("si-submit"), "Signing in…");
        store.login({ email: email, password: pw })
          .then(function (j) { el("si-pw").value = ""; applyUser(j.user); })
          .catch(function (err) { setMsg(el("si-err"), err.message); })
          .then(done);
      });
    }

    var signup = el("signup");
    if (signup) {
      signup.addEventListener("submit", function (e) {
        e.preventDefault();
        setMsg(el("su-err"), "");
        var name = el("su-name").value.trim();
        var email = el("su-email").value.trim();
        var pw = el("su-pw").value;
        var consent = el("su-consent").checked;
        if (!name) { setMsg(el("su-err"), "Pick a display name."); el("su-name").focus(); return; }
        if (!email) { setMsg(el("su-err"), "Enter your email."); el("su-email").focus(); return; }
        if (pw.length < 12) { setMsg(el("su-err"), "Passwords need at least 12 characters."); el("su-pw").focus(); return; }
        if (!consent) { setMsg(el("su-err"), "Please tick the box to confirm you've read how your data is handled."); el("su-consent").focus(); return; }
        var done = submitting(el("su-submit"), "Creating…");
        store.register({ email: email, displayName: name, password: pw, consent: true })
          .then(function (j) { el("su-pw").value = ""; applyUser(j.user); })
          .catch(function (err) { setMsg(el("su-err"), err.message); })
          .then(done);
      });
    }

    var toggle = el("acct-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        var open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
        el("acct-panel").hidden = open;
      });
    }

    var rename = el("rename");
    if (rename) {
      rename.addEventListener("submit", function (e) {
        e.preventDefault();
        setMsg(el("acct-err"), ""); setMsg(el("acct-ok"), "");
        var name = el("rn-name").value.trim();
        if (!name) { setMsg(el("acct-err"), "Display name can't be empty."); return; }
        var done = submitting(el("rn-submit"), "Saving…");
        store.patchMe({ displayName: name })
          .then(function (j) { applyUser(j.user); setMsg(el("acct-ok"), "Name updated. It shows on new notes; older ones keep the name you used then."); })
          .catch(function (err) { setMsg(el("acct-err"), err.message); })
          .then(done);
      });
    }

    var repw = el("repw");
    if (repw) {
      repw.addEventListener("submit", function (e) {
        e.preventDefault();
        setMsg(el("acct-err"), ""); setMsg(el("acct-ok"), "");
        var cur = el("pw-current").value, next = el("pw-new").value;
        if (!cur) { setMsg(el("acct-err"), "Enter your current password."); return; }
        if (next.length < 12) { setMsg(el("acct-err"), "New passwords need at least 12 characters."); return; }
        var done = submitting(el("pw-submit"), "Changing…");
        store.patchMe({ currentPassword: cur, newPassword: next })
          .then(function () {
            el("pw-current").value = ""; el("pw-new").value = "";
            setMsg(el("acct-ok"), "Password changed. Every other device has been signed out.");
          })
          .catch(function (err) { setMsg(el("acct-err"), err.message); })
          .then(done);
      });
    }

    var out = el("signout");
    if (out) {
      out.addEventListener("click", function () {
        store.logout().then(function () { applyUser(null); }).catch(function () { applyUser(null); });
      });
    }
    var outAll = el("signout-all");
    if (outAll) {
      outAll.addEventListener("click", function () {
        store.logoutAll().then(function () { applyUser(null); }).catch(function () { applyUser(null); });
      });
    }

    var del = el("delacct");
    if (del) {
      del.addEventListener("submit", function (e) {
        e.preventDefault();
        setMsg(el("del-err"), "");
        var pw = el("del-pw").value;
        if (!pw) { setMsg(el("del-err"), "Enter your password to confirm."); return; }
        var mode = el("del-keep").checked ? "keep" : "delete";
        var btn = el("del-submit");
        if (btn.getAttribute("data-confirm") !== "1") {
          btn.setAttribute("data-confirm", "1");
          btn.textContent = "Press again to delete permanently";
          setTimeout(function () {
            if (btn.isConnected) { btn.removeAttribute("data-confirm"); btn.textContent = "Permanently delete my account"; }
          }, 6000);
          return;
        }
        var done = submitting(btn, "Deleting…");
        store.deleteMe({ password: pw, comments: mode })
          .then(function () {
            el("del-pw").value = "";
            btn.removeAttribute("data-confirm");
            applyUser(null);
            el("acct-panel").hidden = true;
            el("acct-toggle").setAttribute("aria-expanded", "false");
            setMsg(el("si-err"), "Your account and its data are gone. Thanks for stopping by.");
          })
          .catch(function (err) { setMsg(el("del-err"), err.message); btn.removeAttribute("data-confirm"); })
          .then(function () { done(); btn.textContent = "Permanently delete my account"; });
      });
    }
  }

  /* ------------------------------------------------------- posting forms -- */

  function wireCounter(area, counter) {
    if (!area) return;
    area.addEventListener("input", function () {
      var n = area.value.length;
      counter.textContent = n + " / 2000";
      counter.classList.toggle("over", n > 2000);
    });
  }
  wireCounter(el("cbody"), el("ccount"));
  wireCounter(el("pbody"), el("pcount"));

  function handlePost(opts) {
    return function (e) {
      e.preventDefault();
      setMsg(opts.err, ""); setMsg(opts.ok, "");
      var name = opts.name ? opts.name.value.replace(/\s+/g, " ").trim() : (user ? user.displayName : "");
      var body = opts.body.value.trim();

      if (opts.name && !name) { setMsg(opts.err, "Add your name so Sippy knows who wrote this."); opts.name.focus(); return; }
      if (opts.name && name.length > 60) { setMsg(opts.err, "Names cap at 60 characters."); opts.name.focus(); return; }
      if (!body) { setMsg(opts.err, "Write a note before posting."); opts.body.focus(); return; }
      if (body.length > 2000) { setMsg(opts.err, "Notes cap at 2000 characters. Yours is " + body.length + "."); opts.body.focus(); return; }

      var done = submitting(opts.submit, "Posting…");
      Promise.resolve(store.add(name, body)).then(function () {
        opts.body.value = "";
        opts.counter.textContent = "0 / 2000";
        opts.counter.classList.remove("over");
        setMsg(opts.ok, "Posted. Thanks for the note.");
        if (opts.name) writeStored("sippy.name", name);
      }).catch(function (err) {
        setMsg(opts.err, (err && err.message) || "That didn't post. Try again in a moment.");
      }).then(done);
    };
  }

  var cform = el("cform");
  if (cform) {
    cform.addEventListener("submit", handlePost({
      body: el("cbody"), err: el("cerr"), ok: el("cok"), submit: el("csubmit"), counter: el("ccount")
    }));
  }
  var pform = el("pform");
  if (pform) {
    pform.addEventListener("submit", handlePost({
      name: el("pname"), body: el("pbody"), err: el("perr"), ok: el("pok"),
      submit: el("psubmit"), counter: el("pcount")
    }));
  }
  var savedName = readStored("sippy.name");
  if (savedName && el("pname")) el("pname").value = savedName;

  wireTabs();

  /* ========================================================= pick a backend */

  function useStore(s, note) {
    store = s;
    window.__store = s;
    if (note) { offlineEl.textContent = note; offlineEl.hidden = false; }
    if (s.hasAccounts) {
      wireAuth();
      s.session()
        .then(function (j) { applyUser(j.user); })
        .catch(function () { applyUser(null); });
    } else {
      show(authcard, false);
      show(postcard, false);
      show(previewcard, true);
    }
    s.subscribe(draw);
  }

  // A build without the guestbook (the static marketing site) has none of the
  // elements below. Stop here rather than wiring up nothing.
  if (!list) return;

  function probeHttp() {
    return fetch("/api/health", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("no api")); })
      .then(function (j) { if (!j || j.ok !== true) throw new Error("no api"); return true; });
  }

  var capPromise = (window.claude && typeof window.claude.use === "function")
    ? window.claude.use("db").catch(function () { return null; })
    : Promise.resolve(null);

  probeHttp().then(function () {
    useStore(httpStore(), null);
  }).catch(function () {
    capPromise.then(function (db) {
      if (db) {
        useStore(dbStore(db),
          "Preview mode. Accounts and sign-in live on the deployed site; here, notes are shared but there is no sign-in, so anyone viewing can post under any name.");
      } else {
        useStore(localStore(),
          "Preview mode with no shared backend, so notes are saved only in this browser. Deploy the included server to turn on accounts and a shared guestbook.");
      }
    }).catch(function () {
      useStore(localStore(), "Preview mode: notes are saved only in this browser.");
    });
  });
})();
