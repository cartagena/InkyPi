/* Calendar arithmetic — the DST-unsafe day-of-year is the reason fmt.dayOfYear exists.

   The zone matters: under UTC the broken version passes, so this file pins a zone that
   actually observes DST before anything reads a Date. */

"use strict";

process.env.TZ = "America/Los_Angeles";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var app = h.createApp({});
var fmt = app.WP.fmt;

test("the test process really is in a DST zone", function () {
  /* If this ever fails the DST tests below are not testing anything. */
  assert.equal(new Date(2025, 0, 15).getTimezoneOffset(), 480, "January should be -08:00");
  assert.equal(new Date(2025, 6, 15).getTimezoneOffset(), 420, "July should be -07:00");
});

test("day-of-year is 1 on Jan 1 and counts every day of a non-leap year", function () {
  assert.equal(fmt.dayOfYear(new Date(2025, 0, 1)), 1);
  assert.equal(fmt.dayOfYear(new Date(2025, 11, 31)), 365);
});

test("day-of-year counts every day of a leap year", function () {
  assert.equal(fmt.dayOfYear(new Date(2024, 1, 29)), 60);
  assert.equal(fmt.dayOfYear(new Date(2024, 11, 31)), 366);
});

test("day-of-year is DST-safe across a full year (the 228-vs-229 bug)", function () {
  /* Walk every day of 2024 at midday and require a strict +1 each time. The old inline
     version measured from "now" back to Jan 0, so from the second Sunday of March onward
     the span was 23 h short of a whole number of days and floored one day low — wrong every
     single day between DST start and DST end, which is most of the year. */
  var expected = 1;
  for (var d = new Date(2024, 0, 1, 12, 0, 0); d.getFullYear() === 2024; d.setDate(d.getDate() + 1)) {
    assert.equal(fmt.dayOfYear(d), expected,
      "day-of-year wrong on " + d.toDateString());
    expected++;
  }
  assert.equal(expected - 1, 366);
});

test("day-of-year is stable at the DST boundary hours themselves", function () {
  /* 2024 spring-forward: 2024-03-10 02:00 local. Every hour of that day is day 70. */
  for (var hour = 0; hour < 24; hour++) {
    assert.equal(fmt.dayOfYear(new Date(2024, 2, 10, hour, 30)), 70,
      "spring-forward day at hour " + hour);
  }
  /* 2024 fall-back: 2024-11-03. Every hour of that day is day 308. */
  for (var hb = 0; hb < 24; hb++) {
    assert.equal(fmt.dayOfYear(new Date(2024, 10, 3, hb, 30)), 308,
      "fall-back day at hour " + hb);
  }
});

test("day-of-year does not depend on the time of day", function () {
  var early = fmt.dayOfYear(new Date(2024, 7, 16, 0, 0, 1));
  var late = fmt.dayOfYear(new Date(2024, 7, 16, 23, 59, 59));
  assert.equal(early, late);
  assert.equal(early, 229, "16 Aug 2024 is day 229 — the exact case that read 228");
});

test("ISO week matches the ISO-8601 definition at the awkward year ends", function () {
  /* 2024-12-30 (Mon) is already week 1 of 2025; 2021-01-01 (Fri) is week 53 of 2020. */
  assert.equal(fmt.isoWeek(new Date(2025, 0, 1)), 1);
  assert.equal(fmt.isoWeek(new Date(2024, 11, 30)), 1);
  assert.equal(fmt.isoWeek(new Date(2021, 0, 1)), 53);
  assert.equal(fmt.isoWeek(new Date(2024, 0, 4)), 1);
  assert.equal(fmt.isoWeek(new Date(2024, 0, 11)), 2);
  assert.equal(fmt.isoWeek(new Date(2024, 5, 10)), 24);
});

test("ISO week is DST-safe and constant within a day", function () {
  for (var hour = 0; hour < 24; hour++) {
    assert.equal(fmt.isoWeek(new Date(2024, 2, 10, hour, 30)), 10);
  }
});

test("the clock panel renders the same day-of-year the formatter computes", function () {
  /* Guards the wiring, not just the helper: the panel must actually call it. */
  app.clock.set(new Date(2024, 7, 16, 14, 0, 0).getTime());
  app.WP.panels.open("clock");
  var body = app.panelBody("clock");
  var keys = body.querySelectorAll(".stat-k").map(function (n) { return n.textContent; });
  var vals = body.querySelectorAll(".stat-v").map(function (n) { return n.textContent; });
  /* "Day", not "Day of year". A third of this panel is about nine characters wide at the
     re-scaled label tier; the eleven-character version wrapped to two lines and dropped its
     own value ~90 device px below the two beside it, so the TODAY row had three baselines.
     "of year" was the half the value already says — "229 of 366". */
  var i = keys.indexOf("Day");
  assert.ok(i >= 0, "clock panel has no day-of-year stat");
  /* CHANGED with the copy sweep: the cell is "229 of 366" rather than a bare "229". A
     day-of-year with no denominator is a number nobody can place, and the denominator is
     itself worth pinning — 2024 is a leap year, so a daysInYear() that ignored the leap
     rule would say 365 here. */
  assert.equal(vals[i], "229 of 366");
  /* A literal, like the day-of-year above it. Asserting against fmt.isoWeek(...) — the very
     function that produced the number on screen — only proved the panel called something;
     it agreed with itself no matter how wrong isoWeek got. 2024-08-16 is a Friday in ISO
     week 33 (that week runs Mon 12th to Sun 18th August 2024).
     The label lost the "ISO": the standard's name is for whoever implements the arithmetic,
     not for whoever reads the wall. And the VALUE lost the word "Week": a cell labelled
     WEEK whose value reads "Week 33" prints its own label inside itself, which happened in
     three places (also UPTIME → 22h 33m and CLOCK → 12-hour). */
  assert.equal(vals[keys.indexOf("Week")], "33");
  app.WP.panels.closeAll();
});
