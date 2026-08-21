/* harness — boots the real dashboard sources inside a vm sandbox.

   Loads, unmodified, from ../assets/:  index.html, app.js, widgets.js
   Config is NOT read from assets/config.js by default: the checked-out file is a personal
   one, and a test that depends on somebody's latitude is a test that fails on the next
   machine. Tests pass their own CONFIG; test/assets.test.js separately checks the real
   file's shape without asserting on any value.

   Time is virtual (see makeClock): the app runs eleven intervals, and a real timer would
   make the suite both slow and flaky. Date inside the sandbox is pinned to the same clock,
   so `new Date()` and `Date.now()` agree with whatever the test says the time is. */

"use strict";

var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var minidom = require("./minidom.js");

var ASSETS = path.join(__dirname, "..", "..", "assets");

function readAsset(name) {
  return fs.readFileSync(path.join(ASSETS, name), "utf8");
}

/* The <script src> list, in document order. The app is nine flat files loaded in a
   load-bearing order (wx-ui before every widget; wx-weather before the two widgets that
   read its payload), so both the harness and assets.test.js take that order from the page
   itself rather than keeping a second copy of it. */
function scriptOrder(html) {
  return (html.match(/<script src="([^"]+)"/g) || []).map(function (s) {
    return s.replace(/^<script src="/, "").replace(/"$/, "");
  });
}

/* ---------------- virtual clock ---------------- */

function makeClock(startMs) {
  var now = startMs;
  var seq = 0;
  var timers = new Map();

  function add(fn, ms, repeat, args) {
    var id = ++seq;
    var every = Math.max(1, Math.floor(ms || 0));
    timers.set(id, { id: id, fn: fn, due: now + every, every: every, repeat: repeat, args: args || [] });
    return id;
  }

  var clock = {
    get now() { return now; },
    /* Jump without firing anything — for "pretend it is 07:00 now". */
    set: function (t) { now = (t instanceof Date) ? t.getTime() : t; },
    /* Run the timeline forward, firing everything that comes due. */
    advance: function (ms) {
      var target = now + ms;
      var guard = 0;
      for (;;) {
        var next = null;
        timers.forEach(function (t) { if (!next || t.due < next.due) next = t; });
        if (!next || next.due > target) { now = target; return; }
        if (++guard > 200000) throw new Error("clock.advance: runaway timer loop");
        now = next.due;
        if (next.repeat) next.due = now + next.every;
        else timers.delete(next.id);
        next.fn.apply(null, next.args);
      }
    },
    pending: function () { return timers.size; },
    setTimeout: function (fn, ms) {
      return add(fn, ms, false, Array.prototype.slice.call(arguments, 2));
    },
    setInterval: function (fn, ms) {
      return add(fn, ms, true, Array.prototype.slice.call(arguments, 2));
    },
    clearTimeout: function (id) { timers.delete(id); },
    clearInterval: function (id) { timers.delete(id); }
  };
  return clock;
}

/* ---------------- storage ---------------- */

function makeStorage(seed) {
  var data = Object.assign(Object.create(null), seed || {});
  return {
    data: data,
    throws: false,
    getItem: function (k) {
      if (this.throws) throw new Error("localStorage unavailable");
      return data[k] === undefined ? null : data[k];
    },
    setItem: function (k, v) {
      if (this.throws) throw new Error("localStorage unavailable");
      data[k] = String(v);
    },
    removeItem: function (k) { delete data[k]; },
    clear: function () { Object.keys(data).forEach(function (k) { delete data[k]; }); }
  };
}

/* A CONFIG that is deliberately nothing like anybody's real one. */
function defaultConfig() {
  return {
    location: { name: "Test Location", latitude: 10, longitude: 20 },
    units: "fahrenheit",
    clockHours: 12,
    plugins: ["clock", "weather", "forecast"],
    homeAssistant: {
      enabled: false, baseUrl: "http://ha.invalid:8123", token: "",
      refreshSeconds: 60, entities: []
    },
    weatherRefreshMinutes: 15,
    burnInProtection: { enabled: true, maxShiftPx: 12, intervalSeconds: 120 }
  };
}

/* ---------------- the app under test ---------------- */

function createApp(opts) {
  opts = opts || {};
  var startNow = opts.now == null ? Date.parse("2025-06-10T09:30:00") : opts.now;
  if (startNow instanceof Date) startNow = startNow.getTime();

  var clock = makeClock(startNow);
  var storage = makeStorage(opts.storage);
  var doc = minidom.createDocument(opts.html || readAsset("index.html"));

  var logs = { log: [], warn: [], error: [] };
  var fetches = [];

  var HostDate = Date;
  function SandboxDate(a, b, c, d, e, f, g) {
    if (!(this instanceof SandboxDate)) return new HostDate(clock.now).toString();
    switch (arguments.length) {
      case 0: return new HostDate(clock.now);
      case 1: return new HostDate(a);
      case 2: return new HostDate(a, b);
      case 3: return new HostDate(a, b, c);
      case 4: return new HostDate(a, b, c, d);
      case 5: return new HostDate(a, b, c, d, e);
      case 6: return new HostDate(a, b, c, d, e, f);
      default: return new HostDate(a, b, c, d, e, f, g);
    }
  }
  SandboxDate.prototype = HostDate.prototype;
  SandboxDate.now = function () { return clock.now; };
  SandboxDate.parse = HostDate.parse;
  SandboxDate.UTC = HostDate.UTC;

  var fetchImpl = opts.fetch || function () {
    return Promise.reject(new Error("offline (test harness default)"));
  };

  var sandbox = {
    document: doc,
    localStorage: storage,
    innerWidth: opts.width || 1600,
    innerHeight: opts.height || 2560,
    devicePixelRatio: opts.dpr || 2,
    navigator: { userAgent: "minidom" },
    console: {
      log: function () { logs.log.push(Array.prototype.join.call(arguments, " ")); },
      warn: function () { logs.warn.push(Array.prototype.join.call(arguments, " ")); },
      error: function () { logs.error.push(Array.prototype.join.call(arguments, " ")); },
      info: function () { logs.log.push(Array.prototype.join.call(arguments, " ")); }
    },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearInterval,
    Date: SandboxDate,
    fetch: function (url, init) {
      fetches.push({ url: String(url), init: init || {} });
      /* the clock goes along so a stub can answer with a payload for "now" */
      return fetchImpl(String(url), init || {}, clock);
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    /* The panel fit check reads the scrollport's bottom padding, because that padding is
       the whole margin between the last row and the bezel. minidom has no cascade, so a
       test states the padding the same way it states every other measurement — by writing
       it onto the element. */
    getComputedStyle: function (el) { return (el && el.style) || {}; },
    CONFIG: opts.config === undefined ? defaultConfig() : opts.config
  };
  /* base64 <-> binary string, which WebView has natively; bridgeFetch decodes its
     payloads with atob so the sandbox needs one. */
  sandbox.atob = function (b64) { return Buffer.from(String(b64 || ""), "base64").toString("binary"); };
  sandbox.btoa = function (bin) { return Buffer.from(String(bin || ""), "binary").toString("base64"); };
  if (opts.bridge) sandbox.Android = opts.bridge;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  var ctx = vm.createContext(sandbox);
  if (opts.random) vm.runInContext("Math", ctx).random = opts.random;

  /* The sources are run in the SAME ORDER index.html loads them, and that order is read out
     of index.html rather than restated here — a harness with its own hard-coded list would
     go on passing after somebody added a widget file and forgot the script tag, which is
     precisely the failure this arrangement can have.

     Absolute filenames, not bare "app.js": node's --experimental-test-coverage attributes a
     vm script to whatever `filename` says, and only counts paths under the project root.
     With a bare name the app sources were invisible to the coverage report, which then
     cheerfully printed 100% of nothing. */
  scriptOrder(opts.html || readAsset("index.html")).forEach(function (name) {
    if (name === "config.js") return;                 // CONFIG is supplied by the test
    vm.runInContext(readAsset(name), ctx, { filename: path.join(ASSETS, name) });
  });

  var WP = sandbox.WP;

  var app = {
    WP: WP,
    win: sandbox,
    ctx: ctx,
    doc: doc,
    clock: clock,
    storage: storage,
    logs: logs,
    fetches: fetches,
    registry: WP.registry,
    $: function (id) { return doc.getElementById(id); },
    qs: function (sel, root) { return (root || doc).querySelector(sel); },
    qsa: function (sel, root) { return (root || doc).querySelectorAll(sel); },
    text: function (id) { var el = doc.getElementById(id); return el ? el.textContent : null; },
    advance: function (ms) { clock.advance(ms); },
    /* Arrays built inside the vm carry the vm's Array.prototype, which assert/strict's
       deepEqual refuses to match against a plain host array. Copy across the realm. */
    own: function (arr) { return Array.from(arr || []); },
    stack: function () { return Array.from(WP.panels.stack); },
    /* Promises resolve on the host microtask queue, not on the virtual clock. */
    flush: function () { return new Promise(function (r) { setImmediate(r); }); },

    boot: function () {
      doc.readyState = "complete";
      doc.dispatch(doc, "DOMContentLoaded", {});
      return app;
    },

    /* A tap as Chrome delivers it: pointerdown, pointerup, then the click the app has to
       swallow so the same action does not run twice. */
    tap: function (el, pt) {
      var r = el.getBoundingClientRect();
      var p = pt || { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      doc.dispatch(el, "pointerdown", { pointerId: 1, clientX: p.x, clientY: p.y });
      doc.dispatch(el, "pointerup", { pointerId: 1, clientX: p.x, clientY: p.y });
      doc.dispatch(el, "click", { clientX: p.x, clientY: p.y });
      return app;
    },

    /* A deliberate press-and-hold on a wall panel: Chrome claims the gesture and delivers
       pointercancel with no click at all. This is the path that ate the alarm's Dismiss. */
    longPress: function (el, ms, pt) {
      var r = el.getBoundingClientRect();
      var p = pt || { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      doc.dispatch(el, "pointerdown", { pointerId: 1, clientX: p.x, clientY: p.y });
      clock.advance(ms == null ? 700 : ms);
      doc.dispatch(el, "pointercancel", { pointerId: 1, clientX: p.x, clientY: p.y });
      return app;
    },

    /* A finger that moved: pointerdown, drag, pointercancel — must NOT activate. */
    swipe: function (el, dx, dy) {
      var r = el.getBoundingClientRect();
      var x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      doc.dispatch(el, "pointerdown", { pointerId: 1, clientX: x, clientY: y });
      doc.dispatch(el, "pointermove", { pointerId: 1, clientX: x + dx, clientY: y + dy });
      doc.dispatch(el, "pointercancel", { pointerId: 1, clientX: x + dx, clientY: y + dy });
      return app;
    },

    panelBody: function (name) {
      var p = doc.querySelector('[data-panel="' + name + '"]');
      return p ? p.querySelector("[data-body]") : null;
    },
    /* first element inside an open panel whose data-act matches */
    actBtn: function (name, act) {
      var p = doc.querySelector('[data-panel="' + name + '"]');
      return p ? p.querySelector('[data-act="' + act + '"]') : null;
    }
  };

  if (opts.boot !== false) app.boot();
  return app;
}

module.exports = {
  createApp: createApp,
  makeClock: makeClock,
  makeStorage: makeStorage,
  defaultConfig: defaultConfig,
  readAsset: readAsset,
  scriptOrder: scriptOrder,
  ASSETS: ASSETS
};
