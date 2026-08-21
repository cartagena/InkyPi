/* Weather: the hour index every card reads from, and the rollover refetch that keeps the
   Now card and the hourly strip sourced from ONE payload. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var wx = require("./lib/wx-fixture.js");

function at(y, mo, d, hh, mm) { return new Date(y, mo, d, hh, mm || 0, 0, 0).getTime(); }

/* ---------------- nowIndex ---------------- */

test("nowIndex finds the hour we are inside", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now });
  var w = app.registry.weather;
  w.data = wx.build({ now: now });
  assert.equal(w.nowIndex(), 9, "09:30 is inside the 09:00 bucket");
});

test("nowIndex is inclusive of the start of the hour and exclusive of the next", function () {
  var day = [2025, 5, 10];
  var app = h.createApp({ now: at(day[0], day[1], day[2], 9, 0) });
  var w = app.registry.weather;
  w.data = wx.build({ now: at(day[0], day[1], day[2], 9, 0) });

  app.clock.set(at(day[0], day[1], day[2], 9, 0));
  assert.equal(w.nowIndex(), 9, "exactly on the hour belongs to that hour");

  app.clock.set(at(day[0], day[1], day[2], 9, 0) + 3599999);
  assert.equal(w.nowIndex(), 9, "one ms before the next hour is still this hour");

  app.clock.set(at(day[0], day[1], day[2], 10, 0));
  assert.equal(w.nowIndex(), 10, "the next hour starts the next bucket");

  app.clock.set(at(day[0], day[1], day[2], 9, 0) - 1);
  assert.equal(w.nowIndex(), 8);
});

test("nowIndex returns -1 when there is no data at all", function () {
  var app = h.createApp({});
  var w = app.registry.weather;
  w.data = null;
  assert.equal(w.nowIndex(), -1);
  w.data = {};
  assert.equal(w.nowIndex(), -1, "a payload with no hourly block");
  w.data = { hourly: {} };
  assert.equal(w.nowIndex(), -1, "an hourly block with no time array");
  w.data = { hourly: { time: [] } };
  assert.equal(w.nowIndex(), 0, "an empty time array falls back to the first slot");
});

test("nowIndex falls back to 0 when now is off the end of the array", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now });
  var w = app.registry.weather;
  w.data = wx.build({ now: now, hours: 6 });        // array ends at 05:00
  assert.equal(w.nowIndex(), 0, "a stale payload must still index somewhere valid");

  app.clock.set(at(2020, 0, 1, 0, 0));               // long before the array starts
  assert.equal(w.nowIndex(), 0);
});

test("the 24-hour strip window starts at the current hour and never runs off the end", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now });
  app.registry.weather.data = wx.build({ now: now });
  var win = app.own(app.registry.hourly.window24());
  assert.equal(win.length, 24);
  assert.equal(win[0], 9);
  assert.equal(win[23], 32);

  app.registry.weather.data = wx.build({ now: now, hours: 14 });
  var short = app.own(app.registry.hourly.window24());
  assert.equal(short.length, 5, "a 14-hour payload at 09:30 leaves five hours");
  assert.equal(short[short.length - 1], 13);
});

/* ---------------- the Now / NOW desync ----------------

   Two causes, both live at once, and only the first was ever fixed:

     1. STALENESS. The strip re-anchors on the hour off its own 15 s tick while the card
        waited for the next scheduled fetch, so for up to 15 minutes the card held the
        previous hour. Fixed by checkRollover(), covered below.
     2. SOURCE OF TRUTH. Open-Meteo's `current` is interpolated to the minute; hourly[i] is
        the top of the hour. They legitimately differ, so no refetch cadence can reconcile
        a card fed from one with a strip fed from the other. Fixed by making hourly[] the
        panel's single source — see the block comment on weather.nowReading().

   The old test could only ever see (1), because the fixture handed `current` the hourly
   bucket's own value. wx-fixture now skews them apart the way the API does. */

/* The fixture's premise, asserted rather than assumed. If somebody ever pins `current`
   back to its hourly bucket, every agreement test below becomes a tautology again and
   this is the line that says so. */
test("the fixture's `current` block really does disagree with its hourly bucket", function () {
  var now = at(2025, 5, 10, 9, 30);
  var d = wx.build({ now: now });
  assert.notEqual(d.current.temperature_2m, d.hourly.temperature_2m[9],
    "current === hourly[now] makes every Now/NOW assertion unfalsifiable");
  assert.notEqual(d.current.apparent_temperature, d.hourly.apparent_temperature[9]);
  assert.equal(d.current.temperature_2m, wx.tempAt(9) + wx.CURRENT_SKEW);
});

test("REGRESSION: every 'now' number on the wall is drawn from hourly[nowIndex]", function () {
  /* The invariant, stated as a value and not as an equality between two readouts: the
     card, the strip chip, the panel hero and both "feels" readouts must all be the HOURLY
     bucket. Asserting only card===chip would still pass if both were switched to
     `current`; asserting the value is what pins the decision. */
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: wx.serve() });

  return app.flush().then(function () {
    var hourly = wx.tempAt(9) + "°", feels = wx.feelsAt(9) + "°";
    var interpolated = (wx.tempAt(9) + wx.CURRENT_SKEW) + "°";
    assert.notEqual(hourly, interpolated, "the fixture stopped skewing the two apart");

    assert.equal(app.text("wx-temp"), hourly, "the Now card is reading `current`");
    assert.equal(nowChip(app), hourly, "the NOW chip is not the hourly bucket");
    assert.equal(quick(app, "Feels"), feels, "the card's Feels is reading `current`");

    /* the Conditions panel is the magnification of that card */
    app.WP.panels.open("weather");
    var body = app.panelBody("weather");
    assert.equal(body.querySelector(".big-time").textContent, hourly);
    assert.match(body.querySelector(".big-sub").textContent, /feels 67°$/);
    assert.equal(body.querySelector(".big-sub").textContent.slice(-feels.length), feels,
      "the panel's feels-like is reading `current`");
    app.WP.panels.close();

    /* and the hourly panel says the same number for the same hour. It says it in the
       SELECTED ROW now, not in a hero: the hero was `72° / Clear · feels 77°`, which is
       character-for-character the block Conditions opens with, which is itself the third
       printing of the home Now card — two adjacent carousel screens that were half the
       same screen. The invariant this test exists for is unchanged: whatever the hourly
       panel prints for the current hour is the HOURLY bucket, not `current`. */
    app.WP.panels.open("hourly");
    var hb = app.panelBody("hourly");
    assert.equal(hb.querySelector(".hrow.sel .hrow-d").textContent, hourly);
    assert.equal(app.qsa(".big-time", hb).length, 0,
      "the hourly panel opens on a hero again — that is Conditions' screen");
    app.WP.panels.close();
  });
});

test("REGRESSION: the Now card and the NOW chip agree across an hour rollover", function () {
  /* Cause (1). Observed live: "65°" on the Now card beside "NOW 66°" in the strip. */
  var start = at(2025, 5, 10, 6, 59, 30) + 30000;   // 06:59:30
  var app = h.createApp({ now: start, fetch: wx.serve() });

  return app.flush().then(function () {
    var card = app.text("wx-temp");
    var chip = nowChip(app);
    assert.equal(card, chip, "card and strip disagreed before the rollover");
    assert.equal(card, wx.tempAt(6) + "°");

    app.advance(60000);                              // cross into 07:00
    return app.flush().then(function () {
      assert.equal(nowChip(app), wx.tempAt(7) + "°", "the strip did not re-anchor");
      assert.equal(app.text("wx-temp"), nowChip(app),
        "the Now card is still showing the previous hour's temperature");
      assert.equal(quick(app, "Feels"), wx.feelsAt(7) + "°",
        "the feels-like readout did not follow the rollover");
    });
  });
});

test("an offline panel still agrees with itself", function () {
  /* The case a refetch cannot reach at all: no network, a cached payload from an hour ago,
     so `current` is an hour old while hourly[] still covers the hour we are inside. This
     is where sourcing the card from `current` was guaranteed to disagree with the strip,
     every time, for as long as the wifi stayed down. */
  var now = at(2025, 5, 10, 9, 30);
  var cached = { t: now - 3600000, u: "fahrenheit", d: wx.build({ now: now - 3600000 }) };
  var app = h.createApp({ now: now, storage: { "inky.wx.v2": JSON.stringify(cached) } });
  return app.flush().then(function () {
    assert.equal(app.$("wx-badge").hidden, false, "an offline panel must badge its data");
    assert.equal(app.text("wx-temp"), nowChip(app));
    assert.equal(app.text("wx-temp"), wx.tempAt(9) + "°",
      "the hour we are inside, from the payload we have");
  });
});

function nowChip(app) {
  var chip = app.qs("#hourly .hr.now");
  assert.ok(chip, "the strip has no NOW chip");
  assert.equal(chip.querySelector(".hr-t").textContent, "Now");
  return chip.querySelector(".hr-d").textContent;
}

/* the value beside a key in the home card's three-line quick block */
function quick(app, key) {
  var hit = app.qsa("#wx-quick .wxq").filter(function (n) {
    return n.querySelector(".wxq-k").textContent === key;
  })[0];
  assert.ok(hit, "the Now card has no " + key + " readout");
  return hit.querySelector(".wxq-v").textContent;
}

test("checkRollover refetches once per hour and never on the boot pass", function () {
  var app = h.createApp({ now: at(2025, 5, 10, 6, 30) });
  var w = app.registry.weather;
  var fetched = 0;
  w.fetch = function () { fetched++; };

  w.fetchedAt = 0;
  w.lastHour = -1;
  assert.equal(w.checkRollover(), false, "the boot pass must not double-fetch");
  assert.equal(fetched, 0);
  assert.equal(w.lastHour, 6, "it still records which hour we are in");

  w.fetchedAt = app.clock.now;
  assert.equal(w.checkRollover(), false, "same hour, nothing to do");
  assert.equal(fetched, 0);

  app.clock.set(at(2025, 5, 10, 7, 0));
  assert.equal(w.checkRollover(), true);
  assert.equal(fetched, 1);
  assert.equal(w.checkRollover(), false, "one refetch per rollover, not one per tick");
  assert.equal(fetched, 1);

  app.clock.set(at(2025, 5, 10, 8, 15));
  assert.equal(w.checkRollover(), true);
  assert.equal(fetched, 2);
});

test("the rollover tick is actually wired to a timer", function () {
  /* checkRollover being right is worth nothing if nothing calls it. */
  var app = h.createApp({ now: at(2025, 5, 10, 6, 59, 50) + 50000, fetch: wx.serve() });
  return app.flush().then(function () {
    var before = app.fetches.length;
    app.advance(20000);                              // crosses 07:00, one 15 s tick
    assert.ok(app.fetches.length > before, "crossing the hour did not trigger a refetch");
  });
});

/* ---------------- rendering from a payload ---------------- */

test("a live payload fills the Now card, the strip and the daily row", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: wx.serve() });
  return app.flush().then(function () {
    assert.equal(app.text("wx-temp"), wx.tempAt(9) + "°");
    assert.equal(app.$("wx-badge").hidden, true, "fresh data is not stale");
    assert.equal(app.qsa("#hourly .hr").length, 24);
    assert.equal(app.qsa("#forecast .fc-day").length, 7, "all seven days the API returns");
    assert.equal(app.qs("#forecast .fc-name").textContent, "Today");
    /* SILENT. The line used to read "Updated 9:30 AM" directly under a clock card reading
       9:30 AM — the same glyphs, twice, on the screen's top two rows. A status line speaks
       when something is wrong; a fresh reading has nothing to add that the clock has not
       already said. The stale path below is what this row is for and it is unchanged. */
    assert.equal(app.text("status"), "", "the status line restates the clock again");
  });
});

test("a failed fetch keeps the last reading on screen and badges it", function () {
  var now = at(2025, 5, 10, 9, 30);
  var cached = { t: now - 3600000, u: "fahrenheit", d: wx.build({ now: now - 3600000 }) };
  var app = h.createApp({
    now: now,
    storage: { "inky.wx.v2": JSON.stringify(cached) }
  });
  return app.flush().then(function () {
    assert.equal(app.$("wx-badge").hidden, false, "an offline panel must badge its data");
    /* CHANGED with the source-of-truth decision (see nowReading): this used to assert
       tempAt(8) — the hour the cached payload was FETCHED in, because the card read
       `current`. That is precisely the desync: the strip's NOW chip was already showing
       hourly[9] beside it. The cached payload covers hour 9 too, so the card now shows
       hour 9 and the two agree. The stale badge is what says the data is old; two
       different temperatures for one instant is not. */
    assert.equal(app.text("wx-temp"), wx.tempAt(9) + "°", "the cached reading stays up");
    assert.match(app.text("status"), /Offline/);
    assert.deepEqual(app.logs.error, []);
  });
});

test("with no data at all the card says so instead of going blank", function () {
  var app = h.createApp({});
  return app.flush().then(function () {
    assert.match(app.text("status"), /Weather unavailable/);
    assert.equal(app.qs("#hourly").textContent, "waiting for forecast…");
  });
});

test("no location configured disables weather with an explicit message", function () {
  var cfg = h.defaultConfig();
  cfg.location = { name: "", latitude: null, longitude: null };
  var app = h.createApp({ config: cfg });
  assert.equal(app.text("wx-desc"), "No location set");
  assert.match(app.text("status"), /no location set/);
  assert.equal(app.fetches.length, 0, "must not call Open-Meteo without coordinates");
});

test("the request asks Open-Meteo for the units the panel is set to", function () {
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    var url = app.fetches[0].url;
    assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    assert.match(url, /temperature_unit=fahrenheit/);
    assert.match(url, /wind_speed_unit=mph/);
    assert.match(url, /precipitation_unit=inch/);
    assert.match(url, /timezone=auto/);
    assert.equal(/[?&]key=|token/.test(url), false, "no API key should ever be in the URL");

    app.WP.settings.set("units", "celsius");
    return app.flush().then(function () {
      var last = app.fetches[app.fetches.length - 1].url;
      assert.match(last, /temperature_unit=celsius/);
      assert.match(last, /wind_speed_unit=kmh/);
      assert.match(last, /precipitation_unit=mm/);
    });
  });
});

test("switching to 24-hour redraws the strip and the status line immediately", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: wx.serve() });
  return app.flush().then(function () {
    var labels = app.qsa("#hourly .hr-t").map(function (n) { return n.textContent; });
    assert.equal(labels[1], "10A");   /* one casing everywhere — see fmt.hourLabel */
    app.WP.settings.set("clockHours", 24);
    var after = app.qsa("#hourly .hr-t").map(function (n) { return n.textContent; });
    assert.equal(after[0], "Now");
    assert.equal(after[1], "10:00", "the strip kept 12-hour labels under a 24-hour clock");
  });
});

test("the hourly panel opens on the hour that was tapped", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: wx.serve() });
  return app.flush().then(function () {
    var chips = app.qsa("#hourly .hr");
    app.tap(chips[3]);                                 // four hours from now = 12:00
    assert.deepEqual(app.stack(), ["hourly"]);
    assert.equal(app.registry.hourly.sel, 12);
    var body = app.panelBody("hourly");
    /* the tapped hour is the SELECTED ROW; this panel has no hero (see the note in
       paintPanel — it was Conditions' hero, printed a third time) */
    assert.equal(body.querySelector(".hrow.sel .hrow-d").textContent, wx.tempAt(12) + "°");
    /* SEVEN rows, not 24. The list is windowed to what the panel can actually show: all
       24 went into a scrollport that fits about four of them, so the panel always ended on
       a row sliced in half and nineteen of the rows were below a fold nobody on a wall
       panel ever scrolls past. The 24-hour shape is the chart above.

       It was eight until the type ramp was re-scaled for 3 m — a row's temperature is a
       VALUE and moved to the value tier, which made every row taller and put the eighth
       one 21 px off the bottom of the frame (measured on the device). Fewer rows at a size
       that reads beats more rows nobody can. What this test is really about is unchanged
       and is the line below it: the hour you tapped is in the list and it is selected. */
    /* FIVE. Eight, then six, then five, and every step is the same arithmetic rather than a
       preference: a row cannot be shorter than the value it holds (91 CSS px once the
       temperature is at the value tier), and the panel has ~490 px under a chart whose axis
       is annotated at a size somebody 3 m away can read. */
    assert.equal(app.qsa(".hrow", body).length, 5);
    assert.equal(app.qsa(".hrow.sel", body).length, 1);
  });
});

test("the daily panel opens on the day that was tapped", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: wx.serve() });
  return app.flush().then(function () {
    app.tap(app.qsa("#forecast .fc-day")[2]);
    assert.deepEqual(app.stack(), ["daily"]);
    assert.equal(app.registry.daily.sel, 2);
    var body = app.panelBody("daily");
    assert.match(body.querySelector(".big-time").textContent, /^80°/);
    assert.equal(app.qsa(".chip.on", body).length, 1);

    /* THREE cells, one row, down from nine. RAIN CHANCE 0% beside PRECIP TOTAL 0 in was
       two cells to say nothing on a dry day — the zero suppression the other three panels
       got never reached this one — DAYLIGHT was sunset minus sunrise printed between sunset
       and sunrise, the two clock times moved onto the hero's own line where they read as
       the shape of the day, and the two "feels" figures are one fact with two ends exactly
       like the 93° / 65° above them. A stat row costs ~2vh more now that its value is sized
       to be read from 3 m; this is what that was paid for with. */
    assert.deepEqual(app.qsa(".psec .stat-k", body).map(function (n) { return n.textContent; }),
      ["Feels", "Max wind", "UV max"]);
    /* the two clock times that used to be two grid cells, on the day's own line */
    assert.equal(body.querySelector(".big-sub").textContent,
      "Light rain · 5:42 AM – 8:12 PM");
    var rain = app.qsa(".psec", body).filter(function (sec) {
      return sec.querySelector(".psec-t").textContent === "Rain";
    })[0];
    assert.ok(rain, "the daily panel no longer answers whether it will rain");
    /* the fixture's day 2 is a 26% chance with nothing measurable behind it — which is
       exactly the case the two old cells rendered as "RAIN CHANCE 26%" over "PRECIP TOTAL
       0 in", a figure and its own contradiction side by side */
    assert.equal(rain.querySelector(".muted").textContent,
      "26% chance, none expected to fall.");

    /* and the UV figure wears its WHO band, like every other banded value in the app —
       it was the plain-white "8.3 / Very high" beside an amber "70 / Moderate" that made
       the only coloured value on the wall the only harmless one */
    var uv = app.qsa(".stat", body).filter(function (st) {
      return st.querySelector(".stat-k").textContent === "UV max";
    })[0];
    assert.match(uv.querySelector(".stat-v span").getAttribute("class"), /^band-[1-5]$/);
  });
});

/* ---------------- the zero columns ----------------
   El Cajon is dry for months at a time, and the panels said so eighteen times per screenful:
   seven "0%" under the home strip, seven more down the hourly panel, and a RAIN section
   reading 0 in / 0% / 0 in + 0% chance. A column whose every cell says the same thing is not
   data, and on a wall panel it is the difference between a screen that is answering and a
   screen that is filling itself in. */

/* the fixture with every drop of rain taken out of it, optionally putting one back */
function dry(opts) {
  opts = opts || {};
  return function (url, init, clock) {
    var body = wx.build({ now: clock.now });
    body.current.precipitation = 0;
    body.hourly.precipitation_probability = body.hourly.time.map(function () { return 0; });
    body.hourly.precipitation = body.hourly.time.map(function () { return 0; });
    body.daily.precipitation_sum = body.daily.time.map(function () { return 0; });
    body.daily.precipitation_probability_max = body.daily.time.map(function () { return 0; });
    if (opts.dayWithRain != null) {
      body.daily.precipitation_probability_max[opts.dayWithRain] = 60;
    }
    if (opts.hourWithRain != null) {
      body.hourly.precipitation_probability[opts.hourWithRain] = 70;
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

test("a dry week says so in one line instead of printing nine zeros", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: dry() });
  return app.flush().then(function () {
    app.WP.panels.open("weather");
    var body = app.panelBody("weather");
    var rain = app.qsa(".psec", body).filter(function (s) {
      return s.querySelector(".psec-t").textContent === "Rain";
    })[0];
    assert.ok(rain, "the Rain section disappeared entirely");
    assert.equal(rain.querySelectorAll(".stat").length, 0,
      "a dry week is still being printed as a grid of zeros");
    assert.match(rain.textContent, /None forecast/);
  });
});

test("when rain is coming the section says which day, not which zeros", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: dry({ dayWithRain: 3 }) });
  return app.flush().then(function () {
    app.WP.panels.open("weather");
    var body = app.panelBody("weather");
    var rain = app.qsa(".psec", body).filter(function (s) {
      return s.querySelector(".psec-t").textContent === "Rain";
    })[0];
    /* day 3 of the fixture's week, named the way a person would name it */
    var day = new Date(now + 3 * 86400000)
      .toLocaleDateString(undefined, { weekday: "long" });
    assert.match(rain.textContent, new RegExp("Next rain: " + day));
    assert.match(rain.textContent, /60% chance/);
  });
});

test("rain that is actually falling brings the three figures back", function () {
  /* The collapse is about zeros, not about hiding rain: the moment there is something to
     compare, the cells that let you compare it come back. */
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: dry({ hourWithRain: 9 }) });
  return app.flush().then(function () {
    app.WP.panels.open("weather");
    var body = app.panelBody("weather");
    var rain = app.qsa(".psec", body).filter(function (s) {
      return s.querySelector(".psec-t").textContent === "Rain";
    })[0];
    assert.equal(rain.querySelectorAll(".stat").length, 3);
    assert.match(rain.textContent, /Next hour/);
  });
});

test("the hourly strip drops its rain column when every hour in view is dry", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: dry() });
  return app.flush().then(function () {
    assert.ok(app.qsa("#hourly .hr").length >= 12, "the strip did not render");
    assert.equal(app.qsa("#hourly .hr-p").length, 0,
      "the strip is still printing a column of identical zeros");
    app.WP.panels.open("hourly");
    assert.equal(app.qsa(".hrow-p", app.panelBody("hourly")).length, 0,
      "the panel list is still printing a column of identical zeros");
  });
});

test("one wet hour brings the whole column back, so the figures can be compared", function () {
  var now = at(2025, 5, 10, 9, 30);
  var app = h.createApp({ now: now, fetch: dry({ hourWithRain: 14 }) });
  return app.flush().then(function () {
    var chips = app.qsa("#hourly .hr");
    assert.equal(app.qsa("#hourly .hr-p").length, chips.length,
      "the column came back for some hours but not all of them");
  });
});
