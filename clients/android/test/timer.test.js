/* Stopwatch / countdown — the widget that produced two of the four self-inflicted
   regressions. Everything here goes through the real controls: the tests tap the buttons
   the panel actually renders, so a label and the action behind it can never drift apart
   without something failing. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

/* the segmented control renders one button per mode; pick by data-arg */
function pickMode(app, mode) {
  var btn = app.qs('[data-panel="timer"] [data-act="mode"][data-arg="' + mode + '"]');
  assert.ok(btn, "no mode button for " + mode);
  app.tap(btn);
}

function primary(app) {
  return app.qs('[data-panel="timer"] .btn-row .btn');
}

/* ---------------- countdown ---------------- */

test("countdown counts down and the display ceils", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  assert.equal(app.text("tmr-disp"), "05:00", "default preset is 5 minutes");

  app.tap(primary(app));
  assert.equal(app.registry.timer.cd.running, true);
  app.advance(1000);
  assert.equal(app.text("tmr-disp"), "04:59");
  app.advance(58000);
  assert.equal(app.text("tmr-disp"), "04:01");
});

test("REGRESSION: after the alarm fires the primary button says Start and starts", function () {
  /* The bug that shipped: the 10 Hz fast path only rewrites the digits, and the alarm
     firing changes state *outside* a button press. stateKey() did not include `ringing`,
     so no re-render happened, the button kept saying "Pause" over a stopped countdown,
     and pressing it started a fresh one. The label and the action disagreed. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  assert.equal(primary(app).textContent, "Pause", "a running countdown offers Pause");

  app.advance(61000);
  assert.equal(app.registry.timer.ringing, true, "the alarm should have fired");
  assert.equal(app.registry.timer.cd.running, false, "a finished countdown is not running");
  assert.equal(primary(app).textContent, "Start",
    "the button still claims Pause over a stopped countdown");

  /* and pressing it does what it says */
  app.tap(primary(app));
  assert.equal(app.registry.timer.cd.running, true);
  assert.equal(app.registry.timer.ringing, false, "starting a new countdown clears the alarm");
  assert.equal(primary(app).textContent, "Pause");
});

test("stateKey moves whenever a control's legality moves", function () {
  /* The direct statement of the invariant the bug above broke: every piece of state that
     changes which controls are legal has to be in the key that gates the re-render. */
  var t = h.createApp({}).registry.timer;
  var key = function () { return t.stateKey(); };

  var base = key();
  t.ringing = true;
  assert.notEqual(key(), base, "ringing must be part of the render key");
  t.ringing = false;

  t.cd.running = true;
  assert.notEqual(key(), base, "cd.running must be part of the render key");
  t.cd.running = false;

  t.sw.running = true;
  assert.notEqual(key(), base, "sw.running must be part of the render key");
  t.sw.running = false;

  t.sw.laps = [1000];
  assert.notEqual(key(), base, "lap count must be part of the render key");
  t.sw.laps = [];

  t.cd.duration = 999000;
  assert.notEqual(key(), base, "duration must be part of the render key (preset highlight)");
  t.mode = "countdown";
  assert.notEqual(key(), base);
});

test("REGRESSION: Reset after an alarm reloads the full duration, not 00:00", function () {
  /* stopAlarm() deliberately parks the countdown at zero so the next tap cannot re-fire the
     same alarm. cdReset() therefore has to run AFTER it. Swapping those two statements —
     which is exactly what happened — left Reset showing 00:00 and a timer that could not be
     started again without picking a preset. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);
  assert.equal(app.registry.timer.ringing, true);

  app.tap(app.actBtn("timer", "cd-reset"));
  assert.equal(app.registry.timer.ringing, false, "Reset must silence the alarm");
  assert.equal(app.registry.timer.cd.remain, 60000, "Reset must reload the whole duration");
  assert.equal(app.text("tmr-disp"), "01:00", "Reset parked the display at 00:00");
  assert.equal(app.text("tmr-big"), "00:00");
  /* CHANGED in the fit round: the tile is 102 CSS px wide and these strings were
     ellipsising in it ("stopwatch running" needed 124 px of an 80 px box). The big
     line above already says which mode is showing, so the mode word went and the
     state stayed. */
  assert.equal(app.text("tmr-sub"), "ready", "a reset timer is not 'paused'");
});

test("Reset from a paused countdown also reloads the duration", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(primary(app));
  app.advance(30000);
  app.tap(primary(app));                        // pause
  assert.equal(app.text("tmr-disp"), "04:30");
  app.tap(app.actBtn("timer", "cd-reset"));
  assert.equal(app.text("tmr-disp"), "05:00");
});

test("dismissing the alarm leaves the countdown genuinely stopped", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);

  app.tap(app.$("alarm-dismiss"));
  assert.equal(app.registry.timer.ringing, false);
  assert.equal(app.registry.timer.cd.running, false);
  assert.equal(app.registry.timer.cd.remain, 0);
  assert.equal(app.$("alarm").classList.contains("show"), false, "overlay must be hidden");

  /* the next Start must load a fresh duration rather than instantly re-firing */
  app.tap(primary(app));
  assert.equal(app.registry.timer.cd.running, true);
  assert.equal(app.registry.timer.ringing, false);
  app.advance(500);
  assert.equal(app.registry.timer.ringing, false, "Start re-fired the same finished alarm");
});

test("a 700 ms hold on Dismiss works — Chrome swallows the click", function () {
  /* The alarm's Dismiss was the one control still on its own click listener, so a press
     and hold (how anybody presses a button on a wall) did nothing at all. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);
  assert.equal(app.registry.timer.ringing, true);

  app.longPress(app.$("alarm-dismiss"), 700);
  assert.equal(app.registry.timer.ringing, false, "a 700 ms hold on Dismiss was ignored");
});

test("a tap anywhere on the alarm overlay dismisses it", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);
  app.tap(app.$("alarm"));
  assert.equal(app.registry.timer.ringing, false);
});

test("the alarm takes itself down after 60 s unattended, but not under a finger", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);
  assert.equal(app.registry.timer.ringing, true);

  app.advance(50000);
  assert.equal(app.registry.timer.ringing, true, "50 s in, it is still ringing");

  /* somebody walks up and taps a tile under the overlay: patience restarts */
  app.tap(app.qs('[data-open="system"]'));
  app.advance(40000);
  assert.equal(app.registry.timer.ringing, true, "interaction must restart the countdown");

  app.advance(25000);
  assert.equal(app.registry.timer.ringing, false, "60 s unattended and it should be gone");
  assert.equal(app.$("alarm").classList.contains("show"), false);
});

test("the tile keeps a 30-minute trace that then expires by itself", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  app.advance(61000);
  app.tap(app.$("alarm-dismiss"));
  app.WP.panels.closeAll();

  app.advance(2000);
  assert.equal(app.text("tmr-sub"), "just finished");
  app.advance(5 * 60000);
  assert.equal(app.text("tmr-sub"), "done 5m ago");
  app.advance(25 * 60000);
  assert.equal(app.text("tmr-sub"), "ready", "the trace must expire after 30 minutes");
  assert.equal(app.text("tmr-big"), "00:00");
});

test("a running stopwatch outranks the memory of a finished countdown", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="60"]'));
  app.tap(primary(app));
  pickMode(app, "stopwatch");
  app.tap(primary(app));                                 // start the stopwatch too
  app.advance(61000);                                    // countdown finishes underneath
  app.tap(app.$("alarm-dismiss"));
  app.WP.panels.closeAll();
  app.advance(1000);

  assert.equal(app.text("tmr-sub"), "running", "the live number must own the tile");
  assert.notEqual(app.text("tmr-big"), "00:00");
});

test("+1 / -1 min adjust the pending duration, and the running deadline", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  var plus = app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="60"]');
  var minus = app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="-60"]');
  app.tap(plus);
  assert.equal(app.text("tmr-disp"), "06:00");
  app.tap(minus);
  app.tap(minus);
  assert.equal(app.text("tmr-disp"), "04:00");

  app.tap(primary(app));
  app.advance(10000);
  assert.equal(app.text("tmr-disp"), "03:50");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="60"]'));
  assert.equal(app.text("tmr-disp"), "04:50", "+1 min on a running timer moves the deadline");
});

test("the duration can never be bumped below one MINUTE", function () {
  /* The floor used to be one second, so "−1 min" from 1:00 left a 00:01 countdown: a
     timer nobody chose, which then fires a full-screen alarm a second later. The controls
     step in minutes, so the floor is a minute. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  for (var i = 0; i < 10; i++) {
    app.tap(app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="-60"]'));
  }
  assert.equal(app.registry.timer.cd.duration, 60000, "the floor is not one minute");
  assert.equal(app.text("tmr-disp"), "01:00");

  /* and it is a floor, not a clamp on the whole control: +1 min still climbs from it */
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="60"]'));
  assert.equal(app.text("tmr-disp"), "02:00");
});

test("the loaded preset is the highlighted chip", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  pickMode(app, "countdown");
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-preset"][data-arg="600"]'));
  var on = app.qsa('[data-panel="timer"] .chip.on');
  assert.equal(on.length, 1);
  assert.equal(on[0].getAttribute("data-arg"), "600");

  /* a bump moves the duration off every preset, and then none is lit */
  app.tap(app.qs('[data-panel="timer"] [data-act="cd-bump"][data-arg="60"]'));
  assert.equal(app.qsa('[data-panel="timer"] .chip.on').length, 0);
});

/* ---------------- stopwatch ---------------- */

test("stopwatch start / stop / resume accumulates real elapsed time", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(primary(app));
  app.advance(4000);
  app.tap(primary(app));                        // stop
  app.advance(10000);                           // wall time passes while stopped
  assert.equal(app.text("tmr-disp"), "00:04.0", "a stopped stopwatch must not accumulate");
  app.tap(primary(app));                        // resume
  app.advance(1500);
  assert.equal(app.text("tmr-disp"), "00:05.5");
});

test("laps split the displayed totals and reconcile exactly", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(primary(app));
  [3200, 4100, 2700].forEach(function (ms) {
    app.advance(ms);
    app.tap(app.actBtn("timer", "sw-lap"));
  });
  var rows = app.qsa('[data-panel="timer"] .lap');
  assert.equal(rows.length, 3);
  /* newest first */
  var totals = rows.map(function (r) { return r.querySelector(".lap-t").textContent; });
  var splits = rows.map(function (r) { return r.querySelector(".lap-d").textContent; });
  assert.deepEqual(totals, ["00:10.0", "00:07.3", "00:03.2"]);
  assert.deepEqual(splits, ["+00:02.7", "+00:04.1", "+00:03.2"]);

  /* the splits must add up to the newest total, to the tenth */
  var sum = splits.reduce(function (a, s) { return a + tenths(s.slice(1)); }, 0);
  assert.equal(sum, tenths(totals[0]), "splits do not reconcile with the running total");
});

function tenths(s) {
  var p = s.split(":");
  var last = p.pop().split(".");
  return (Number(p[0] || 0) * 60 + Number(last[0])) * 10 + Number(last[1] || 0);
}

test("Lap does nothing while the stopwatch is stopped", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(app.actBtn("timer", "sw-lap"));
  assert.equal(app.registry.timer.sw.laps.length, 0);
  assert.ok(app.actBtn("timer", "sw-lap").className.indexOf("off") !== -1,
    "the Lap button should look unavailable while stopped");
});

test("the lap list is capped at 30", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(primary(app));
  for (var i = 0; i < 40; i++) {
    app.advance(500);
    app.tap(app.actBtn("timer", "sw-lap"));
  }
  assert.equal(app.registry.timer.sw.laps.length, 30);
});

test("stopwatch Reset clears the laps and the elapsed time", function () {
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(primary(app));
  app.advance(2000);
  app.tap(app.actBtn("timer", "sw-lap"));
  app.tap(app.actBtn("timer", "sw-reset"));
  assert.equal(app.registry.timer.sw.laps.length, 0);
  assert.equal(app.text("tmr-disp"), "00:00.0");
  assert.equal(primary(app).textContent, "Start");
});

test("the home tile tracks the timer with the panel closed", function () {
  var app = h.createApp({});
  assert.equal(app.text("tmr-sub"), "ready");
  app.tap(app.qs('[data-open="timer"]'));
  app.tap(primary(app));
  app.WP.panels.closeAll();
  app.advance(65000);
  assert.equal(app.text("tmr-sub"), "running");
  /* The tile repaints at ~1 Hz with the panel closed and the stopwatch did not start on a
     tick boundary, so it is allowed to be up to a second behind — but no more than that. */
  assert.ok(["01:04", "01:05"].indexOf(app.text("tmr-big")) !== -1,
    "tile reads " + app.text("tmr-big") + ", more than a second behind");
});

test("a swipe across the panel does not press a button", function () {
  /* pointerup must not fire on swipes — the panel body scrolls. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  app.swipe(primary(app), 0, 40);
  assert.equal(app.registry.timer.sw.running, false, "a scroll gesture started the stopwatch");
});

test("the empty lap region is reserved, not RULED", function () {
  /* Two rounds, two opposite failures on the same rectangle. First it was dropped when the
     lap count was zero, which left a 747 device px band of undifferentiated black — 29% of
     the frame — and then made the layout jump the instant lap 1 landed. Then it was drawn
     as seven full-width hairlines at a real lap row's pitch, which measured 8.5% of all the
     ink on the screen and about 40% of its height: an empty ruled notepad, on the panel
     whose stated rule is that lit pixels are data.

     Reserving the space was the right half of the second answer and the rules were the
     wrong half. So: the region exists and holds its share of the column with no laps taken
     (no jump), and it draws nothing in it (no notepad). */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  var body = app.panelBody("timer");
  var hint = body.querySelector(".laps-hint");
  assert.ok(hint, "the lap region is dropped again when there are no laps — the layout will jump");
  assert.equal(app.qsa(".lap", body).length, 0);

  /* the rules were a repeating gradient on .laps-hint, so the assertion is on the rule */
  var css = require("./lib/css.js");
  var r = css.rules().filter(function (x) { return x.sel.trim() === ".laps-hint"; })[0];
  assert.ok(r, ".laps-hint has no rule at all");
  assert.equal(/repeating-linear-gradient|border-bottom/.test(r.body), false,
    "the empty lap table is drawing its own rules again: " + r.body.trim());

  /* and a real lap draws a real row */
  app.tap(app.actBtn("timer", "sw-toggle"));
  app.advance(1500);
  app.tap(app.actBtn("timer", "sw-lap"));
  assert.equal(app.qsa(".lap", app.panelBody("timer")).length, 1);
});

test("Start is the primary, and it is marked by WEIGHT rather than by hue", function () {
  /* The green Start was correctly removed — a hue on this wall means a datum, not an
     affordance — and nothing replaced its job, so the screen became three identical
     hairline pills with only Lap dimmed: a stopwatch with no obvious way to start it.
     A neutral fill is weight, not colour, and it is the same family of fill Settings'
     selected unit and a selected chip already carry. */
  var app = h.createApp({});
  app.tap(app.qs('[data-open="timer"]'));
  var start = app.actBtn("timer", "sw-toggle");
  assert.equal(start.textContent, "Start");
  assert.match(start.getAttribute("class"), /\bfill\b/, "the primary carries no weight at all");
  ["sw-lap", "sw-reset"].forEach(function (a) {
    assert.equal(/\bfill\b/.test(app.actBtn("timer", a).getAttribute("class")), false,
      a + " is marked primary too, so nothing is");
  });

  var css = require("./lib/css.js");
  var r = css.rules().filter(function (x) { return x.sel.trim() === ".btn.fill"; })[0];
  assert.ok(r, ".btn.fill has no rule, so the class marks nothing");
  assert.match(r.body, /rgba\(255,\s*255,\s*255/,
    "the primary is filled with something that is not neutral white");
});
