/* The carousel: swipes between screens, slide transitions, and the InkyPi playlist.

   Swipes are dispatched as raw pointer events (down/move/up) rather than through the
   harness tap helper, because the carousel deliberately listens below the tap layer —
   a swipe must never also be a tap, and vice versa. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

function swipeX(app, dx, endType) {
  var body = app.qs(".panel.is-open [data-body]") || app.doc.body;
  var r = body.getBoundingClientRect();
  var x = (r.left + r.right) / 2 || 350, y = (r.top + r.bottom) / 2 || 500;
  app.doc.dispatch(body, "pointerdown", { pointerId: 7, clientX: x, clientY: y });
  app.doc.dispatch(body, "pointermove", { pointerId: 7, clientX: x + dx, clientY: y + 4 });
  app.doc.dispatch(body, "pointerup", { pointerId: 7, clientX: x + dx, clientY: y + 4 });
  return app;
}

test("a left swipe in a panel slides to the next screen, replacing the stack", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");
  swipeX(app, -120, "pointerup");
  assert.deepEqual(app.stack(), ["weather"], "swipe must REPLACE the screen, not stack it");
  var el = app.qs('[data-panel="weather"]');
  assert.ok(el.classList.contains("is-open"), "next screen is not open");

  swipeX(app, 120, "pointerup");
  assert.deepEqual(app.stack(), ["clock"], "right swipe must go back to the neighbour");
});

test("the screen order wraps at both ends", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");             // first widget
  swipeX(app, 130, "pointerup");           // right swipe = previous = wrap to last
  assert.deepEqual(app.stack(), ["settings"]);
  swipeX(app, -130, "pointerup");
  assert.deepEqual(app.stack(), ["clock"]);
});

test("hidden widgets are not reachable by swiping", function () {
  var app = h.createApp({});
  app.WP.settings.setShow("weather", false);
  app.WP.panels.open("clock");
  swipeX(app, -120, "pointerup");
  assert.deepEqual(app.stack(), ["hourly"], "the hidden screen was not skipped");
});

test("a swipe on the home view opens nothing — home stays tap-driven", function () {
  var app = h.createApp({});
  swipeX(app, -150, "pointerup");
  assert.deepEqual(app.stack(), [], "a home swipe opened a panel");
});

test("a mostly-vertical drag is a scroll, not a navigation", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");
  var body = app.qs(".panel.is-open [data-body]");
  app.doc.dispatch(body, "pointerdown", { pointerId: 7, clientX: 300, clientY: 300 });
  app.doc.dispatch(body, "pointermove", { pointerId: 7, clientX: 380, clientY: 500 });
  app.doc.dispatch(body, "pointerup", { pointerId: 7, clientX: 380, clientY: 500 });
  assert.deepEqual(app.stack(), ["clock"], "a scroll gesture changed screens");
});

test("a pan Chrome ends with pointercancel still navigates, using tracked coordinates", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");
  var body = app.qs(".panel.is-open [data-body]");
  app.doc.dispatch(body, "pointerdown", { pointerId: 7, clientX: 400, clientY: 400 });
  app.doc.dispatch(body, "pointermove", { pointerId: 7, clientX: 250, clientY: 405 });
  app.doc.dispatch(body, "pointercancel", { pointerId: 7 });   // no coordinates, like Chrome
  assert.deepEqual(app.stack(), ["weather"], "the cancelled pan was dropped");
});

test("the slide classes drive the transition and clean themselves up", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");
  app.WP.panels.swap("weather", 1);
  var out = app.qs('[data-panel="clock"]');
  var into = app.qs('[data-panel="weather"]');
  assert.ok(out.classList.contains("slide-exit-l"), "outgoing screen has no exit class");
  assert.ok(into.classList.contains("slide-from-r"), "incoming screen has no entry class");
  app.advance(400);
  assert.equal(out.classList.contains("is-mounted"), false, "outgoing screen never unmounted");
  assert.equal(into.classList.contains("slide-from-r"), false, "entry class was never removed");
  assert.ok(into.classList.contains("is-open"));
});

test("the dots show the position and fade back out", function () {
  var app = h.createApp({});
  app.WP.panels.open("clock");
  swipeX(app, -120, "pointerup");
  var dots = app.$("dots");
  assert.ok(dots.classList.contains("show"), "no dots after a swipe");
  var on = dots.children.filter(function (c) { return /\bon\b/.test(c.getAttribute("class")); });
  assert.equal(on.length, 1, "exactly one dot should be lit");
  assert.equal(dots.children.length, app.WP.carousel.screens().length);
  app.advance(2000);
  assert.equal(dots.classList.contains("show"), false, "the dots never faded");
});

/* ---------------- the playlist ---------------- */

function quietStart(app) {
  /* the playlist waits out the touch hold-off; jump past it */
  app.WP.carousel.lastTouch = 0;
  app.WP.carousel.lastAdvance = 0;
}

test("cycling is off by default and the switch persists it", function () {
  var app = h.createApp({});
  assert.equal(app.WP.settings.get("cycle"), false, "the playlist must be opt-in");
  app.WP.panels.open("settings");
  var row = app.qs('[data-panel="settings"] [data-act="cycle"]');
  assert.ok(row, "settings offers no cycle switch");
  app.tap(row);
  assert.equal(app.WP.settings.get("cycle"), true);
});

test("with cycle on, the playlist walks the content screens and returns home", function () {
  var app = h.createApp({});
  app.WP.settings.set("cycle", true);
  quietStart(app);
  /* exactly one dwell per advance() call: the tick runs every second, so a window any
     longer than the dwell would advance twice inside one call */
  app.advance(20000);
  assert.equal(app.stack().length, 1, "the playlist never left home");
  var first = app.stack()[0];
  assert.ok(["clock", "weather"].indexOf(first) !== -1);
  assert.ok(!{ settings: 1, system: 1, timer: 1 }[first], "the playlist opened a tool screen");

  /* walk the whole list: it must come back to the dashboard, not pile up panels */
  var content = app.WP.carousel.playlist();
  for (var i = 0; i < content.length; i++) {
    app.WP.carousel.lastTouch = 0;
    app.advance(20000);
    assert.ok(app.stack().length <= 1, "screens stacked up instead of replacing");
  }
  assert.deepEqual(app.stack(), [], "a full loop must land back on the dashboard");
});

test("a touch pauses the playlist; an open tool screen stops it entirely", function () {
  var app = h.createApp({});
  app.WP.settings.set("cycle", true);
  quietStart(app);
  app.advance(20000);
  assert.equal(app.stack().length, 1);

  /* touching resets the hold-off: nothing advances for a while */
  var before = app.stack()[0];
  app.doc.dispatch(app.doc.body, "pointerdown", { pointerId: 3, clientX: 10, clientY: 10 });
  app.doc.dispatch(app.doc.body, "pointerup", { pointerId: 3, clientX: 10, clientY: 10 });
  app.advance(30000);
  assert.deepEqual(app.stack(), [before], "the playlist advanced under a reader's finger");

  /* settings open by hand: the playlist must not take the screen away */
  app.WP.panels.closeAll();
  app.WP.panels.open("settings");
  quietStart(app);
  app.advance(45000);
  assert.deepEqual(app.stack(), ["settings"], "the playlist stole the settings screen");
});

test("the playlist dwell is clamped to something readable", function () {
  var app = h.createApp({});
  assert.ok(app.WP.carousel.dwellMs() >= 8000, "dwell floor");
  assert.ok(app.WP.carousel.dwellMs() <= 60000, "dwell ceiling");
});
