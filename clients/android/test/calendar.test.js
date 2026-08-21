/* Calendar — InkyPi's calendar plugin on glass. The ICS parser and recurrence expander are
   pure (ics.js), so every shape a real feed emits is pinned here; then the widget around
   them: its honest states, the tile, the bridge fetch, the cache, and the agenda panel. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var fakeBridge = require("./lib/fake-bridge.js");

function b64utf8(s) { return Buffer.from(s, "utf8").toString("base64"); }
function local(y, m, d, hh, mi) { return new Date(y, m - 1, d, hh || 0, mi || 0).getTime(); }
function vcal(body) { return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + body + "END:VCALENDAR\r\n"; }
function vevent(lines) { return "BEGIN:VEVENT\r\n" + lines.join("\r\n") + "\r\nEND:VEVENT\r\n"; }

var app = h.createApp({});
var ics = app.WP.ics;

/* ---------------- lines and values ---------------- */

test("folded lines are unfolded and escaped text is restored", function () {
  var ev = ics.parse(vcal(vevent(["UID:x", "DTSTART:20250610T090000",
    "SUMMARY:A very long title that the exporter\r\n  folded onto a second line\\, with a comma\; and a semicolon"])));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, "A very long title that the exporter folded onto a second line, with a comma; and a semicolon");
});

test("a colon inside a quoted parameter is not the value separator", function () {
  var ev = ics.parse(vcal(vevent(["UID:x", "DTSTART:20250610T090000",
    'SUMMARY;ALTREP="http://example.com/a:b":Real title'])));
  assert.equal(ev[0].title, "Real title");
});

test("DATE, UTC, TZID and floating times each land on the right instant", function () {
  var d = ics.parseDate("20250610", { VALUE: "DATE" });
  assert.equal(d.allDay, true);
  assert.equal(d.ms, local(2025, 6, 10));
  var z = ics.parseDate("20250610T130000Z", {});
  assert.equal(z.ms, Date.UTC(2025, 5, 10, 13));
  var ny = ics.parseDate("20250610T090000", { TZID: "America/New_York" });   // EDT = UTC-4
  assert.equal(ny.ms, Date.UTC(2025, 5, 10, 13));
  var nyWinter = ics.parseDate("20250110T090000", { TZID: "America/New_York" });   // EST = UTC-5
  assert.equal(nyWinter.ms, Date.UTC(2025, 0, 10, 14));
  var fl = ics.parseDate("20250610T090000", {});
  assert.equal(fl.ms, local(2025, 6, 10, 9));
  var unknown = ics.parseDate("20250610T090000", { TZID: "Mars/Olympus_Mons" });
  assert.equal(unknown.ms, local(2025, 6, 10, 9), "an unknown zone degrades to floating");
  assert.equal(ics.parseDate("not a date", {}), null);
});

test("durations parse and an event with no end gets one", function () {
  assert.equal(ics.parseDuration("PT45M"), 45 * 60000);
  assert.equal(ics.parseDuration("P1DT2H30M"), 86400000 + 2.5 * 3600000);
  assert.equal(ics.parseDuration("P2W"), 14 * 86400000);
  assert.equal(ics.parseDuration("bogus"), null);
  var from = local(2025, 6, 1), to = local(2025, 7, 1);
  var timed = ics.expand(ics.parse(vcal(vevent(["UID:a", "DTSTART:20250610T090000", "DURATION:PT90M", "SUMMARY:T"]))), from, to)[0];
  assert.equal(timed.end - timed.start, 90 * 60000);
  var allDay = ics.expand(ics.parse(vcal(vevent(["UID:b", "DTSTART;VALUE=DATE:20250610", "SUMMARY:A"]))), from, to)[0];
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.end - allDay.start, 86400000);
});

test("cancelled events and events without a start are dropped", function () {
  var ev = ics.parse(vcal(vevent(["UID:a", "DTSTART:20250610T090000", "SUMMARY:Gone", "STATUS:CANCELLED"])
    + vevent(["UID:b", "SUMMARY:No start"])
    + vevent(["UID:c", "DTSTART:20250610T090000", "SUMMARY:Kept"])));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, "Kept");
});

/* ---------------- recurrence ---------------- */

function starts(body, from, to) {
  return ics.expand(ics.parse(vcal(body)), from, to).map(function (e) { return e.start; });
}

test("a daily rule with COUNT and an EXDATE", function () {
  var got = starts(vevent(["UID:a", "SUMMARY:D", "DTSTART:20250601T080000", "DTEND:20250601T083000",
    "RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20250603T080000"]), local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(JSON.stringify(got), JSON.stringify([local(2025, 6, 1, 8), local(2025, 6, 2, 8),
    local(2025, 6, 4, 8), local(2025, 6, 5, 8)]));   // COUNT counts the excluded one too
});

test("a weekly rule with BYDAY and UNTIL, and a bare weekly keeps DTSTART's weekday", function () {
  /* 2025-06-02 is a Monday */
  var got = starts(vevent(["UID:a", "SUMMARY:W", "DTSTART:20250602T090000", "DTEND:20250602T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20250612T000000Z"]), local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(JSON.stringify(got), JSON.stringify([local(2025, 6, 2, 9), local(2025, 6, 4, 9),
    local(2025, 6, 9, 9), local(2025, 6, 11, 9)]));
  var bare = starts(vevent(["UID:b", "SUMMARY:W", "DTSTART:20250604T090000",
    "RRULE:FREQ=WEEKLY;INTERVAL=2"]), local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(JSON.stringify(bare), JSON.stringify([local(2025, 6, 4, 9), local(2025, 6, 18, 9)]));
});

test("a weekly BYDAY rule starting mid-week does not emit the earlier day of its first week", function () {
  /* DTSTART Wednesday 2025-06-04, BYDAY=MO,WE: Monday the 2nd is before DTSTART and must not appear */
  var got = starts(vevent(["UID:a", "SUMMARY:W", "DTSTART:20250604T090000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3"]), local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(JSON.stringify(got), JSON.stringify([local(2025, 6, 4, 9), local(2025, 6, 9, 9), local(2025, 6, 11, 9)]));
});

test("monthly by day-of-month skips short months; monthly by ordinal weekday lands on it", function () {
  var dom = starts(vevent(["UID:a", "SUMMARY:M", "DTSTART:20250131T100000", "RRULE:FREQ=MONTHLY;COUNT=4"]),
    local(2025, 1, 1), local(2025, 6, 1));
  assert.equal(JSON.stringify(dom), JSON.stringify([local(2025, 1, 31, 10), local(2025, 3, 31, 10), local(2025, 5, 31, 10)]));
  /* second Tuesday: 2025-06-10, 2025-07-08 */
  var nth = starts(vevent(["UID:b", "SUMMARY:M", "DTSTART:20250610T190000", "RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=2"]),
    local(2025, 6, 1), local(2025, 8, 1));
  assert.equal(JSON.stringify(nth), JSON.stringify([local(2025, 6, 10, 19), local(2025, 7, 8, 19)]));
  /* last Friday: 2025-06-27 */
  var last = starts(vevent(["UID:c", "SUMMARY:M", "DTSTART:20250627T190000", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=1"]),
    local(2025, 6, 1), local(2025, 8, 1));
  assert.equal(JSON.stringify(last), JSON.stringify([local(2025, 6, 27, 19)]));
});

test("a yearly rule, and a window that starts after the first occurrence", function () {
  var got = starts(vevent(["UID:a", "SUMMARY:Y", "DTSTART;VALUE=DATE:20200704", "RRULE:FREQ=YEARLY"]),
    local(2025, 1, 1), local(2026, 12, 31));
  assert.equal(JSON.stringify(got), JSON.stringify([local(2025, 7, 4), local(2026, 7, 4)]));
});

test("a recurring event in a time zone keeps its wall-clock hour across a DST change", function () {
  /* 9:00 New York weekly from 2025-10-27 (EDT) through 2025-11-10 (EST) */
  var got = starts(vevent(["UID:a", "SUMMARY:Z", "DTSTART;TZID=America/New_York:20251027T090000",
    "RRULE:FREQ=WEEKLY;COUNT=3"]), Date.UTC(2025, 9, 1), Date.UTC(2025, 11, 1));
  assert.equal(JSON.stringify(got), JSON.stringify([Date.UTC(2025, 9, 27, 13), Date.UTC(2025, 10, 3, 14), Date.UTC(2025, 10, 10, 14)]));
});

test("a RECURRENCE-ID override replaces the instance it names", function () {
  var body = vevent(["UID:a", "SUMMARY:Standup", "DTSTART:20250602T090000", "DTEND:20250602T091500", "RRULE:FREQ=DAILY;COUNT=3"])
    + vevent(["UID:a", "RECURRENCE-ID:20250603T090000", "SUMMARY:Standup (moved)", "DTSTART:20250603T110000", "DTEND:20250603T111500"]);
  var got = ics.expand(ics.parse(vcal(body)), local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(JSON.stringify(got.map(function (e) { return [e.title, e.start]; })), JSON.stringify([
    ["Standup", local(2025, 6, 2, 9)], ["Standup (moved)", local(2025, 6, 3, 11)], ["Standup", local(2025, 6, 4, 9)]]));
});

test("a malformed rule cannot spin: an unsupported FREQ yields the first instance only", function () {
  var got = starts(vevent(["UID:a", "SUMMARY:H", "DTSTART:20250602T090000", "RRULE:FREQ=HOURLY"]),
    local(2025, 6, 1), local(2025, 7, 1));
  assert.equal(got.length, 1);
});

/* ---------------- the widget ---------------- */

test("unconfigured: hidden by default, and honest when switched on", function () {
  var a = h.createApp({});
  assert.equal(a.WP.settings.get("show").calendar, false);
  assert.equal(a.text("cal-sub"), "Not set up");
  a.WP.panels.open("calendar");
  /* CHANGED with the illustrated empty state: the panel's three no-agenda cases were a
     line of grey type over ~900 device px of black, and now each is a drawing of a month
     page with the state named under it. The words moved; the promise did not. */
  assert.match(a.panelBody("calendar").textContent, /No calendar yet/);
  assert.match(a.panelBody("calendar").innerHTML, /pic-art/, "the empty state lost its picture");
  assert.doesNotMatch(a.panelBody("calendar").textContent, /config\.js|https?:/);
});

function configured(extra) {
  var cfg = h.defaultConfig();
  cfg.calendar = { urls: ["https://cal.example/basic.ics"], days: 7 };
  return Object.assign({ config: cfg, now: local(2025, 6, 10, 9, 30) }, extra || {});
}

test("configured, no shell: says it needs the tablet instead of failing", function () {
  var a = h.createApp(configured());
  assert.equal(a.WP.settings.get("show").calendar, true);
  assert.equal(a.text("cal-sub"), "Needs the tablet");
});

test("the feed origin is on the shell allowlist and the feed is fetched at boot", function () {
  var bridge = fakeBridge.make({ net: true });
  var a = h.createApp(configured({ bridge: bridge }));
  assert.ok(bridge.lockedOrigins.some(function (o) { return o === "https://cal.example"; }),
    "feed origin missing from allowlist");
  var call = bridge.fetchCalls.filter(function (c) { return c.url === "https://cal.example/basic.ics"; })[0];
  assert.ok(call, "the feed was never requested");
  assert.match(call.headers.Accept, /text\/calendar/);
});

function deliver(a, bridge, icsText) {
  var call = bridge.fetchCalls.filter(function (c) { return /basic\.ics/.test(c.url); }).pop();
  a.WP.bridgeFetch._resolve(call.id, 200, b64utf8(icsText));
  return new Promise(function (r) { setImmediate(r); });
}

test("the tile shows the next event's time and name; today needs no day name", async function () {
  var bridge = fakeBridge.make({ net: true });
  var a = h.createApp(configured({ bridge: bridge }));
  await deliver(a, bridge, vcal(
    vevent(["UID:1", "SUMMARY:Dentist", "DTSTART:20250610T143000", "DTEND:20250610T153000", "LOCATION:Clinic"])
    + vevent(["UID:2", "SUMMARY:Earlier today, over", "DTSTART:20250610T080000", "DTEND:20250610T090000"])
    + vevent(["UID:3", "SUMMARY:Bins", "DTSTART;VALUE=DATE:20250612", "DTEND;VALUE=DATE:20250613"])));
  assert.equal(a.text("cal-big"), "2:30 PM");
  assert.equal(a.text("cal-sub"), "Dentist");
  /* 24-hour clock flips the tile's value on the tick */
  a.WP.settings.set("clockHours", 24);
  a.registry.calendar.renderCard();
  assert.equal(a.text("cal-big"), "14:30");
  /* and once the dentist is over, the all-day event two days out takes the tile */
  a.clock.set(local(2025, 6, 10, 16));
  a.registry.calendar.renderCard();
  assert.equal(a.text("cal-big"), "All day");
  assert.equal(a.text("cal-sub"), "Bins · Thu");
});

test("the panel groups the agenda by day, drops what is over, and says when there is nothing", async function () {
  var bridge = fakeBridge.make({ net: true });
  var a = h.createApp(configured({ bridge: bridge }));
  await deliver(a, bridge, vcal(
    vevent(["UID:1", "SUMMARY:Dentist", "DTSTART:20250610T143000", "DTEND:20250610T153000", "LOCATION:Clinic"])
    + vevent(["UID:2", "SUMMARY:Over already", "DTSTART:20250610T080000", "DTEND:20250610T090000"])
    + vevent(["UID:3", "SUMMARY:Bins", "DTSTART;VALUE=DATE:20250612", "DTEND;VALUE=DATE:20250613"])
    + vevent(["UID:4", "SUMMARY:Far away", "DTSTART:20250701T090000"])));
  a.WP.panels.open("calendar");
  var t = a.panelBody("calendar").textContent;
  assert.match(t, /Today/);
  assert.match(t, /Dentist/);
  assert.match(t, /2:30 – 3:30 PM · Clinic/);
  assert.match(t, /Thursday, Jun 12/);
  assert.match(t, /All day/);
  assert.doesNotMatch(t, /Over already/);
  assert.doesNotMatch(t, /Far away/);
  assert.match(a.qs('[data-panel="calendar"] [data-sub]').textContent, /Next 7 days · 3 events/);
  a.WP.panels.close();

  var b = h.createApp(configured({ bridge: fakeBridge.make({ net: true }) }));
  var bb = b.registry.calendar; bb.events = []; bb.fetchedAt = 1;
  b.WP.panels.open("calendar");
  assert.match(b.panelBody("calendar").textContent, /Nothing scheduled/);
  assert.match(b.panelBody("calendar").textContent, /next 7 days are clear/);
  assert.match(b.panelBody("calendar").innerHTML, /pic-art/, "an empty week lost its picture");
  assert.equal(b.text("cal-sub"), "Nothing for 7 days");
});

test("a feed that is down keeps the cached agenda, marked as of when", async function () {
  var bridge = fakeBridge.make({ net: true });
  var a = h.createApp(configured({ bridge: bridge }));
  await deliver(a, bridge, vcal(vevent(["UID:1", "SUMMARY:Dentist", "DTSTART:20250610T143000", "DTEND:20250610T153000"])));
  var cached = JSON.parse(a.storage.getItem("inky.cal.v1"));
  assert.equal(cached.events.length, 1, "the fetched feed was not cached");
  /* a fresh boot from cache, whose fetch then fails */
  var bridge2 = fakeBridge.make({ net: true });
  var b = h.createApp(configured({ bridge: bridge2, storage: { "inky.cal.v1": JSON.stringify(cached) } }));
  assert.equal(b.text("cal-sub"), "Dentist", "the cache did not paint the tile at boot");
  var call = bridge2.fetchCalls.filter(function (c) { return /basic\.ics/.test(c.url); }).pop();
  b.WP.bridgeFetch._resolve(call.id, 503, b64utf8("down"));
  await new Promise(function (r) { setImmediate(r); });
  assert.equal(b.registry.calendar.stale, true);
  b.WP.panels.open("calendar");
  assert.match(b.qs('[data-panel="calendar"] [data-sub]').textContent, /as of/);
  assert.match(b.panelBody("calendar").textContent, /Dentist/);
});

test("the settings tile does not count an unconfigured Calendar as switched off", function () {
  var a = h.createApp({});
  assert.equal(a.text("set-sub"), "12-hour");
  a.WP.settings.setShow("moon", false);
  assert.equal(a.text("set-sub"), "1 hidden");
});
