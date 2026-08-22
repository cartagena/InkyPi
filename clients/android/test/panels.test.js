/* The panel stack and the gesture delegation underneath it.

   Geometry is explicit here: minidom gives every element a zero rect until a test says
   otherwise, so the close-shadow tests state exactly which rectangles overlap. That is the
   point — the bug was about one rectangle becoming live under a finger that had not moved. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

/* the wall panel's frame, in CSS px */
var W = 800, H = 1280;

/* Lay the header ✕ over the topbar gear, the way the real stylesheet does.

   This used to lay a full-width "← Dashboard" bar over the bottom tile row as well, and
   the close-shadow tests were written against that overlap. The bar is gone (it cost
   113 CSS px on every panel and duplicated this ✕), so the one place a close control sits
   on top of another control is here: the ✕ at the top right, the settings gear underneath
   it. The shadow is what stops the second half of a double-tap falling through. */
function layout(app, panelName) {
  var panel = app.qs('[data-panel="' + panelName + '"]');
  var x = panel.querySelector(".panel-head [data-close]");
  x.setRect({ left: W - 120, top: 0, right: W, bottom: 120 });

  /* the tile row, well clear of the ✕ — a tap here must never be shadowed */
  app.qs('[data-open="system"]').setRect({ left: 0, top: H - 190, right: 260, bottom: H - 30 });
  app.qs('[data-open="timer"]').setRect({ left: 270, top: H - 190, right: 530, bottom: H - 30 });
  app.qs('.row3 [data-open="settings"]').setRect({ left: 540, top: H - 190, right: W, bottom: H - 30 });
  /* the gear in the topbar sits under the header ✕ */
  app.qs("#topbar [data-open]").setRect({ left: W - 110, top: 10, right: W - 10, bottom: 110 });
  return { x: x, gear: app.qs("#topbar [data-open]") };
}

/* the point that is inside BOTH the header ✕ and the topbar gear under it */
var X_PT = { x: W - 60, y: 60 };

test("tapping a card opens its panel; the header ✕ closes it", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  assert.deepEqual(app.stack(), ["system"]);
  assert.equal(app.qs('[data-panel="system"]').classList.contains("is-open"), true);
  assert.equal(app.doc.body.classList.contains("panel-open"), true);

  app.tap(app.qs('[data-panel="system"] .panel-head [data-close]'));
  assert.deepEqual(app.stack(), []);
  assert.equal(app.qs('[data-panel="system"]').classList.contains("is-open"), false);
  assert.equal(app.doc.body.classList.contains("panel-open"), false);
});

test("every panel offers exactly one way out, and it is the header ✕", function () {
  /* The second exit — a full-width "← Dashboard" bar pinned under every panel — was the
     single most expensive thing on these screens: 113 CSS px of a 1138 px viewport, on all
     twelve, for an action already available in the header, and the further of the two from
     the thumb of somebody standing at the wall. Four panels ended on a row chopped in half
     under its gradient fade and four pooled 400-900 px of black above it. Anything that
     puts a second exit back has to answer for that height. */
  var app = h.createApp({});
  var panels = app.qsa("[data-panel]");
  assert.ok(panels.length >= 11, "only " + panels.length + " panels");
  panels.forEach(function (panel) {
    var name = panel.getAttribute("data-panel");
    var closers = panel.querySelectorAll("[data-close]");
    assert.equal(closers.length, 1, name + " has " + closers.length + " close controls");
    assert.ok(panel.querySelector(".panel-head [data-close]"),
      name + "'s exit is not in its header");
    assert.equal(panel.querySelectorAll(".panel-foot").length, 0, name + " grew a footer again");
  });
});

test("REGRESSION: double-tapping the header ✕ does not open Settings", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  var els = layout(app, "system");
  var gear = app.qs("#topbar [data-open]");
  assert.equal(gear.getAttribute("data-open"), "settings");

  var pt = { x: W - 60, y: 60 };
  app.tap(els.x, pt);
  assert.deepEqual(app.stack(), []);
  app.clock.advance(120);
  app.tap(gear, pt);
  assert.deepEqual(app.stack(), [], "double-tapping ✕ dropped the user into Settings");
});

test("close-then-tap-a-DIFFERENT-card at ~100 ms still opens", function () {
  /* The suppression has to stay narrow. A post-close cooldown would put back exactly the
     dead window that releasing pointer-events removed. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  var els = layout(app, "system");

  app.tap(els.x, X_PT);
  app.clock.advance(100);
  app.tap(app.qs('[data-open="timer"]'));      // a different tile, not under that point
  assert.deepEqual(app.stack(), ["timer"], "close-then-tap-elsewhere must still work");
});

test("the control under the ✕ opens normally once the shadow has expired", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  var els = layout(app, "system");

  app.tap(els.x, X_PT);
  app.clock.advance(700);                      // past CLOSE_SHADOW_MS
  app.tap(els.gear, X_PT);
  assert.deepEqual(app.stack(), ["settings"], "the shadow outlived its 600 ms");
});

test("a close leaves no shadow anywhere else on the screen", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  var els = layout(app, "system");
  app.tap(els.x, X_PT);
  app.tap(app.qs('.row3 [data-open="settings"]'), { x: 600, y: H - 100 });
  assert.deepEqual(app.stack(), ["settings"]);
});

test("a panel closed and reopened inside the unmount window stays mounted", function () {
  /* close() leaves a 240 ms timer that strips is-mounted; reopening must cancel it, or the
     panel loses visibility in the middle of being opened. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(app.qs('[data-panel="timer"] .panel-head [data-close]'));
  app.clock.advance(100);
  app.WP.panels.open("timer");
  app.clock.advance(300);
  var panel = app.qs('[data-panel="timer"]');
  assert.equal(panel.classList.contains("is-mounted"), true, "the unmount timer was not cancelled");
  assert.equal(panel.classList.contains("is-open"), true);
});

test("opening a panel resets its scroll position", function () {
  /* Reopening Settings scrolled to MAINTENANCE put the WIDGETS rows where the reader
     expected UNITS, and cost a mis-tap that silently hid a widget. */
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var body = app.panelBody("settings");
  body.scrollTop = 640;
  app.WP.panels.close();
  app.WP.panels.open("settings");
  assert.equal(body.scrollTop, 0);
});

test("a repaint while the panel is open preserves the scroll position", function () {
  /* The sensors panel rebuilds every tick as values move; a plain innerHTML swap would make
     it impossible to scroll at all. */
  var app = h.createApp({});
  app.WP.panels.open("sensors");
  var body = app.panelBody("sensors");
  body.scrollTop = 420;
  app.advance(6000);                            // at least one 5 s sensor tick
  assert.equal(body.scrollTop, 420, "a repaint threw the reader back to the top");
});

test("panels stack and unwind in order", function () {
  var app = h.createApp({});
  app.WP.panels.open("weather");
  app.WP.panels.open("hourly");
  assert.deepEqual(app.stack(), ["weather", "hourly"]);
  assert.equal(app.WP.panels.top(), "hourly");
  assert.equal(app.WP.panels.isOpen("weather"), true);

  app.WP.panels.close();
  assert.deepEqual(app.stack(), ["weather"]);
  assert.equal(app.doc.body.classList.contains("panel-open"), true,
    "the body class must survive while something is still open");
  app.WP.panels.close();
  assert.equal(app.doc.body.classList.contains("panel-open"), false);
});

test("the Android back button closes one panel and never leaves the app", function () {
  var app = h.createApp({});
  assert.equal(app.WP.onAndroidBack(), false, "back with nothing open must not be consumed");

  app.WP.panels.open("weather");
  app.WP.panels.open("hourly");
  assert.equal(app.WP.onAndroidBack(), true);
  assert.deepEqual(app.stack(), ["weather"]);
  assert.equal(app.WP.onAndroidBack(), true);
  assert.deepEqual(app.stack(), []);
  assert.equal(app.WP.onAndroidBack(), false);
});

test("an open panel unwinds after 90 s idle — but not while it is being read", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="system"]'));
  app.advance(85000);
  assert.deepEqual(app.stack(), ["system"], "85 s in, it is still open");

  /* somebody is reading it and touches the screen */
  app.doc.dispatch(app.panelBody("system"), "pointerdown", { pointerId: 9, clientX: 5, clientY: 5 });
  app.doc.dispatch(app.panelBody("system"), "pointerup", { pointerId: 9, clientX: 5, clientY: 5 });
  app.advance(60000);
  assert.deepEqual(app.stack(), ["system"], "a touch must restart the 90 s");

  app.advance(35000);
  assert.deepEqual(app.stack(), [], "90 s unattended and the dashboard should be back");
  assert.equal(app.text("toast"), "Idle — back to dashboard");
});

test("the idle unwind takes the whole stack down", function () {
  var app = h.createApp({});
  app.WP.panels.open("weather");
  app.WP.panels.open("hourly");
  app.advance(95000);
  assert.deepEqual(app.stack(), []);
});

test("a tap that starts on one control and ends on another does nothing", function () {
  var app = h.createApp({});
  var tile = app.qs('[data-open="timer"]');
  var other = app.qs('[data-open="system"]');
  app.doc.dispatch(tile, "pointerdown", { pointerId: 3, clientX: 10, clientY: 10 });
  app.doc.dispatch(other, "pointerup", { pointerId: 3, clientX: 400, clientY: 10 });
  assert.deepEqual(app.stack(), [], "release must be over the element the press started on");
});

test("a scroll gesture never opens a panel", function () {
  var app = h.createApp({});
  var tile = app.qs('[data-open="timer"]');
  app.doc.dispatch(tile, "pointerdown", { pointerId: 4, clientX: 10, clientY: 10 });
  app.doc.dispatch(app.doc.body, "scroll", {});
  app.doc.dispatch(tile, "pointercancel", { pointerId: 4, clientX: 10, clientY: 10 });
  assert.deepEqual(app.stack(), [], "a scroll was treated as a tap");
});

test("a long press opens a panel — Chrome swallows the click", function () {
  var app = h.createApp({});
  app.longPress(app.qs('[data-open="timer"]'), 700);
  assert.deepEqual(app.stack(), ["timer"], "a 700 ms press on a card did nothing");
});

test("the click Chrome sends after a tap does not run the action twice", function () {
  var app = h.createApp({});
  var tile = app.qs('[data-open="timer"]');
  app.tap(tile);                                 // pointerdown + pointerup + click
  assert.deepEqual(app.stack(), ["timer"], "the trailing click opened a second panel");
});

test("every tappable control is reachable by the pointer delegation", function () {
  /* The app's own boot-time guard, asserted rather than eyeballed in logcat: anything
     tappable that hit() cannot resolve will ignore a long press. */
  var app = h.createApp({});
  var orphans = app.qsa("button, .tappable").filter(function (n) {
    return !n.closest("[data-open],[data-act],[data-close]");
  });
  assert.deepEqual(orphans.map(function (n) { return n.id || n.className; }), []);
  assert.deepEqual(app.logs.warn, [], "boot warned about orphaned tappables");
});

test("burn-in drift moves every layer by the identical offset", function () {
  /* A pure rigid translation: home, panels and the alarm overlay have to stay registered
     with each other or there is a visible seam. And it must not be zero. */
  var app = h.createApp({ random: function () { return 0.9; } });
  app.WP.drift.nudge();
  var home = app.$("drift").style.transform;
  assert.equal(app.$("panels").style.transform, home);
  assert.equal(app.$("alarm").style.transform, home);
  assert.match(home, /^translate\(-?\d+\.\d+px,-?\d+\.\d+px\)$/);
  assert.notEqual(home, "translate(0.0px,0.0px)", "drift must actually move");

  var px = home.match(/-?\d+\.\d+/g).map(Number);
  assert.ok(Math.abs(px[0]) <= 12 && Math.abs(px[1]) <= 12, "drift exceeded maxShiftPx");
});

/* A Math.random that never repeats a pair. This matters more than it looks: with a CONSTANT
   stub (the old `return 0.9`) every nudge computes the SAME translate(), so "the transform did
   not change" was true whether the nudge was skipped or ran in full — and the guard that keeps
   drift off a finger was, in effect, untested. Any nudge that actually executes now moves the
   layer somewhere new, so an unchanged transform can only mean it was skipped. */
function walkingRandom() {
  var i = 0;
  return function () { return (i++ % 7) / 7; };
}

test("drift is skipped while a finger is down, and off when switched off", function () {
  var app = h.createApp({ random: walkingRandom() });
  app.WP.drift.nudge();
  var before = app.$("drift").style.transform;

  app.doc.dispatch(app.qs('[data-open="timer"]'), "pointerdown", { pointerId: 7, clientX: 1, clientY: 1 });
  app.WP.drift.nudge();
  assert.equal(app.$("drift").style.transform, before, "a nudge moved a control under a finger");
  app.doc.dispatch(app.qs('[data-open="timer"]'), "pointerup", { pointerId: 7, clientX: 1, clientY: 1 });

  /* ...and the same finger, held across a real drift interval rather than a hand-called
     nudge(): the cycle is driven by setInterval, and that is the path a wall panel is on
     while somebody is pressing a button. */
  app.doc.dispatch(app.qs('[data-open="timer"]'), "pointerdown", { pointerId: 8, clientX: 1, clientY: 1 });
  var held = app.$("drift").style.transform;
  app.advance(130000);                       // burnInProtection.intervalSeconds is 120
  assert.equal(app.$("drift").style.transform, held,
    "the drift interval moved a control out from under a held finger");

  /* Release, and the next cycle must move again — otherwise this test would also pass on an
     app whose drift had simply stopped working. */
  app.doc.dispatch(app.qs('[data-open="timer"]'), "pointerup", { pointerId: 8, clientX: 1, clientY: 1 });
  app.advance(130000);
  assert.notEqual(app.$("drift").style.transform, held, "drift never resumed after the release");

  app.WP.settings.set("burnIn", false);
  assert.equal(app.$("drift").style.transform, "translate(0,0)", "drift off must reset the offset");
});

test("burn-in protection defaults to ON when config says nothing about it", function () {
  /* `b.enabled !== false` — absent block means protected. Flip that to `=== true` and the
     panel silently becomes opt-in: an AMOLED wall panel with a config file that predates the
     setting would ghost permanently and nothing would say so. The harness config always sets
     enabled:true, so this path had never been exercised. */
  var cfg = h.defaultConfig();
  delete cfg.burnInProtection;
  var app = h.createApp({ config: cfg, random: walkingRandom() });
  assert.equal(app.WP.settings.get("burnIn"), true, "burn-in protection defaulted to off");

  /* and behaviourally, not just as a stored flag: the layers must actually be moving */
  var before = app.$("drift").style.transform;
  app.advance(130000);                       // falls back to the built-in 120 s cycle
  assert.notEqual(app.$("drift").style.transform, before, "drift never ran with no config block");

  /* the one thing that DOES turn it off is saying so */
  cfg.burnInProtection = { enabled: false };
  var off = h.createApp({ config: cfg, random: walkingRandom() });
  assert.equal(off.WP.settings.get("burnIn"), false, "enabled:false was ignored");
  assert.equal(off.$("drift").style.transform, "translate(0,0)");
});
