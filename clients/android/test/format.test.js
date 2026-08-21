/* WP.fmt — the shared formatters. Two of these encode bugs that reached the wall:
   a countdown that truncated instead of ceiling, and lap splits that did not add up. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var app = h.createApp({});
var fmt = app.WP.fmt;
var S = app.WP.settings;

test("countdown ceils: a 60 s timer reads 01:00 -> 00:59 -> ... -> 00:01", function () {
  /* The exact sequence a user watches. Truncation made it jump 01:00 -> 00:58 and then
     sit on 00:00 for a full second before the alarm. */
  assert.equal(fmt.countdown(60000), "01:00");
  assert.equal(fmt.countdown(59999), "01:00");
  assert.equal(fmt.countdown(59001), "01:00");
  assert.equal(fmt.countdown(59000), "00:59");
  assert.equal(fmt.countdown(1500), "00:02");
  assert.equal(fmt.countdown(1000), "00:01");
  assert.equal(fmt.countdown(1), "00:01");
  assert.equal(fmt.countdown(0), "00:00");
  assert.equal(fmt.countdown(-500), "00:00", "negative remainder must not go below zero");
});

test("countdown never shows 00:00 while time remains", function () {
  for (var ms = 1; ms < 120000; ms += 137) {
    assert.notEqual(fmt.countdown(ms), "00:00", ms + " ms remaining still read 00:00");
  }
});

test("countdown holds each second for a full second", function () {
  /* 61 distinct readings across a 60 s countdown: 01:00 down to 00:01, then 00:00. */
  var seen = [];
  for (var ms = 60000; ms >= 0; ms -= 250) {
    var s = fmt.countdown(ms);
    if (seen[seen.length - 1] !== s) seen.push(s);
  }
  assert.equal(seen[0], "01:00");
  assert.equal(seen[seen.length - 1], "00:00");
  assert.equal(seen.length, 61);
});

test("stopwatch truncates: 00:05 means five whole seconds have passed", function () {
  assert.equal(fmt.stopwatch(0, true), "00:00.0");
  assert.equal(fmt.stopwatch(999, false), "00:00");
  assert.equal(fmt.stopwatch(5000, true), "00:05.0");
  assert.equal(fmt.stopwatch(5990, true), "00:05.9");
  assert.equal(fmt.stopwatch(65432, true), "01:05.4");
  assert.equal(fmt.stopwatch(3600000, true), "1:00:00.0");
  assert.equal(fmt.stopwatch(3661500, false), "1:01:01");
  assert.equal(fmt.stopwatch(-10, true), "00:00.0");
});

test("lap splits equal differences of the DISPLAYED totals", function () {
  /* The bug: both columns truncated independently, so consecutive totals could differ by
     0.5 s while the split between them insisted it was 0.4 s. swQuantise is what keeps the
     two columns reconciled — every split is computed from the same quantised numbers the
     user can read off the screen. */
  var raws = [1234, 4988, 4999, 5001, 9099, 12345, 60049, 60051, 123456];
  for (var i = 1; i < raws.length; i++) {
    var prev = fmt.swQuantise(raws[i - 1]);
    var cur = fmt.swQuantise(raws[i]);
    var totalPrev = fmt.stopwatch(prev, true);
    var totalCur = fmt.stopwatch(cur, true);
    var split = fmt.stopwatch(cur - prev, true);
    assert.equal(
      tenths(totalCur) - tenths(totalPrev), tenths(split),
      "split " + split + " does not reconcile " + totalPrev + " -> " + totalCur
    );
  }
});

test("swQuantise floors to the displayed tenth", function () {
  assert.equal(fmt.swQuantise(0), 0);
  assert.equal(fmt.swQuantise(99), 0);
  assert.equal(fmt.swQuantise(100), 100);
  assert.equal(fmt.swQuantise(4999), 4900);
  assert.equal(fmt.swQuantise(-5), 0);
});

/* mm:ss.t (or h:mm:ss.t) -> tenths, for the reconciliation check above */
function tenths(s) {
  var parts = s.split(":");
  var last = parts.pop().split(".");
  var t = Number(last[1] || 0);
  var total = Number(last[0]) * 10 + t;
  var mult = 600;
  while (parts.length) { total += Number(parts.pop()) * mult; mult *= 60; }
  return total;
}

test("pad2 pads and floors", function () {
  assert.equal(app.WP.pad2(0), "00");
  assert.equal(app.WP.pad2(7), "07");
  assert.equal(app.WP.pad2(59), "59");
  assert.equal(app.WP.pad2(7.9), "07");
});

test("deg / bytes / durations", function () {
  assert.equal(fmt.deg(null), "--°");
  assert.equal(fmt.deg(NaN), "--°");
  assert.equal(fmt.deg(71.5), "72°");
  assert.equal(fmt.deg1(71.44), "71.4°");

  assert.equal(fmt.bytes(null), "--");
  assert.equal(fmt.bytes(512), "512 B");
  assert.equal(fmt.bytes(1024), "1 KB");
  assert.equal(fmt.bytes(1536), "1.5 KB");
  assert.equal(fmt.bytes(1024 * 1024 * 1024 * 3), "3 GB");

  assert.equal(fmt.duration(65000), "1m 5s");
  assert.equal(fmt.duration(3665000), "1h 1m");
  assert.equal(fmt.duration(90000000), "1d 1h 0m");
  assert.equal(fmt.durationShort(59000), "59s");
  assert.equal(fmt.durationShort(60000), "1m");
  assert.equal(fmt.durationShort(3600000), "1h");
  assert.equal(fmt.durationShort(86400000), "1d");
});

test("compass covers all 16 points and wraps at 360", function () {
  assert.equal(fmt.compass(null), "--");
  assert.equal(fmt.compass(0), "N");
  assert.equal(fmt.compass(360), "N", "360 degrees must wrap back to N");
  assert.equal(fmt.compass(90), "E");
  assert.equal(fmt.compass(180), "S");
  assert.equal(fmt.compass(270), "W");
  assert.equal(fmt.compass(23), "NNE");
  assert.equal(fmt.compass(355), "N");
});

test("uv bands follow the WHO thresholds", function () {
  assert.equal(fmt.uv(null).n, "--");
  assert.equal(fmt.uv(0).label, "Low");
  assert.equal(fmt.uv(2.9).label, "Low");
  assert.equal(fmt.uv(3).label, "Moderate");
  assert.equal(fmt.uv(6).label, "High");
  assert.equal(fmt.uv(8).label, "Very high");
  assert.equal(fmt.uv(11).label, "Extreme");
  assert.equal(fmt.uv(5.44).n, 5.4);
});

test("unit-dependent formatters follow the setting", function () {
  S.data.units = "fahrenheit";
  assert.equal(fmt.speedUnit(), "mph");
  assert.equal(fmt.precipUnit(), "in");
  assert.equal(fmt.pressure(1013), "29.91 inHg");
  assert.equal(fmt.distance(1609), "1 mi");

  S.data.units = "celsius";
  assert.equal(fmt.speedUnit(), "km/h");
  assert.equal(fmt.precipUnit(), "mm");
  assert.equal(fmt.pressure(1013), "1013 hPa");
  assert.equal(fmt.distance(2500), "2.5 km");
  assert.equal(fmt.pressure(null), "--");
  assert.equal(fmt.distance(null), "--");
  S.data.units = "fahrenheit";
});

test("clock honours 12/24h and the seconds setting", function () {
  var noon = new Date(2025, 5, 10, 12, 5, 9);
  var midnight = new Date(2025, 5, 10, 0, 5, 9);
  var evening = new Date(2025, 5, 10, 23, 5, 9);

  S.data.clockHours = 12;
  assert.equal(fmt.clock(noon, false), "12:05 PM");
  assert.equal(fmt.clock(midnight, false), "12:05 AM", "midnight is 12 AM, not 0 AM");
  assert.equal(fmt.clock(evening, true), "11:05:09 PM");
  /* UPPER. Two of the three places that print an hour sit inside the small-caps label
     recipe, which upper-cases whatever it is handed, so a lowercase meridiem here produced
     "9P" on the home strip, "9p" in the hourly list and "12A" on the daily axis — one datum
     in two casings on adjacent screens. The formatter is the only place that can settle it. */
  assert.equal(fmt.hourLabel(evening), "11P");
  assert.equal(fmt.hourLabel(midnight), "12A");

  S.data.clockHours = 24;
  assert.equal(fmt.clock(noon, false), "12:05");
  assert.equal(fmt.clock(midnight, false), "00:05");
  assert.equal(fmt.clock(evening, true), "23:05:09");
  assert.equal(fmt.hourLabel(evening), "23:00");
  S.data.clockHours = 12;
});

test("ago rounds to the nearest minute and hour, it does not truncate", function () {
  /* Every existing case divided evenly (120000 ms is exactly 2 m), so floor and round agreed
     and the rounding was never actually asserted. It matters: ago() is what the weather
     status line says when the panel is offline, and a truncating version reports a reading
     as "1m ago" for 119 of every 120 seconds — an offline dashboard that keeps insisting its
     data is a minute newer than it is. */
  var now = app.clock.now;

  assert.equal(fmt.ago(now - 59000), "59s ago");      // still in seconds
  assert.equal(fmt.ago(now - 60000), "1m ago");
  assert.equal(fmt.ago(now - 100000), "2m ago");      // 1.67 m — floor would say 1m
  assert.equal(fmt.ago(now - 110000), "2m ago");
  assert.equal(fmt.ago(now - 3540000), "59m ago");    // 59 m, still minutes
  assert.equal(fmt.ago(now - 5400000), "2h ago");     // 1.5 h — floor would say 1h
  assert.equal(fmt.ago(now - 6900000), "2h ago");     // 1.92 h
  assert.equal(fmt.ago(now - 90000000), "25h ago");   // no day unit; it keeps counting hours
});

test("ago reads from the virtual clock", function () {
  var now = app.clock.now;
  assert.equal(fmt.ago(now - 5000), "5s ago");
  assert.equal(fmt.ago(now - 120000), "2m ago");
  assert.equal(fmt.ago(now - 7200000), "2h ago");
});
