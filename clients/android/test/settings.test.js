/* Persisted settings: defaults, the merge that reads them back, and the two things that
   have gone wrong here before — a stale CONFIG.plugins hiding half the dashboard, and a
   settings blob from an older build being trusted field-for-field. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var fakeBridge = require("./lib/fake-bridge.js");

var KEY = "inky.settings.v2";
var WIDGETS = ["clock", "weather", "hourly", "daily", "moon", "air",
               "paper", "gallery",
               "news", "sensors", "system", "timer", "settings"];

function boot(opts) { return h.createApp(opts || {}); }

test("defaults ship every widget visible", function () {
  var app = boot();
  var show = app.WP.settings.get("show");
  assert.deepEqual(Object.keys(show).sort(), WIDGETS.slice().sort());
  WIDGETS.forEach(function (w) { assert.equal(show[w], true, w + " should default to visible"); });
});

test("a stale CONFIG.plugins list cannot hide widgets", function () {
  /* CONFIG.plugins is the old on/off list. The Settings panel is the real control now, and
     it persists — a config file listing three plugins must not black out the other five. */
  var cfg = h.defaultConfig();
  cfg.plugins = ["clock"];
  var app = boot({ config: cfg });
  var show = app.WP.settings.get("show");
  WIDGETS.forEach(function (w) { assert.equal(show[w], true, w + " hidden by stale plugins list"); });
  var visible = app.qsa("[data-widget]").filter(function (n) { return n.style.display !== "none"; });
  assert.equal(visible.length, WIDGETS.length);
  assert.equal(app.$("empty").hidden, true, "empty state must not show with widgets on");
});

test("CONFIG seeds units and clock format, and rejects nonsense", function () {
  var metric = h.defaultConfig();
  metric.units = "celsius";
  metric.clockHours = 24;
  var a = boot({ config: metric });
  assert.equal(a.WP.settings.get("units"), "celsius");
  assert.equal(a.WP.settings.get("clockHours"), 24);
  assert.equal(a.WP.settings.isMetric(), true);
  assert.equal(a.WP.settings.tempUnit(), "C");

  var junk = h.defaultConfig();
  junk.units = "kelvin";
  junk.clockHours = 13;
  var b = boot({ config: junk });
  assert.equal(b.WP.settings.get("units"), "fahrenheit", "unknown unit must fall back");
  assert.equal(b.WP.settings.get("clockHours"), 12, "unknown clock format must fall back");
});

test("a missing CONFIG does not stop the app booting", function () {
  var app = boot({ config: undefined });
  assert.equal(app.WP.settings.get("units"), "fahrenheit");
  assert.equal(app.WP.settings.get("burnIn"), true);
  assert.deepEqual(app.logs.error, []);
});

test("saved settings are merged, not trusted wholesale", function () {
  var saved = {
    units: "celsius",
    clockHours: 24,
    seconds: true,
    burnIn: false,
    show: { clock: false, weather: true, notAWidget: false },
    somethingFromAFutureBuild: { nested: 1 },
    tempUnit: "should be ignored"
  };
  var app = boot({ storage: { "inky.settings.v2": JSON.stringify(saved) } });
  var s = app.WP.settings;

  assert.equal(s.get("units"), "celsius");
  assert.equal(s.get("clockHours"), 24);
  assert.equal(s.get("seconds"), true);
  assert.equal(s.get("burnIn"), false);
  assert.equal(s.get("show").clock, false);
  assert.equal(s.get("show").weather, true);
  assert.equal(s.get("show").timer, true, "a widget missing from the blob keeps its default");
  assert.equal("notAWidget" in s.get("show"), false, "unknown widget keys must not be adopted");
  assert.equal(s.data.somethingFromAFutureBuild, undefined, "unknown top-level keys dropped");
  assert.equal(typeof s.tempUnit, "function", "a saved key must not shadow a method");
});

test("garbage in localStorage falls back to defaults instead of throwing", function () {
  ["not json", "null", "[]", '"a string"', "42"].forEach(function (raw) {
    var app = boot({ storage: { "inky.settings.v2": raw } });
    assert.equal(app.WP.settings.get("units"), "fahrenheit", "raw=" + raw);
    assert.deepEqual(app.logs.error, [], "raw=" + raw);
  });
});

test("non-boolean show values are ignored rather than coerced", function () {
  var app = boot({ storage: { "inky.settings.v2": JSON.stringify({ show: { clock: 0, timer: "yes" } }) } });
  var show = app.WP.settings.get("show");
  assert.equal(show.clock, true, "0 is not a boolean and must not hide the clock");
  assert.equal(show.timer, true);
});

test("set() persists, applies visibility and notifies listeners", function () {
  var app = boot();
  var seen = [];
  app.WP.settings.onChange(function (k, v) { seen.push([k, v]); });

  app.WP.settings.setShow("weather", false);
  assert.equal(app.WP.settings.get("show").weather, false);
  var card = app.qs('[data-widget="weather"]');
  assert.equal(card.style.display, "none", "hidden widget's card is not displayed");

  var persisted = JSON.parse(app.storage.data[KEY]);
  assert.equal(persisted.show.weather, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "show");

  app.WP.settings.setShow("weather", true);
  assert.equal(app.qs('[data-widget="weather"]').style.display, "");
});

test("hiding every widget shows the empty state and drops the tile row", function () {
  /* All three tiles off used to leave .row3 in the column carrying flex-grow, which ate
     every pixel the hidden cards gave back. */
  var app = boot();
  WIDGETS.forEach(function (w) { app.WP.settings.setShow(w, false); });
  assert.equal(app.$("empty").hidden, false, "empty state must appear");
  app.qsa("#home > .row3").forEach(function (r) {
    assert.equal(r.style.display, "none", "empty tile row must not stay");
  });

  app.WP.settings.setShow("timer", true);
  assert.equal(app.$("empty").hidden, true);
  assert.equal(app.qs("#home > .row3").style.display, "", "tile row returns with one tile on");
});

test("reset restores every default and persists them", function () {
  var app = boot({ storage: { "inky.settings.v2": JSON.stringify({ units: "celsius", seconds: true, show: { clock: false } }) } });
  assert.equal(app.WP.settings.get("units"), "celsius");

  app.WP.settings.reset();
  assert.equal(app.WP.settings.get("units"), "fahrenheit");
  assert.equal(app.WP.settings.get("seconds"), false);
  assert.equal(app.WP.settings.get("show").clock, true);
  assert.equal(JSON.parse(app.storage.data[KEY]).show.clock, true, "reset must be written out");
});

test("settings survive a reload through localStorage", function () {
  var first = boot();
  first.WP.settings.set("units", "celsius");
  first.WP.settings.set("seconds", true);
  first.WP.settings.setShow("hourly", false);

  var second = boot({ storage: first.storage.data });
  assert.equal(second.WP.settings.get("units"), "celsius");
  assert.equal(second.WP.settings.get("seconds"), true);
  assert.equal(second.WP.settings.get("show").hourly, false);
});

test("SharedPreferences is the fallback when localStorage comes back empty", function () {
  /* A force-stopped wall panel loses WebView localStorage more often than a phone does. */
  var bridge = fakeBridge.make({ prefs: { "inky.settings.v2": JSON.stringify({ units: "celsius" }) } });
  var app = boot({ bridge: bridge });
  assert.equal(app.WP.settings.get("units"), "celsius", "did not fall back to the bridge");
});

test("every write is mirrored into SharedPreferences", function () {
  var bridge = fakeBridge.make({});
  var app = boot({ bridge: bridge });
  app.WP.settings.set("units", "celsius");
  assert.ok(bridge.prefs[KEY], "settings were not mirrored to the bridge");
  assert.equal(JSON.parse(bridge.prefs[KEY]).units, "celsius");
});

test("a localStorage that throws does not take the panel down", function () {
  /* file:// WebViews have been known to refuse storage outright. */
  var app = boot({ boot: false });
  app.storage.throws = true;
  app.boot();
  assert.deepEqual(app.logs.error, []);
  app.WP.settings.set("units", "celsius");
  assert.equal(app.WP.settings.get("units"), "celsius", "in-memory settings still apply");
});

test("the settings tile summarises the current state", function () {
  /* CHANGED in the fit round: the unit moved up to the tile's VALUE line, which used to
     hold a gear glyph — the one slot in a row of six tiles where the eye is scanning for a
     number, spent on a picture of the word already printed above it. The sub-line keeps the
     clock format and the count of hidden widgets, shortened because the tile is 102 CSS px
     wide and "°C · 24h · 1 hidden" needed nearly twice its content box. */
  var app = boot();
  assert.equal(app.text("set-big"), "°F");
  assert.equal(app.text("set-sub"), "12h");
  app.WP.settings.set("units", "celsius");
  app.WP.settings.set("clockHours", 24);
  assert.equal(app.text("set-big"), "°C");
  assert.equal(app.text("set-sub"), "24h");
  app.WP.settings.setShow("daily", false);
  assert.equal(app.text("set-sub"), "24h · 1 off");
});
