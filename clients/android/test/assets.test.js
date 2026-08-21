/* The shipped assets themselves: the real config.js parses and has the shape the app
   expects, and the packaging invariants that aapt2 on Windows forces on us still hold.

   Nothing here prints a config VALUE. assets/config.js holds a real location and is held
   back from the repo with --skip-worktree; a test that echoed it into CI output would put
   it somewhere it does not belong. Every assertion below is about types and keys. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var h = require("./lib/harness.js");

function loadConfig() {
  var sandbox = { window: {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(h.readAsset("config.js"), sandbox, { filename: "config.js" });
  return sandbox.window.CONFIG;
}

test("config.js parses and defines window.CONFIG", function () {
  var C = loadConfig();
  assert.equal(typeof C, "object");
  assert.notEqual(C, null);
});

test("the location block has the right shape", function () {
  var C = loadConfig();
  assert.ok(C.location, "no location block");
  assert.equal(typeof C.location.name, "string");
  ["latitude", "longitude"].forEach(function (k) {
    var v = C.location[k];
    assert.ok(v === null || typeof v === "number", k + " must be a number or null");
    if (typeof v === "number") assert.equal(isNaN(v), false, k + " is NaN");
  });
  if (typeof C.location.latitude === "number") {
    assert.ok(Math.abs(C.location.latitude) <= 90, "latitude out of range");
    assert.ok(Math.abs(C.location.longitude) <= 180, "longitude out of range");
  }
});

test("units and clock format are values the app understands", function () {
  var C = loadConfig();
  assert.ok(C.units === "fahrenheit" || C.units === "celsius", "unknown units value");
  assert.ok(C.clockHours === 12 || C.clockHours === 24, "unknown clockHours value");
});

test("the Home Assistant block is present and ships disabled with no token", function () {
  /* The repo is public and build.ps1 bakes config.js into the APK. */
  var C = loadConfig();
  var ha = C.homeAssistant;
  assert.ok(ha, "no homeAssistant block");
  assert.equal(typeof ha.enabled, "boolean");
  assert.equal(typeof ha.baseUrl, "string");
  assert.equal(typeof ha.token, "string");
  assert.equal(ha.token, "", "a token must never be committed in config.js");
  assert.equal(ha.enabled, false, "the shipped default is the simulator");
  assert.ok(Array.isArray(ha.entities));
  ha.entities.forEach(function (e) {
    assert.equal(typeof e.id, "string");
    assert.match(e.id, /^[a-z_]+\.[a-z0-9_]+$/, "entity id is not domain.object_id: " + e.id);
  });
});

test("burn-in protection is configured within sane bounds", function () {
  var C = loadConfig();
  var b = C.burnInProtection;
  assert.ok(b, "no burnInProtection block");
  assert.equal(typeof b.enabled, "boolean");
  assert.ok(b.maxShiftPx > 0 && b.maxShiftPx <= 40, "maxShiftPx out of range");
  assert.ok(b.intervalSeconds >= 10, "drifting faster than every 10 s would be visible");
});

test("the refresh interval will not hammer Open-Meteo", function () {
  var C = loadConfig();
  assert.ok(C.weatherRefreshMinutes >= 5, "weatherRefreshMinutes is too aggressive");
});

test("the real config boots the dashboard", function () {
  /* The default harness config is synthetic on purpose; this is the one place the real file
     is put through the app, to catch an edit that parses but breaks a widget. */
  var app = h.createApp({ config: loadConfig() });
  assert.deepEqual(app.logs.error, []);
  assert.deepEqual(app.logs.warn, []);
  assert.equal(Object.keys(app.registry).length, 15);   // 13 widgets + sky + carousel
});

/* ---------------- packaging invariants ---------------- */

test("no shipped source file exceeds 500 lines", function () {
  /* The project's file budget: a file this size stays reviewable on one screen-ful of
     scrolling, and the split points (app core/view/touch, sensors data/demo/panel, the
     four stylesheets, MainActivity/BridgeFetch) are documented in each file's header.
     Shipped code only — index.html is one page by nature and the tests are not shipped. */
  var LIMIT = 500;
  var over = [];
  fs.readdirSync(h.ASSETS).filter(function (n) { return /\.(js|css)$/.test(n); })
    .forEach(function (n) {
      var lines = fs.readFileSync(path.join(h.ASSETS, n), "utf8").split("\n").length;
      if (lines > LIMIT) over.push(n + ": " + lines);
    });
  var javaDir = path.join(h.ASSETS, "..", "src", "com", "justin", "inkyoled");
  fs.readdirSync(javaDir).filter(function (n) { return /\.java$/.test(n); })
    .forEach(function (n) {
      var lines = fs.readFileSync(path.join(javaDir, n), "utf8").split("\n").length;
      if (lines > LIMIT) over.push(n + ": " + lines);
    });
  assert.deepEqual(over, [], "files over the 500-line budget: " + over.join(", "));
});

test("assets stay FLAT — aapt2 on Windows cannot ship a subdirectory", function () {
  /* aapt2 writes subdir separators as backslashes ("assets/dashboard\index.html") and
     file:///android_asset/ cannot resolve them. Multiple flat files are fine and expected. */
  var entries = fs.readdirSync(h.ASSETS, { withFileTypes: true });
  var dirs = entries.filter(function (e) { return e.isDirectory(); }).map(function (e) { return e.name; });
  assert.deepEqual(dirs, [], "assets/ has subdirectories: " + dirs.join(", "));
});

test("no test code is shipped inside the APK", function () {
  var names = fs.readdirSync(h.ASSETS);
  names.forEach(function (n) {
    assert.equal(/\.test\.|(^|[^a-z])test([^a-z]|$)|\.spec\./.test(n), false,
      "test file in assets/: " + n);
  });
  assert.ok(fs.existsSync(path.join(__dirname, "..", "test")), "tests live outside assets/");
});

test("index.html loads exactly the scripts that exist, in the order they need", function () {
  /* Load order is load-bearing, not incidental:
       app.js     defines WP, which every file below reads at parse time
       wx-ui.js   hangs the shared builders off WP.ui, so it precedes every widget
       wx-weather resolves into WP.registry before wx-hourly / wx-daily read it,
       wx-sensors before wx-settings, which quotes its mode in the About line, and
       wx-sky-light hangs WP.skyLight off WP before wx-sky.js reads it at parse time.
     Getting this wrong is a blank wall panel, so it is pinned rather than assumed. */
  var html = h.readAsset("index.html");
  var srcs = h.scriptOrder(html);
  assert.deepEqual(srcs, [
    "config.js", "app.js", "app-view.js", "app-touch.js", "wx-ui.js", "wx-icons.js",
    "wx-clock.js", "wx-timer.js", "wx-weather.js", "wx-hourly.js",
    "wx-daily.js", "wx-sensors-demo.js", "wx-sensors.js", "wx-sensors-panel.js",
    "wx-system.js",
    "wx-moon.js", "wx-air.js", "wx-paper.js", "wx-gallery.js", "wx-news.js",
    "wx-settings.js", "wx-carousel.js", "wx-sky-light.js", "wx-sky.js"
  ]);
  srcs.forEach(function (s) {
    assert.ok(fs.existsSync(path.join(h.ASSETS, s)), "index.html loads a missing file: " + s);
  });
  var css = (html.match(/href="([^"]+\.css)"/) || [])[1];
  assert.ok(fs.existsSync(path.join(h.ASSETS, css)), "missing stylesheet: " + css);
});

test("every .js in assets/ is actually loaded by the page", function () {
  /* The other half of the check above: a widget file that exists but has no script tag is
     dead code that a coverage report will happily call untested, and a widget file that is
     REMOVED while its tag stays behind is a 404 on the wall. */
  var srcs = h.scriptOrder(h.readAsset("index.html"));
  fs.readdirSync(h.ASSETS)
    .filter(function (n) { return /\.js$/.test(n); })
    .forEach(function (n) {
      assert.ok(srcs.indexOf(n) !== -1, "assets/" + n + " is never loaded by index.html");
    });
});

test("one widget, one file, and each file registers exactly the widget it is named for", function () {
  /* widgets.js was 1830 lines holding eight unrelated things. The split only stays split if
     the naming stays honest: wx-<plugin>.js registers <plugin> and nothing else. */
  var app = h.createApp({});
  app.WP.WIDGETS.forEach(function (name) {
    var file = "wx-" + name + ".js";
    assert.ok(fs.existsSync(path.join(h.ASSETS, file)), "no " + file);
    var src = fs.readFileSync(path.join(h.ASSETS, file), "utf8");
    var regs = (src.match(/WP\.register\(/g) || []).length;
    assert.equal(regs, 1, file + " registers " + regs + " widgets");
    assert.match(src, new RegExp('name:\\s*"' + name + '"'),
      file + " does not define the widget it is named after");
  });
  /* +2: the sky and carousel layers register for init() but are not widgets
     (no card, no panel, no show/hide switch) */
  assert.equal(Object.keys(app.registry).length, app.WP.WIDGETS.length + 2);
  assert.equal(fs.existsSync(path.join(h.ASSETS, "widgets.js")), false,
    "the monolith is back");
});

test("the shared builders live in one place and every widget reads them from it", function () {
  var app = h.createApp({});
  var ui = app.WP.ui;
  assert.ok(ui, "WP.ui is gone — the panel builders have been copied back into the widgets");
  ["statGrid", "section", "hero", "bar", "btn", "segmented", "switchRow"].forEach(function (k) {
    assert.equal(typeof ui[k], "function", "WP.ui." + k + " is missing");
  });
  /* no widget file may define its own copy of one */
  fs.readdirSync(h.ASSETS)
    .filter(function (n) { return /^wx-/.test(n) && n !== "wx-ui.js"; })
    .forEach(function (n) {
      var src = fs.readFileSync(path.join(h.ASSETS, n), "utf8");
      Object.keys(ui).forEach(function (k) {
        assert.equal(new RegExp("function\\s+" + k + "\\s*\\(").test(src), false,
          n + " has its own copy of " + k + "()");
      });
    });
});

/* ---------------- Content Security Policy ----------------
   shouldOverrideUrlLoading only sees navigations, so it cannot stop a <script src> or a
   fetch; addJavascriptInterface then means any script that DOES load holds window.Android.
   The CSP meta is what closes that, and it is one deletable line, so it is pinned here. */

function cspDirectives() {
  var html = h.readAsset("index.html");
  var m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, "index.html has no Content-Security-Policy meta");
  var out = {};
  m[1].split(";").forEach(function (part) {
    var bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) out[bits[0]] = bits.slice(1);
  });
  return out;
}

test("the page carries a CSP that cannot execute a remote or inline script", function () {
  var d = cspDirectives();
  assert.deepEqual(d["script-src"], ["'self'"],
    "script-src must be exactly 'self' — it is the directive that keeps window.Android "
    + "out of reach of injected code");
  assert.deepEqual(d["default-src"], ["'none'"], "default-src must deny by default");
  assert.deepEqual(d["object-src"] || d["default-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'none'"], "a rewritten <base> would relocate 'self'");
});

test("the CSP relaxations are the two the app actually needs, and no more", function () {
  var d = cspDirectives();
  /* style: the fill bars are emitted as style="width:NN%" */
  assert.ok(d["style-src"].indexOf("'unsafe-inline'") !== -1,
    "the countdown and battery bars render at zero width without inline styles");
  assert.equal(d["style-src"].indexOf("'unsafe-eval'"), -1);
  /* connect: Open-Meteo plus whatever LAN host Home Assistant is configured on */
  assert.ok(d["connect-src"], "no connect-src — the weather fetch would be blocked");
  /* nothing anywhere may be allowed to eval or to run a data: URI as script */
  var all = Object.keys(d).map(function (k) { return d[k].join(" "); }).join(" ");
  assert.equal(/unsafe-eval/.test(all), false, "CSP permits eval");
  assert.equal(/script-src[^;]*data:/.test(all), false, "CSP permits data: scripts");
});

test("every data-open target has a panel, and every panel has a widget", function () {
  var app = h.createApp({});
  var panels = app.qsa("[data-panel]").map(function (n) { return n.getAttribute("data-panel"); });
  app.qsa("[data-open]").forEach(function (n) {
    var name = n.getAttribute("data-open");
    assert.ok(panels.indexOf(name) !== -1, "data-open=\"" + name + "\" has no panel");
    assert.ok(app.registry[name], "data-open=\"" + name + "\" has no registered plugin");
  });
  panels.forEach(function (p) {
    assert.ok(app.registry[p], "panel \"" + p + "\" has no plugin to fill it");
  });
});

test("every panel has a way out, a body and a subtitle", function () {
  /* The Android back button is intentionally dead on this kiosk, so a panel with no visible
     way out would strand the wall. It used to be checked here that there were TWO ways out;
     the footer bar is gone (see panels.test.js for why it cost more than it was worth) and
     the header ✕ is the one that must never be missing. */
  var app = h.createApp({});
  app.qsa("[data-panel]").forEach(function (panel) {
    var name = panel.getAttribute("data-panel");
    assert.ok(panel.querySelector(".panel-head [data-close]"), name + " has no header close");
    assert.ok(panel.querySelector("[data-body]"), name + " has no body");
    assert.ok(panel.querySelector("[data-sub]"), name + " has no subtitle");
  });
});

test("every widget named in WP.WIDGETS has a card and a label", function () {
  var app = h.createApp({});
  app.WP.WIDGETS.forEach(function (w) {
    assert.ok(app.qs('[data-widget="' + w + '"]'), "no card for widget " + w);
    assert.equal(typeof app.WP.WIDGET_LABELS[w], "string", "no label for widget " + w);
  });
});
