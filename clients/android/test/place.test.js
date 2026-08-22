/* Choosing where the panel is, and the second home screen.

   Two features that arrived together and share one story: the wall panel stopped needing a
   PC. A town is searched for and tapped on the glass rather than typed into config.js and
   rebuilt, and the tiles that used to be crushed into one line at the bottom of the
   dashboard moved to a screen of their own a swipe away.

   Nothing here asserts on a real place name from the shipped config — the harness config is
   synthetic, as everywhere else in this suite. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var wx = require("./lib/wx-fixture.js");

function geoOf(app) { return app.WP.geo; }

/* An Open-Meteo geocoding answer, in the shape the service actually sends. */
function hits(list) { return { generationtime_ms: 0.2, results: list }; }

/* ---------------- the pure half: geo.js ---------------- */

test("the search asks for a bounded number of results and escapes the query", function () {
  var app = h.createApp({});
  var url = geoOf(app).searchUrl("São Paulo & co", 99);
  assert.match(url, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/);
  assert.match(url, /name=S%C3%A3o%20Paulo%20%26%20co/, "the query is not URL-encoded");
  assert.match(url, /count=6/, "the count must be capped, not passed through");
  assert.equal(/[?&]key=|token/.test(url), false, "no key should ever be in the URL");
});

test("two letters is the floor — a wall panel must not search on one", function () {
  var g = geoOf(h.createApp({}));
  assert.equal(g.usable(""), false);
  assert.equal(g.usable(" p "), false);
  assert.equal(g.usable("po"), true);
});

test("a result without usable coordinates is dropped, not offered", function () {
  var g = geoOf(h.createApp({}));
  var out = g.parse(hits([
    { name: "Real", latitude: 45.5, longitude: -122.6, country: "United States" },
    { name: "No numbers", latitude: null, longitude: null },
    { name: "Off the globe", latitude: 991, longitude: 4 },
    { name: "", latitude: 1, longitude: 2 }
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Real");
});

test("the region is what separates two towns of the same name", function () {
  var g = geoOf(h.createApp({}));
  var out = g.parse(hits([
    { name: "Portland", latitude: 45.52, longitude: -122.68, admin1: "Oregon", country: "United States" },
    { name: "Portland", latitude: 43.66, longitude: -70.26, admin1: "Maine", country: "United States" }
  ]));
  assert.equal(out.length, 2, "two real places must both be offered");
  assert.equal(out[0].where, "Oregon · United States");
  assert.equal(out[1].where, "Maine · United States");
  /* and the region rides into the stored name, so the dashboard says which one it is */
  assert.equal(g.toPlace(out[1]).name, "Portland, Maine");
});

test("a city state does not print its own country twice", function () {
  var g = geoOf(h.createApp({}));
  var out = g.parse(hits([
    { name: "Singapore", latitude: 1.29, longitude: 103.85, admin1: "Singapore", country: "Singapore" }
  ]));
  assert.equal(out[0].where, "Singapore");
  assert.equal(g.toPlace(out[0]).name, "Singapore", "the name must not become Singapore, Singapore");
});

test("the same town twice a kilometre apart is one row, not five", function () {
  var g = geoOf(h.createApp({}));
  var out = g.parse(hits([
    { name: "Springfield", latitude: 39.80, longitude: -89.64, admin1: "Illinois", country: "US" },
    { name: "Springfield", latitude: 39.82, longitude: -89.65, admin1: "Illinois", country: "US" },
    { name: "Springfield", latitude: 37.21, longitude: -93.29, admin1: "Missouri", country: "US" }
  ]));
  assert.equal(out.length, 2, "the near-duplicate should have collapsed");
  assert.equal(out[1].where, "Missouri · US");
});

test("an answer the app cannot read is an empty list, never a throw", function () {
  var g = geoOf(h.createApp({}));
  /* lengths, not deepEqual: an array built inside the vm carries the vm's Array.prototype
     and assert/strict refuses to match it against a host array. */
  assert.equal(g.parse(null).length, 0);
  assert.equal(g.parse({}).length, 0);
  assert.equal(g.parse({ results: "nope" }).length, 0);
});

/* ---------------- the stored place ---------------- */

test("with nothing chosen the panel is where the build said it was", function () {
  var app = h.createApp({});
  assert.equal(app.WP.place().name, "Test Location");
  assert.equal(app.WP.placeIsChosen(), false);
});

test("a chosen place wins over the build, and survives a restart", function () {
  var app = h.createApp({});
  assert.equal(app.WP.setPlace({ name: "Hobart", latitude: -42.88, longitude: 147.32 }), true);
  assert.equal(app.WP.place().name, "Hobart");
  assert.equal(app.WP.placeIsChosen(), true);

  var again = h.createApp({ storage: app.storage.data });
  assert.equal(again.WP.place().name, "Hobart");
  assert.equal(again.WP.place().latitude, -42.88);
});

test("a half-written place is refused rather than taking the weather off the air", function () {
  var app = h.createApp({});
  assert.equal(app.WP.setPlace({ name: "Nowhere", latitude: "abc", longitude: 3 }), false);
  assert.equal(app.WP.setPlace({ name: "Off globe", latitude: 91, longitude: 3 }), false);
  assert.equal(app.WP.setPlace(null), false);
  assert.equal(app.WP.place().name, "Test Location", "a bad write must not clear the good one");
});

test("a stored place that has gone bad falls back instead of blanking the wall", function () {
  var app = h.createApp({ storage: { "inky.place.v1": '{"name":"Broken","latitude":null}' } });
  assert.equal(app.WP.place().name, "Test Location");
});

test("settings.reset() does not move the panel to another town", function () {
  /* The place is deliberately not a setting: resetting units must not silently relocate a
     wall panel to wherever the APK was built. */
  var app = h.createApp({});
  app.WP.setPlace({ name: "Hobart", latitude: -42.88, longitude: 147.32 });
  app.WP.settings.reset();
  assert.equal(app.WP.place().name, "Hobart");
});

/* ---------------- what the widgets do with it ---------------- */

test("the forecast is asked for the chosen coordinates, not the built-in ones", function () {
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    assert.match(app.fetches[0].url, /latitude=10&/);
    app.WP.setPlace({ name: "Hobart", latitude: -42.88, longitude: 147.32 });
    var last = app.fetches[app.fetches.length - 1].url;
    assert.match(last, /latitude=-42\.88/);
    assert.match(last, /longitude=147\.32/);
  });
});

test("moving the panel drops the old town's reading instead of relabelling it", function () {
  var app = h.createApp({ fetch: wx.serve() });
  return app.flush().then(function () {
    assert.notEqual(app.text("wx-temp"), "--°");
    app.WP.setPlace({ name: "Hobart", latitude: -42.88, longitude: 147.32 });
    assert.equal(app.WP.registry.weather.data, null,
      "the previous place's payload is still on screen under the new name");
    assert.equal(app.storage.data["inky.wx.v2"], "", "its cache would repaint it at boot");
  });
});

test("a panel that booted with no location comes alive when one is chosen", function () {
  /* The early return in weather.init() used to be the end of it: with no coordinates the
     widget was dead until a reinstall. It is the exact case the search exists for. */
  var cfg = h.defaultConfig();
  cfg.location = { name: "", latitude: null, longitude: null };
  var app = h.createApp({ config: cfg, fetch: wx.serve() });
  assert.equal(app.fetches.length, 0);
  app.WP.setPlace({ name: "Hobart", latitude: -42.88, longitude: 147.32 });
  return app.flush().then(function () {
    assert.ok(app.fetches.length > 0, "choosing a town did not start the forecast");
    assert.match(app.fetches[0].url, /latitude=-42\.88/);
  });
});

/* ---------------- the Settings section ---------------- */

function geoServer(payload) {
  return function (url) {
    if (url.indexOf("geocoding-api") === -1) {
      return Promise.reject(new Error("offline"));
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload); } });
  };
}

/* the weather and air widgets fetch at boot; only the geocoder is this section's business */
function searches(app) {
  return app.fetches.filter(function (f) { return f.url.indexOf("geocoding-api") !== -1; }).length;
}

function typeInto(app, id, text) {
  var el = app.$(id);
  el.value = text;
  app.doc.dispatch(el, "input", {});
  return el;
}

test("the Location section names where the panel is now", function () {
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var body = app.panelBody("settings");
  assert.match(body.textContent, /Location/);
  assert.match(body.textContent, /Test Location/);
  assert.ok(app.$("place-q"), "no field to type a town into");
});

test("typing does not repaint the panel out from under the caret", function () {
  /* The body is replaced wholesale on every paint, so a repaint per keystroke would drop
     both the text and the keyboard focus. Typing only records; the search is the commit. */
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var field = typeInto(app, "place-q", "portl");
  assert.equal(app.$("place-q"), field, "the field was replaced while it was being typed in");
  assert.equal(searches(app), 0, "a keystroke must not fire a request");
});

test("searching lists what came back, and a tap moves the panel there", function () {
  var app = h.createApp({
    fetch: geoServer(hits([
      { name: "Portland", latitude: 45.52, longitude: -122.68, admin1: "Oregon", country: "United States" },
      { name: "Portland", latitude: 43.66, longitude: -70.26, admin1: "Maine", country: "United States" }
    ]))
  });
  app.WP.panels.open("settings");
  typeInto(app, "place-q", "portland");
  app.tap(app.actBtn("settings", "find"));
  return app.flush().then(function () {
    var rows = app.qsa(".place-row", app.panelBody("settings"));
    assert.equal(rows.length, 2, "the results did not render");
    assert.match(rows[0].textContent, /Oregon/);

    app.tap(rows[1]);
    assert.equal(app.WP.place().name, "Portland, Maine");
    assert.equal(app.qsa(".place-row", app.panelBody("settings")).length, 0,
      "the list must collapse once a town has been chosen");
    assert.match(app.panelBody("settings").textContent, /Portland, Maine/);
  });
});

test("a search with no answer says so instead of showing an empty box", function () {
  var app = h.createApp({ fetch: geoServer(hits([])) });
  app.WP.panels.open("settings");
  typeInto(app, "place-q", "zzzzzz");
  app.tap(app.actBtn("settings", "find"));
  return app.flush().then(function () {
    assert.match(app.panelBody("settings").textContent, /No town by that name/);
  });
});

test("a search that cannot get out blames the wifi, not the user", function () {
  var app = h.createApp({ fetch: function () { return Promise.reject(new Error("down")); } });
  app.WP.panels.open("settings");
  typeInto(app, "place-q", "portland");
  app.tap(app.actBtn("settings", "find"));
  return app.flush().then(function () {
    assert.match(app.panelBody("settings").textContent, /check the wifi/);
  });
});

test("one letter is answered on the glass, without a request", function () {
  var app = h.createApp({});
  app.WP.panels.open("settings");
  typeInto(app, "place-q", "p");
  app.tap(app.actBtn("settings", "find"));
  assert.equal(searches(app), 0);
  assert.match(app.panelBody("settings").textContent, /at least two letters/);
});

/* ---------------- the second home screen ---------------- */

function swipeHome(app, dx) {
  var card = app.qs('#home > .card[data-widget="weather"]');
  app.doc.dispatch(card, "pointerdown", { pointerId: 3, clientX: 400, clientY: 500 });
  app.doc.dispatch(card, "pointermove", { pointerId: 3, clientX: 400 + dx, clientY: 504 });
  app.doc.dispatch(card, "pointerup", { pointerId: 3, clientX: 400 + dx, clientY: 504 });
  return app;
}

test("the tools and readings tiles live on the second screen", function () {
  var app = h.createApp({});
  assert.equal(app.qsa("#home .row3").length, 0, "the tile rows are still on the dashboard");
  assert.equal(app.qsa("#home2 .row3 .card.mini").length, 7);
  assert.ok(app.qs('#home2 > .card[data-widget="news"]'), "the news line did not move with them");
  /* and the dashboard kept everything a glance is for */
  ["clock", "weather", "hourly", "daily", "sensors"].forEach(function (w) {
    assert.ok(app.qs('#home > [data-widget="' + w + '"]'), w + " left the dashboard");
  });
});

test("a swipe on the wall moves between the two screens", function () {
  var app = h.createApp({});
  var pages = app.WP.carousel.pages;
  assert.equal(pages.idx, 0);
  swipeHome(app, -120);
  assert.equal(pages.idx, 1, "a left swipe did not reach the second screen");
  assert.ok(app.$("pages").classList.contains("p2"));
  swipeHome(app, 120);
  assert.equal(pages.idx, 0);
  assert.equal(app.$("pages").classList.contains("p2"), false);
});

test("the two screens do not wrap — the dashboard is the end of the road", function () {
  /* Unlike the panel ring: a swipe right from the dashboard must not land on the tools. */
  var app = h.createApp({});
  swipeHome(app, 150);
  assert.equal(app.WP.carousel.pages.idx, 0);
  swipeHome(app, -150);
  swipeHome(app, -150);
  assert.equal(app.WP.carousel.pages.idx, 1);
});

test("a short or vertical drag on the wall is not a page turn", function () {
  var app = h.createApp({});
  swipeHome(app, -40);
  assert.equal(app.WP.carousel.pages.idx, 0, "a 40px drag paged the wall");
  var card = app.qs('#home > .card[data-widget="weather"]');
  app.doc.dispatch(card, "pointerdown", { pointerId: 4, clientX: 400, clientY: 500 });
  app.doc.dispatch(card, "pointermove", { pointerId: 4, clientX: 320, clientY: 900 });
  app.doc.dispatch(card, "pointerup", { pointerId: 4, clientX: 320, clientY: 900 });
  assert.equal(app.WP.carousel.pages.idx, 0, "a mostly-vertical drag paged the wall");
});

test("swiping the hour chips scrolls them, it does not page the wall", function () {
  var app = h.createApp({});
  var strip = app.$("hourly");
  strip.scrollWidth = 1400;
  strip.clientWidth = 700;
  app.doc.dispatch(strip, "pointerdown", { pointerId: 5, clientX: 400, clientY: 500 });
  app.doc.dispatch(strip, "pointermove", { pointerId: 5, clientX: 200, clientY: 502 });
  app.doc.dispatch(strip, "pointerup", { pointerId: 5, clientX: 200, clientY: 502 });
  assert.equal(app.WP.carousel.pages.idx, 0);
});

test("the wall comes back to the dashboard on its own", function () {
  var app = h.createApp({});
  swipeHome(app, -120);
  assert.equal(app.WP.carousel.pages.idx, 1);
  app.advance(app.WP.carousel.pages.IDLE_MS + 2000);
  assert.equal(app.WP.carousel.pages.idx, 0, "screen two sat there unattended");
});

test("swiping between screens still works inside a panel", function () {
  /* The page gesture and the panel gesture share one listener; neither may eat the other. */
  var app = h.createApp({});
  app.WP.panels.open("clock");
  var body = app.qs(".panel.is-open [data-body]");
  app.doc.dispatch(body, "pointerdown", { pointerId: 6, clientX: 400, clientY: 500 });
  app.doc.dispatch(body, "pointermove", { pointerId: 6, clientX: 260, clientY: 504 });
  app.doc.dispatch(body, "pointerup", { pointerId: 6, clientX: 260, clientY: 504 });
  assert.deepEqual(app.stack(), ["weather"]);
  assert.equal(app.WP.carousel.pages.idx, 0, "a panel swipe also paged the wall behind it");
});
