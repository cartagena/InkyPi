/* Year progress and countdowns — InkyPi's year_progress and countdown plugins on glass.
   The arithmetic is calendar arithmetic (midnight to midnight, local), so every boundary
   that has bitten a date calculation before is pinned: New Year's Day, New Year's Eve,
   leap years, month ends, and the DST-shift days that broke fmt.dayOfYear once. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var app = h.createApp({});
var year = app.registry.year;

function local(y, m, d, hh) { return new Date(y, m - 1, d, hh || 12).getTime(); }

/* ---------------- calc ---------------- */

test("New Year's Day is 0% gone with a full year left; New Year's Eve is 100% with one day", function () {
  var jan1 = year.calc(local(2025, 1, 1));
  assert.equal(jan1.year, 2025);
  assert.equal(jan1.pct, 0);
  assert.equal(jan1.daysLeft, 365);
  var dec31 = year.calc(local(2025, 12, 31, 23));
  assert.equal(dec31.pct, 100);
  assert.equal(dec31.daysLeft, 1);
});

test("a leap year has 366 days left on Jan 1 and the server's rounding on any day", function () {
  assert.equal(year.calc(local(2028, 1, 1)).daysLeft, 366);
  /* 2028-07-01: 182 days gone of 366 = 49.7% -> 50, 184 left */
  var mid = year.calc(local(2028, 7, 1));
  assert.equal(mid.pct, 50);
  assert.equal(mid.daysLeft, 184);
});

test("the DST-shift days do not lose or gain a day", function () {
  /* 2025-03-09 and 2025-11-02 are the US changes; the value must equal the plain
     calendar count either side of them, not drift by a 23- or 25-hour day. */
  var before = year.calc(local(2025, 3, 8)), after = year.calc(local(2025, 3, 10));
  assert.equal(before.daysLeft - after.daysLeft, 2);
  var b2 = year.calc(local(2025, 11, 1)), a2 = year.calc(local(2025, 11, 3));
  assert.equal(b2.daysLeft - a2.daysLeft, 2);
});

test("month and quarter progress know their own lengths", function () {
  var feb = year.calc(local(2025, 2, 15));
  assert.equal(feb.monthDaysLeft, 14);                 // 28-day month, 14 gone
  assert.equal(feb.monthPct, 50);
  assert.equal(feb.monthEnd.getDate(), 28);
  assert.equal(feb.quarter, 1);
  var leapFeb = year.calc(local(2028, 2, 29));
  assert.equal(leapFeb.monthDaysLeft, 1);
  assert.equal(leapFeb.monthEnd.getDate(), 29);
  var q4 = year.calc(local(2025, 10, 1));
  assert.equal(q4.quarter, 4);
  assert.equal(q4.quarterPct, 0);
  assert.equal(q4.quarterDaysLeft, 92);                // Oct + Nov + Dec
  var lastDay = year.calc(local(2025, 12, 31));
  assert.equal(lastDay.quarterDaysLeft, 1);
});

/* ---------------- countdowns ---------------- */

test("countdowns are read as local dates, counted in whole days, and sorted soonest first", function () {
  var now = local(2025, 6, 10, 9);
  var list = year.countdowns([
    { title: "Later", date: "2025-07-01" },
    { title: "Soon", date: "2025-06-12" },
    { title: "Tomorrow", date: "2025-06-11" },
    { title: "Today", date: "2025-06-10" }
  ], now);
  /* JSON, not deepEqual: the list is built inside the app's sandbox, so its arrays have
     another realm's prototype and strict deepEqual refuses them on that alone. */
  assert.equal(JSON.stringify(list.map(function (c) { return [c.title, c.days, c.label]; })),
    JSON.stringify([["Today", 0, "left"], ["Tomorrow", 1, "left"], ["Soon", 2, "left"],
                    ["Later", 21, "left"]]));
});

test("past dates go to the end, count days ago, and say so", function () {
  var now = local(2025, 6, 10);
  var list = year.countdowns([
    { title: "Gone", date: "2025-06-01" },
    { title: "Ahead", date: "2025-12-25" }
  ], now);
  assert.equal(list[0].title, "Ahead");
  assert.equal(list[1].title, "Gone");
  assert.equal(list[1].days, -9);
  assert.equal(list[1].label, "ago");
});

test("junk rows are dropped and a missing title gets the plugin's fallback", function () {
  var now = local(2025, 6, 10);
  var list = year.countdowns([
    null, {}, { title: "No date" }, { title: "Bad", date: "12/25/2025" },
    { title: "Impossible", date: "2025-02-30" },
    { date: "2025-06-20" }, { title: "  ", date: "2025-06-21" }
  ], now);
  assert.equal(JSON.stringify(list.map(function (c) { return c.title; })), '["Countdown","Countdown"]');
  assert.equal(year.countdowns(undefined, now).length, 0);
  assert.equal(year.countdowns("2025-06-20", now).length, 0);
});

test("the tile's words for a distance", function () {
  assert.equal(year.when(0), "today");
  assert.equal(year.when(1), "tomorrow");
  assert.equal(year.when(-1), "yesterday");
  assert.equal(year.when(12), "in 12 days");
  assert.equal(year.when(-3), "3 days ago");
});

/* ---------------- tile and panel ---------------- */

test("the tile shows the percentage and, with no countdowns, the days left", function () {
  var a = h.createApp({ now: local(2025, 7, 2) });   // 182 gone of 365 -> 50%, 183 left
  assert.equal(a.text("year-big"), "50%");
  assert.equal(a.text("year-sub"), "183 days left");
});

test("the nearest upcoming countdown takes the tile's sub-line", function () {
  var cfg = h.defaultConfig();
  cfg.countdowns = [{ title: "Vacation", date: "2025-07-14" }, { title: "Past", date: "2025-01-01" }];
  var a = h.createApp({ now: local(2025, 7, 2), config: cfg });
  assert.equal(a.text("year-sub"), "Vacation in 12 days");
});

test("the panel lists countdowns, or says honestly that there are none", function () {
  var a = h.createApp({ now: local(2025, 7, 2) });
  a.WP.panels.open("year");
  var body = a.panelBody("year").textContent;
  assert.match(body, /50%/);
  assert.match(body, /of 2025 gone/);
  assert.match(body, /No countdowns yet/);
  assert.match(a.qs('[data-panel="year"] [data-sub]').textContent, /183 days left in 2025/);
  a.WP.panels.close();

  var cfg = h.defaultConfig();
  cfg.countdowns = [{ title: "Vacation", date: "2025-07-14" }];
  var b = h.createApp({ now: local(2025, 7, 2), config: cfg });
  b.WP.panels.open("year");
  var t = b.panelBody("year").textContent;
  assert.match(t, /Vacation/);
  assert.match(t, /12\s*days/);
  assert.doesNotMatch(t, /No countdowns/);
});
