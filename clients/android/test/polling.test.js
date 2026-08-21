/* Poll and repaint cadences.

   A wall panel runs for months without being touched, so the cost of the idle state is the
   cost of the app. Before this file existed the dashboard, sitting on the resting home view
   with nothing running, did this every single second:

     - rewrote four clock nodes and built a fresh Intl date formatter (86,400/day)
     - rewrote both timer tile nodes at 10 Hz, always with the identical text
     - crossed the JS/Java bridge every 5 s and re-rendered the Device tile (~17,300/day)
     - re-scanned 168 forecast timestamps four times a minute to find the current hour

   and, with the clock panel open, rebuilt its entire body — nine world clocks, eighteen
   freshly-constructed Intl.DateTimeFormat objects — once a second.

   None of that is measurable from a screenshot, which is exactly why it needs tests. Each
   one below states the cadence as a NUMBER, so a regression is a failing count rather than
   something nobody notices until the battery graph tilts. The Device-panel cadence lives in
   device-bridge.test.js with the rest of the bridge contract.

   The counters instrument minidom's textContent / innerHTML accessors. That measures the
   thing that actually costs — a DOM write, i.e. a layout invalidation — rather than a
   proxy for it. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var wx = require("./lib/wx-fixture.js");

/* Count writes to `prop` on the given elements. Returns a function giving the count. */
function countWrites(els, prop) {
  var n = 0;
  els.forEach(function (el) {
    var desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop);
    assert.ok(desc && desc.set, "minidom has no " + prop + " setter to instrument");
    Object.defineProperty(el, prop, {
      configurable: true,
      get: function () { return desc.get.call(this); },
      set: function (v) { n++; desc.set.call(this, v); }
    });
  });
  return function () { return n; };
}

/* ---------------- the 1 Hz clock tick ---------------- */

test("an idle minute of clock ticks writes the minute once, not sixty times", function () {
  /* Seconds are off by default, so within one minute NOTHING the clock shows changes. */
  var app = h.createApp({ now: Date.parse("2025-06-10T09:30:05") });
  var writes = countWrites(
    [app.$("time"), app.$("ampm"), app.$("secs"), app.$("date")], "textContent");

  app.advance(50000);                      // 09:30:05 -> 09:30:55, still the same minute
  assert.equal(writes(), 0, "the clock rewrote itself " + writes() + " times inside one minute");

  app.advance(10000);                      // crosses into 09:31
  assert.equal(writes(), 1, "the minute rollover did not reach the clock");
});

test("the date is rewritten once a day, not once a second", function () {
  var app = h.createApp({ now: Date.parse("2025-06-10T23:59:50") });
  var writes = countWrites([app.$("date")], "textContent");
  app.advance(9000);                       // up to 23:59:59
  assert.equal(writes(), 0);
  app.advance(2000);                       // into the 11th
  assert.equal(writes(), 1, "the date did not change at midnight");
  assert.match(app.text("date"), /Wednesday/);
});

test("toLocaleDateString is called once a day, not 86,400 times", function () {
  /* The formatter build is the expensive half of the old tick. The sandbox shares
     Date.prototype with the host, so wrap and restore around the measurement. */
  var app = h.createApp({ now: Date.parse("2025-06-10T12:00:00") });
  var proto = Date.prototype;
  var orig = proto.toLocaleDateString;
  var calls = 0;
  proto.toLocaleDateString = function () { calls++; return orig.apply(this, arguments); };
  try {
    app.advance(3600000);                  // a full hour of ticks
  } finally {
    proto.toLocaleDateString = orig;
  }
  assert.equal(calls, 0, "toLocaleDateString ran " + calls + " times in an hour with no date change");
});

test("a 12/24h flip still reaches the clock on the tick it happens", function () {
  /* The dirty check is on the rendered string, so a settings change must not be swallowed
     by it — this is the failure mode a naive "only repaint on the minute" would have. */
  var app = h.createApp({ now: Date.parse("2025-06-10T15:30:20") });
  assert.equal(app.text("time"), "3:30");
  assert.equal(app.text("ampm"), "PM");

  app.WP.settings.set("clockHours", 24);
  assert.equal(app.text("time"), "15:30", "24-hour did not apply until the next minute");
  assert.equal(app.text("ampm"), "");

  app.WP.settings.set("seconds", true);
  assert.equal(app.text("secs"), ":20", "the seconds field did not appear immediately");
  app.advance(1000);
  assert.equal(app.text("secs"), ":21", "seconds stopped ticking once they were switched on");
});

/* ---------------- the clock detail panel ---------------- */

test("the open clock panel rebuilds once a minute and ticks its readout every second",
  function () {
    var app = h.createApp({ now: Date.parse("2025-06-10T09:30:05") });
    app.WP.panels.open("clock");
    var body = app.panelBody("clock");
    var rebuilds = countWrites([body], "innerHTML");

    var readout = app.$("clk-big");
    assert.ok(readout, "the panel has no live readout node to tick");
    var before = readout.textContent;

    app.advance(3000);
    assert.equal(rebuilds(), 0, "the panel rebuilt " + rebuilds() + " times inside three seconds");
    assert.notEqual(app.$("clk-big").textContent, before, "the seconds readout stopped moving");

    app.advance(52000);                    // now across the 09:31 boundary
    assert.equal(rebuilds(), 1, "expected exactly one rebuild per minute, got " + rebuilds());

    /* the world clocks are what the rebuild is FOR — they must have followed the minute */
    assert.match(body.textContent, /UTC/);
    app.WP.panels.closeAll();
  });

test("the clock panel's per-second work does not touch the world clocks", function () {
  /* Guards the split itself: if tickLight ever starts calling render() every second the
     rebuild count above is the only thing standing between us and the old behaviour.
     CHANGED with the copy sweep: the per-second element used to be the epoch counter
     ("Unix time 1786999387", removed as raw developer output). The big readout shows
     seconds and is therefore the remaining thing that must move every second — which is a
     better probe anyway, since it is the one a person is actually looking at. */
  var app = h.createApp({ now: Date.parse("2025-06-10T09:30:05") });
  app.WP.panels.open("clock");
  var body = app.panelBody("clock");
  assert.equal(app.qs("#clk-epoch"), null, "the epoch counter is back on the wall");
  var bigBefore = app.$("clk-big").textContent;
  var rebuilds = countWrites([body], "innerHTML");

  app.advance(4000);
  assert.equal(rebuilds(), 0);
  assert.notEqual(app.$("clk-big").textContent, bigBefore, "the seconds froze");
  app.WP.panels.closeAll();
});

/* ---------------- the 10 Hz timer tile ---------------- */

test("the resting timer tile is not rewritten ten times a second", function () {
  /* The 10 Hz interval has to stay — it is what makes the panel's tenths readable and what
     makes opening it feel instant — so what is being asserted is that a tick with nothing
     to say costs no DOM writes. */
  var app = h.createApp({});
  /* The widget's first tick is 100 ms after boot and is the one paint that legitimately
     writes — index.html ships "00:00 / ready" as static text and the widget has not
     yet claimed it. Let that land before measuring the steady state. */
  app.advance(1000);
  var writes = countWrites([app.$("tmr-big"), app.$("tmr-sub")], "textContent");
  app.advance(60000);
  assert.equal(writes(), 0, "an idle timer tile was rewritten " + writes() + " times a minute");

  /* 600 ticks happened in that minute; prove the interval is genuinely still running rather
     than the tile having gone quiet because the widget stopped. */
  app.WP.registry.timer.sw.running = true;
  app.WP.registry.timer.sw.startedAt = app.clock.now;
  app.advance(1000);
  assert.ok(writes() > 0, "the 10 Hz tick is not running at all");
});

test("the 10 Hz cadence itself is intact: a running countdown still updates every second",
  function () {
    var app = h.createApp({});
    app.WP.panels.open("timer");
    app.tap(app.actBtn("timer", "mode"));            // -> countdown is the second option
    var seg = app.qsa('[data-panel="timer"] [data-act="mode"]');
    app.tap(seg[1]);
    app.tap(app.actBtn("timer", "cd-toggle"));       // start

    var disp = app.$("tmr-disp");
    assert.equal(disp.textContent, "05:00");
    app.advance(100);
    app.advance(900);
    assert.equal(app.$("tmr-disp").textContent, "04:59", "the countdown stopped counting");

    /* and the tile behind it, at 1 Hz */
    var writes = countWrites([app.$("tmr-big")], "textContent");
    app.advance(1000);
    assert.equal(writes(), 1, "a running countdown wrote the tile " + writes() + " times a second");
    app.WP.panels.closeAll();
  });

/* ---------------- the forecast hour scan ---------------- */

test("nowIndex scans the forecast once an hour, not four times a minute", function () {
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    var w = app.registry.weather;
    assert.ok(w.data && w.data.hourly, "the fixture payload did not land");

    var real = w.data.hourly.time;
    var reads = 0;
    w.data.hourly.time = new Proxy(real, {
      get: function (t, k) {
        if (typeof k === "string" && String(Number(k)) === k) reads++;
        return t[k];
      }
    });
    w.niData = null;                                 // force a cold call

    var cold = w.nowIndex();
    assert.ok(reads > 0, "nowIndex did not read the timestamps at all");
    var scanCost = reads;

    reads = 0;
    for (var i = 0; i < 40; i++) assert.equal(w.nowIndex(), cold);
    assert.equal(reads, 0,
      "40 in-hour calls re-scanned the forecast (" + reads + " reads; one scan is " + scanCost + ")");
  });
});

test("the hour boundary still invalidates the cached index", function () {
  /* The memo must not outlive the hour it was computed in — the Now card and the NOW chip
     agreeing after a rollover is the regression this whole area exists for. */
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    var w = app.registry.weather;
    var before = w.nowIndex();
    app.clock.set(app.clock.now + 3600000);
    assert.equal(w.nowIndex(), before + 1, "the cached hour index survived an hour rollover");
  });
});

test("a fresh payload invalidates the cached index even inside the same hour", function () {
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    var w = app.registry.weather;
    w.nowIndex();
    /* a payload built for a different day: same wall-clock hour, different index */
    w.data = wx.build({ now: app.clock.now, hours: 24 * 7 });
    var again = w.nowIndex();
    assert.ok(again >= 0, "nowIndex returned a stale answer for a replaced payload");
    assert.equal(w.niData, w.data, "the cache is still keyed to the previous payload");
  });
});
