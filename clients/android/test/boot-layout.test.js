/* Boot behaviour and the home column's height budget.

   The column is a fixed budget and the honest measurement is the on-device one, so the
   geometry here is stated by the test rather than computed from CSS. What is being checked
   is the arithmetic the app does with those numbers: the 1.3x growth cap, the slack/overflow
   report, and the fact that overflow is escalated to a warning instead of being swallowed. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var CARD_H = 150;
var VIEW_H = 1300;   // 8 home children x 150 + 100 slack

var VIEW_W = 800;

/* Give #home and its children a believable layout. */
function layout(app, opts) {
  opts = opts || {};
  var home = app.$("home");
  home.clientHeight = VIEW_H;
  home.scrollHeight = opts.scrollHeight == null ? VIEW_H : opts.scrollHeight;
  home.clientWidth = VIEW_W;
  home.scrollWidth = opts.scrollWidth == null ? VIEW_W : opts.scrollWidth;
  home.setRect({ left: 0, top: 0, right: VIEW_W, bottom: VIEW_H });

  var kids = app.qsa("#home > *").filter(function (n) { return n.id !== "empty"; });
  var y = 0;
  kids.forEach(function (n) {
    n.offsetHeight = opts.cardHeight == null ? CARD_H : opts.cardHeight;
    n.setRect({ left: 0, top: y, right: 800, bottom: y + n.offsetHeight });
    y += n.offsetHeight;
  });
  return kids;
}

test("boot logs the bridge, viewport and dpr, and raises nothing else", function () {
  var app = h.createApp({});
  assert.equal(app.logs.log.length, 1);
  assert.match(app.logs.log[0], /^\[inky\] booted; bridge=false viewport=1600x2560 dpr=2$/);
  assert.deepEqual(app.logs.warn, []);
  assert.deepEqual(app.logs.error, []);
});

test("every widget registers and initialises", function () {
  var app = h.createApp({});
  var names = Object.keys(app.registry).sort();
  /* sky is registered but is not a WIDGET: it has no card, no panel and no show/hide
     switch — it is the background layer, initialised through the same registry. */
  /* THIRTEEN widgets plus carousel and sky. "calendar" stays gone (a month grid with no
     events — see the WIDGETS note in app.js); "paper" and "gallery" are the InkyPi
     picture plugins arriving: the daily front page, and the rotating XKCD / Wikimedia /
     NASA / generated picture. */
  assert.deepEqual(names, ["air", "carousel", "clock", "daily", "gallery", "hourly", "moon",
                           "news", "paper", "sensors", "settings", "sky", "system",
                           "timer", "weather"]);
  /* each one has painted something into its card */
  assert.notEqual(app.text("time"), "--:--");
  assert.notEqual(app.text("date").trim(), "");
  assert.equal(app.text("tmr-big"), "00:00");
  assert.ok(app.qsa("#sensors .sensor").length > 0);
});

test("a plugin whose init explodes does not take the dashboard down", function () {
  var app = h.createApp({ boot: false });
  app.WP.register({ name: "grenade", init: function () { throw new Error("boom"); } });
  app.boot();
  assert.match(app.logs.error.join(" "), /plugin grenade init failed: boom/);
  assert.equal(app.text("tmr-big"), "00:00", "the other widgets still came up");
});

test("the layout report is logged once the cards have their content", function () {
  var app = h.createApp({});
  layout(app);
  app.advance(12500);                       // the deferred boot measurement
  var line = app.logs.log.filter(function (l) { return l.indexOf("[inky] layout:") === 0; })[0];
  assert.ok(line, "no layout line was logged");
  assert.match(line, /home overflow=0 overflowX=0 slack=100px cards=8/);
});

test("overflow is escalated to a warning, not logged as if it were fine", function () {
  /* overflow > 0 means a card grew and the bottom tile row is being clipped off a wall
     panel nobody is standing in front of. */
  var app = h.createApp({});
  layout(app, { scrollHeight: VIEW_H + 40 });
  app.WP.settings.set("seconds", true);
  app.advance(2000);
  var warn = app.logs.warn.filter(function (l) { return l.indexOf("[inky] layout:") === 0; })[0];
  assert.ok(warn, "an overflowing column was not warned about");
  assert.match(warn, /overflow=40 .*OVERFLOW, bottom row is clipped/);
});

test("the report measures the horizontal axis too, and warns on it", function () {
  /* The assertion covered the vertical axis only for five rounds, and for five rounds the
     hourly strip clipped a chip through the middle of a glyph at the card's right edge in
     24-hour mode. #home itself must never scroll sideways: a card that runs off the right
     is as clipped as one that runs off the bottom, and there is no scrollbar and nobody
     standing there to swipe it. */
  var app = h.createApp({});
  layout(app, { scrollWidth: VIEW_W + 17 });
  app.WP.settings.set("clockHours", 24);
  app.advance(2000);
  var warn = app.logs.warn.filter(function (l) { return l.indexOf("[inky] layout:") === 0; })[0];
  assert.ok(warn, "content running off the right edge was not warned about");
  assert.match(warn, /overflowX=17 .*OVERFLOW, content runs off the right/);

  /* and a clean frame stays clean in the same mode */
  var ok = h.createApp({});
  layout(ok);
  ok.WP.settings.set("clockHours", 24);
  ok.advance(2000);
  assert.deepEqual(ok.logs.warn, []);
  assert.match(ok.logs.log.filter(function (l) {
    return l.indexOf("[inky] layout:") === 0;
  }).pop(), /overflow=0 overflowX=0/);
});

/* Open a panel and give its body, and one row inside it, a believable layout. The row goes
   in AFTER the open, because onOpen repaints the body and would wipe it. `spill` is how far
   the row's painted box reaches past where it should stop. */
function openWithLayout(app, name, opts) {
  opts = opts || {};
  app.WP.panels.open(name);
  var panel = app.qs('[data-panel="' + name + '"]');
  var body = app.qs("[data-body]", panel);
  var PAD = 20;                                   // the scrollport's bottom padding
  body.style.paddingBottom = PAD + "px";
  body.setRect({ left: 0, top: 100, right: 700, bottom: 1100 });
  var row = app.doc.createElement("div");
  row.className = "hrow";
  body.appendChild(row);
  row.setRect({
    left: 0 - (opts.spillX || 0), top: 900, right: 700 + (opts.spillX || 0),
    bottom: 1100 - PAD + (opts.spill || 0)
  });
  return { panel: panel, body: body, row: row };
}

test("a panel that spills into the frame is warned about, in EITHER orientation", function () {
  /* The class of bug this is here for: loop 3 restated the landscape type ramp at 1.45x,
     the hourly list's rows kept their `flex: 1 1 0` boxes, and the bottom temperature
     painted 11 px past the end of its row and was sliced by the bezel. It shipped because
     nothing measured a panel — and because the obvious measurement does not see it:
     scrollHeight - clientHeight was 0 on that frame, since the spill landed in the
     scrollport's own bottom padding, which scrollHeight counts as part of the box.

     So the check is "nothing may enter the padding that keeps the last row off the glass",
     it runs from panels.open() rather than from a probe script, and it runs in whatever
     orientation the tablet is in. Both orientations are asserted here for the same reason:
     the fault that shipped existed ONLY in landscape. */
  [{ w: 800, h: 1300, name: "portrait" }, { w: 1300, h: 800, name: "landscape" }]
    .forEach(function (v) {
      var app = h.createApp({ width: v.w, height: v.h });
      openWithLayout(app, "hourly", { spill: 11 });
      app.advance(500);
      var warn = app.logs.warn.filter(function (l) {
        return l.indexOf("[inky] layout: panel") === 0;
      })[0];
      assert.ok(warn, "a panel spilling into the frame was not warned about in " + v.name);
      assert.match(warn, new RegExp("panel hourly " + v.name
        + " overflow=11 overflowX=0 .*OVERFLOW, the last row is into the frame"));
    });
});

test("a panel whose content runs off the side is warned about too", function () {
  /* The daily panel's 24 hour bars each took a min-content floor from the temperature
     printed above them, so the row came out wider than the panel and the 24th bar rendered
     as a 3-device-px sliver at the rail. Sideways is as clipped as downwards: there is no
     scrollbar and nobody standing there to swipe it. */
  var app = h.createApp({ width: 800, height: 1300 });
  openWithLayout(app, "daily", { spillX: 30 });
  app.advance(500);
  var warn = app.logs.warn.filter(function (l) {
    return l.indexOf("[inky] layout: panel") === 0;
  })[0];
  assert.ok(warn, "content running off the side of a panel was not warned about");
  assert.match(warn, /panel daily portrait overflow=0 overflowX=30 .*runs off the side/);
});

test("a panel that fits is reported once, not once per visit", function () {
  /* The carousel opens twelve screens every thirty seconds, for ever. A clean measurement
     is worth logging — it is the evidence the wall is fitting — but only the first time,
     or the log stops being readable and the warnings drown in it. */
  var app = h.createApp({ width: 800, height: 1300 });
  openWithLayout(app, "moon", { spill: 0 });
  app.advance(500);
  app.WP.panels.close();
  openWithLayout(app, "moon", { spill: 0 });
  app.advance(500);
  var lines = app.logs.log.filter(function (l) {
    return l.indexOf("[inky] layout: panel moon") === 0;
  });
  assert.deepEqual(app.logs.warn, []);
  assert.equal(lines.length, 1, "a fitting panel was logged on every open");
  assert.match(lines[0], /panel moon portrait overflow=0 overflowX=0$/);
});

test("a surviving card may grow to at most 1.3x its intrinsic height", function () {
  /* Uncapped flex-grow handed the hidden widgets' whole height to whatever was left: at
     three hidden, the Weather card came out ~800 device px tall with ~250 px of dead black
     above its content. */
  var app = h.createApp({});
  var kids = layout(app);
  app.WP.relayoutHome();
  kids.forEach(function (n) {
    assert.equal(n.style.maxHeight, Math.round(CARD_H * 1.3) + "px",
      "growth cap is not 1.3x intrinsic height");
  });
});

test("no cap is applied before the first payload lands", function () {
  /* A cap measured against an empty card would clip it the moment the data arrived. */
  var app = h.createApp({ boot: false });
  app.boot();
  var kids = layout(app);
  app.WP.settings.set("seconds", true);      // triggers relayout, but nothing has published
  app.advance(1600);
  kids.forEach(function (n) {
    assert.equal(n.style.maxHeight, "", "a cap was applied before the cards had content");
  });
});

test("with no headroom to hand out, the cap is dropped entirely", function () {
  /* All eight widgets on leaves ~34 device px: the cap can only be a liability there. */
  var app = h.createApp({});
  var kids = layout(app, { cardHeight: Math.ceil(VIEW_H / 8) + 10 });   // fills the column
  app.WP.relayoutHome();
  kids.forEach(function (n) {
    assert.equal(n.style.maxHeight, "", "a cap was kept with no slack to distribute");
  });
});

test("slack of exactly zero counts as no headroom, not as a hair of headroom", function () {
  /* The boundary of `if (m.slack <= 0)`. Every other test here sits at slack=100 or at a
     comfortably negative overflow, so `<=` could be weakened to `<` and nothing noticed —
     yet slack=0 is the case the column actually converges on: the on-device measurement is
     34 px with all eight widgets on, and one downward burn-in nudge eats 12 of it. At
     exactly zero there is nothing to hand out, so applying a 1.3x cap can only clip. */
  var app = h.createApp({});
  var kids = app.qsa("#home > *").filter(function (n) { return n.id !== "empty"; });
  var cardH = 150;
  var home = app.$("home");
  home.clientHeight = kids.length * cardH;          // the cards fill the column exactly
  home.scrollHeight = home.clientHeight;
  home.setRect({ left: 0, top: 0, right: 800, bottom: home.clientHeight });
  var y = 0;
  kids.forEach(function (n) {
    n.offsetHeight = cardH;
    n.setRect({ left: 0, top: y, right: 800, bottom: y + cardH });
    y += cardH;
  });

  /* state the premise, so this test cannot quietly stop testing the boundary */
  app.advance(12500);
  var line = app.logs.log.filter(function (l) { return l.indexOf("[inky] layout:") === 0; })[0];
  assert.match(line, /slack=0px/, "this test is no longer sitting on the slack=0 boundary");

  app.WP.relayoutHome();
  kids.forEach(function (n) {
    assert.equal(n.style.maxHeight, "", "a growth cap was applied with zero slack");
  });
});

test("measuring the column leaves no inline style behind on it", function () {
  /* homeMetrics has to neutralise three things to read an honest number — the growth
     caps, flex-grow on the items, and (since portrait became a WRAPPED row, where the
     leftover space goes to the LINES) align-content on the container. Every one of those
     is an inline style written onto the live layout mid-frame, so every one has to be put
     back. A leaked align-content would pin the dashboard to the top of the screen for
     good; a leaked flex-grow would stop the cards filling the column. */
  var app = h.createApp({});
  layout(app);
  var home = app.$("home");
  home.style.alignContent = "stretch";        // the value the stylesheet is running with
  app.WP.relayoutHome();
  assert.equal(home.style.alignContent, "stretch", "the measurement kept its own value");
  app.qsa("#home > *").forEach(function (n) {
    /* minidom leaves a property that was never written as undefined, so "unset" is either */
    assert.ok(!n.style.flexGrow, "flex-grow was left neutralised on " + (n.id || n.className));
  });
});

test("burn-in drift may never nudge further down than the column has spare", function () {
  /* The wall panel's own instrumentation said slack=2px with every widget on, and a nudge
     is up to 12px — so for the stretch of every hour the random walk spent below the
     origin, the bottom of the news ticker was simply off the bottom of the screen
     (measured 40px clipped at full deflection in the simulator). Burn-in protection that
     clips content is worse than the ghosting it prevents, so the vertical range is
     whatever the column actually has, and a column with nothing spare holds still. */
  var app = h.createApp({});
  var kids = layout(app);                          // VIEW_H - 8 * CARD_H = 100px of slack
  app.advance(12500);
  assert.equal(app.WP._layout.metrics().slack, 100, "this test is not sitting on real slack");
  assert.equal(app.WP.drift.downRoom(12), 12, "plenty of slack should allow the full nudge");
  assert.equal(app.WP.drift.downRoom(400), 100, "the nudge may not exceed the slack");

  /* a column that already overflows holds still rather than making it worse */
  layout(app, { cardHeight: 200 });
  assert.ok(app.WP._layout.metrics().slack < 0, "premise: the column is overflowing");
  assert.equal(app.WP.drift.downRoom(12), 0, "an overflowing column was nudged down anyway");
});

test("the column is never reflowed under a finger", function () {
  var app = h.createApp({});
  var kids = layout(app);
  app.WP.relayoutHome();
  var capped = kids[0].style.maxHeight;

  app.doc.dispatch(kids[0], "pointerdown", { pointerId: 2, clientX: 5, clientY: 5 });
  kids.forEach(function (n) { n.offsetHeight = 40; });
  app.WP.relayoutHome();
  assert.equal(kids[0].style.maxHeight, capped, "the column reflowed with a finger down");
});

test("a toast appears and clears itself", function () {
  var app = h.createApp({});
  app.WP.toast("hello wall");
  assert.equal(app.text("toast"), "hello wall");
  assert.equal(app.$("toast").classList.contains("show"), true);
  assert.equal(app.doc.body.classList.contains("toasting"), true,
    "the line underneath has to fade or the toast prints through it");

  app.advance(2000);
  assert.equal(app.$("toast").classList.contains("show"), false);
  assert.equal(app.doc.body.classList.contains("toasting"), false);
});

test("the status line carries a warn class only when it is a warning", function () {
  var app = h.createApp({});
  app.WP.status("all good");
  assert.equal(app.$("status").className, "status");
  app.WP.status("something is wrong", true);
  assert.equal(app.$("status").className, "status warn");
});

test("the page has no inline handlers and loads no remote script", function () {
  /* The WebView allowlist blocks off-origin navigation; the page itself must not be
     reaching out either. No CDNs, no frameworks — that is the whole premise. */
  var html = h.readAsset("index.html");
  assert.equal(/\son[a-z]+\s*=/.test(html), false, "index.html has an inline event handler");
  var srcs = (html.match(/src="([^"]+)"/g) || []).map(function (s) {
    return s.slice(5, -1);
  });
  assert.ok(srcs.length >= 3, "index.html loads no scripts at all");
  srcs.forEach(function (s) {
    assert.equal(/^https?:|^\/\//.test(s), false, "remote script: " + s);
    assert.equal(/^[a-z0-9.-]+\.js$/.test(s), true,
      "a script src that is not a flat local file: " + s);
  });
  assert.equal(/https?:\/\//.test(html), false, "index.html references a remote origin");
});

test("the only network origin the app talks to is Open-Meteo", function () {
  var app = h.createApp({ fetch: require("./lib/wx-fixture.js").serve() });
  return app.flush().then(function () {
    app.advance(60000);
    app.fetches.forEach(function (f) {
      assert.match(f.url, /^https:\/\/(api|air-quality-api)\.open-meteo\.com\//,
        "unexpected origin: " + f.url);
    });
  });
});
