/* The bridge fetch (network through the Java shell) and the News widget built on it.

   The Java half (MainActivity.doFetch) cannot run here; what CAN be pinned is the whole
   JS contract around it: the origin allowlist is assembled from config and locked once at
   boot, requests carry the right shape across the boundary, payloads come back as base64
   and decode as UTF-8, failures reject instead of hanging, and Home Assistant's live
   traffic actually rides this path instead of the CORS-doomed direct fetch. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var fakeBridge = require("./lib/fake-bridge.js");

function b64utf8(s) { return Buffer.from(s, "utf8").toString("base64"); }

/* ---------------- originOf ---------------- */

test("originOf normalises scheme, host and default ports", function () {
  var app = h.createApp({});
  var o = app.WP.originOf;
  assert.equal(o("https://Example.COM/path?q=1"), "https://example.com");
  assert.equal(o("https://example.com:443/x"), "https://example.com");
  assert.equal(o("http://example.com:80/x"), "http://example.com");
  assert.equal(o("http://ha.local:8123/api/states"), "http://ha.local:8123");
  assert.equal(o("ftp://example.com/x"), null);
  assert.equal(o("not a url"), null);
  assert.equal(o(null), null);
});

/* ---------------- the allowlist ---------------- */

test("boot locks the origin allowlist: open-meteo, air quality, HA and the feeds", function () {
  var bridge = fakeBridge.make({ net: true });
  var cfg = h.defaultConfig();
  cfg.homeAssistant = { enabled: true, baseUrl: "http://ha.local:8123", token: "t",
                        entities: [{ id: "sensor.x", label: "X" }] };
  var app = h.createApp({ bridge: bridge, config: cfg });
  assert.ok(Array.isArray(bridge.lockedOrigins), "boot never called fetchOrigins");
  ["https://api.open-meteo.com", "https://air-quality-api.open-meteo.com",
   "http://ha.local:8123", "https://feeds.bbci.co.uk", "https://feeds.npr.org"
  ].forEach(function (o) {
    assert.ok(bridge.lockedOrigins.indexOf(o) !== -1, "allowlist is missing " + o);
  });
  /* no duplicates — the Java side treats the list as a set, but the page should not
     send noise */
  assert.equal(new Set(bridge.lockedOrigins).size, bridge.lockedOrigins.length);
});

test("a second registration attempt is refused, like the Java side", function () {
  var bridge = fakeBridge.make({ net: true });
  var app = h.createApp({ bridge: bridge });
  assert.equal(app.WP.bridgeFetch.lockOrigins(), false, "the lock was not first-write-wins");
});

/* ---------------- request / response plumbing ---------------- */

test("a bridge GET resolves with status, ok and UTF-8 text", function () {
  var bridge = fakeBridge.make({ net: true });
  var app = h.createApp({ bridge: bridge });
  var got;
  var before = bridge.fetchCalls.length;        // news issued its feed GETs at boot
  app.WP.bridgeFetch.get("https://api.open-meteo.com/x", { Accept: "text/xml" })
    .then(function (r) { got = r; });
  assert.equal(bridge.fetchCalls.length, before + 1);
  var call = bridge.fetchCalls[bridge.fetchCalls.length - 1];
  assert.equal(call.method, "GET");
  assert.equal(call.headers.Accept, "text/xml");

  app.WP.bridgeFetch._resolve(call.id, 200, b64utf8("héllo — 23°"));
  return app.flush().then(function () {
    assert.ok(got, "promise never resolved");
    assert.equal(got.ok, true);
    assert.equal(got.status, 200);
    assert.equal(got.text, "héllo — 23°", "UTF-8 did not survive the base64 hop");
  });
});

test("an HTTP error status resolves ok:false; a shell error rejects", function () {
  var bridge = fakeBridge.make({ net: true });
  var app = h.createApp({ bridge: bridge });
  var got, err;
  app.WP.bridgeFetch.get("https://api.open-meteo.com/x")
    .then(function (r) { got = r; });
  var getCall = bridge.fetchCalls[bridge.fetchCalls.length - 1];
  app.WP.bridgeFetch._resolve(getCall.id, 401, b64utf8("denied"));

  app.WP.bridgeFetch.post("https://api.open-meteo.com/y", {}, "{}")
    .catch(function (e) { err = e; });
  var postCall = bridge.fetchCalls[bridge.fetchCalls.length - 1];
  assert.equal(postCall.method, "POST");
  app.WP.bridgeFetch._reject(postCall.id, "origin not allowed: https://evil");

  return app.flush().then(function () {
    assert.equal(got.ok, false);
    assert.equal(got.status, 401);
    assert.match(err.message, /origin not allowed/);
  });
});

test("a request the shell never answers times out instead of hanging forever", function () {
  var bridge = fakeBridge.make({ net: true });
  var app = h.createApp({ bridge: bridge });
  var err;
  var before = Object.keys(app.WP.bridgeFetch.pending).slice();
  app.WP.bridgeFetch.get("https://api.open-meteo.com/x").catch(function (e) { err = e; });
  var mine = Object.keys(app.WP.bridgeFetch.pending).filter(function (k) {
    return before.indexOf(k) === -1;
  });
  app.advance(21000);
  return app.flush().then(function () {
    assert.match(err.message, /timed out/);
    /* OUR entry must be gone. The map as a whole is no longer empty here by design: the
       picture widgets chain retries (the front page walks back a shelf per attempt), so
       someone else's fresh in-flight request is normal, not a leak. */
    mine.forEach(function (k) {
      assert.equal(k in app.WP.bridgeFetch.pending, false, "the timed-out entry leaked");
    });
  });
});

test("without the bridge, bridgeFetch rejects and nothing crashes", function () {
  var app = h.createApp({});
  var err;
  app.WP.bridgeFetch.get("https://api.open-meteo.com/x").catch(function (e) { err = e; });
  return app.flush().then(function () {
    assert.match(err.message, /unavailable/);
  });
});

/* ---------------- Home Assistant rides the bridge ---------------- */

test("live HA polls go through the shell, not through fetch", function () {
  var bridge = fakeBridge.make({ net: true });
  var cfg = h.defaultConfig();
  cfg.homeAssistant = { enabled: true, baseUrl: "http://ha.local:8123", token: "sekrit",
                        refreshSeconds: 30,
                        entities: [{ id: "sensor.hall_temp", label: "Hall" }] };
  var app = h.createApp({ bridge: bridge, config: cfg });
  return app.flush().then(function () {
    var ha = bridge.fetchCalls.filter(function (c) { return c.url.indexOf("/api/states/") !== -1; });
    assert.ok(ha.length >= 1, "no HA poll crossed the bridge");
    assert.equal(ha[0].method, "GET");
    assert.match(ha[0].headers.Authorization, /^Bearer sekrit$/);
    assert.equal(app.fetches.filter(function (f) {
      return f.url.indexOf("ha.local") !== -1;
    }).length, 0, "an HA request still went out through fetch — CORS will kill it on the wall");

    /* answer the poll and the tile fills in */
    app.WP.bridgeFetch._resolve(ha[0].id, 200,
      b64utf8(JSON.stringify({ state: "71.4", attributes: { unit_of_measurement: "°F" } })));
    return app.flush();
  }).then(function () {
    var e = app.registry.sensors.find("sensor.hall_temp");
    assert.equal(e.value, 71.4);
    assert.equal(e.err, null);
  });
});

/* ---------------- the feed parser ---------------- */

var RSS = '<?xml version="1.0"?><rss version="2.0"><channel>'
  + "<title>Example World News</title>"
  + "<item><title>Older story about a &amp; b</title>"
  + "<pubDate>Mon, 17 Aug 2026 09:00:00 GMT</pubDate></item>"
  + "<item><title><![CDATA[Newest: markets <b>rally</b> on rain]]></title>"
  + "<pubDate>Mon, 17 Aug 2026 21:30:00 GMT</pubDate></item>"
  + "<item><title>Middle story &#8212; with a dash</title>"
  + "<pubDate>Mon, 17 Aug 2026 15:00:00 GMT</pubDate></item>"
  + "</channel></rss>";

var ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">'
  + "<title>Example Atom</title>"
  + "<entry><title>Atom one</title><updated>2026-08-17T10:00:00Z</updated></entry>"
  + "<entry><title>Atom two</title><updated>2026-08-17T20:00:00Z</updated></entry>"
  + "</feed>";

test("RSS parses: channel title, CDATA, entities, markup stripped, newest first", function () {
  var app = h.createApp({});
  var f = app.registry.news.parseFeed(RSS);
  assert.equal(f.source, "Example World News");
  assert.equal(f.items.length, 3);
  assert.equal(f.items[0].title, "Newest: markets rally on rain");
  assert.equal(f.items[1].title, "Middle story — with a dash");
  assert.equal(f.items[2].title, "Older story about a & b");
  assert.ok(f.items[0].at > f.items[1].at && f.items[1].at > f.items[2].at);
});

test("Atom parses too, and garbage parses to nothing instead of throwing", function () {
  var app = h.createApp({});
  var f = app.registry.news.parseFeed(ATOM);
  assert.equal(f.source, "Example Atom");
  assert.equal(f.items.map(function (i) { return i.title; }).join("|"), "Atom two|Atom one");

  assert.equal(app.registry.news.parseFeed("<html>not a feed</html>").items.length, 0);
  assert.equal(app.registry.news.parseFeed("").items.length, 0);
  assert.equal(app.registry.news.parseFeed(null).items.length, 0);
});

test("merge dedupes across feeds, newest first, capped", function () {
  var app = h.createApp({});
  var a = { source: "A", items: [{ title: "Shared headline", at: 3000 }, { title: "Only A", at: 1000 }] };
  var b = { source: "B", items: [{ title: "shared headline", at: 2000 }, { title: "Only B", at: 4000 }] };
  var m = app.registry.news.merge([a, b]);
  assert.equal(m.map(function (i) { return i.title; }).join("|"),
    "Only B|Shared headline|Only A", "dedupe is case-insensitive and keeps the newest copy");
  assert.equal(m[0].source, "B");

  var big = { source: "C", items: [] };
  for (var i = 0; i < 40; i++) big.items.push({ title: "story " + i, at: i });
  assert.equal(app.registry.news.merge([big]).length, 24, "the panel list is capped");
});

/* ---------------- the widget ---------------- */

test("without the shell the ticker explains itself instead of erroring forever", function () {
  var app = h.createApp({});
  assert.match(app.text("news-line"), /tablet/,
    "the browser fallback copy is gone");
  app.WP.panels.open("news");
  assert.ok(app.panelBody("news").textContent.length > 40);
});

test("headlines rotate, and a title full of markup renders inert", function () {
  var app = h.createApp({});
  var news = app.registry.news;
  news.items = [
    { title: "<script>alert(1)</script> first", at: 1, source: "X" },
    { title: "second", at: 2, source: "Y" }
  ];
  news.idx = 0;
  news.renderCard();
  var line = app.$("news-line");
  assert.ok(line.innerHTML.indexOf("<script") === -1, "a feed title reached innerHTML unescaped");
  assert.match(line.textContent, /first/);

  news.advance();
  assert.match(app.text("news-line"), /second/);
  news.advance();
  assert.match(app.text("news-line"), /first/, "rotation does not wrap");
});

test("the news card is in the home column and hides with its widget switch", function () {
  var app = h.createApp({});
  var card = app.qs('#home > .card[data-widget="news"]');
  assert.ok(card, "no news card on the home view");
  app.WP.settings.setShow("news", false);
  assert.equal(card.style.display, "none");
  app.WP.settings.setShow("news", true);
  assert.equal(card.style.display, "");
});

test("the panel lists what fits on the screen, not everything it merged", function () {
  /* All 24 merged headlines used to go into a scrollport that holds eight, so the panel
     always ended on a headline sliced through the middle of its own words and the last
     sixteen were below a fold nobody on a wall ever scrolls past. The merge still keeps
     24 — the ticker rotates through them — but the panel shows the depth a glance from
     3 m can use. */
  var app = h.createApp({});
  var news = app.registry.news;
  news.items = [];
  for (var i = 0; i < 24; i++) {
    news.items.push({ title: "Headline number " + i, at: Date.now() - i * 60000, source: "Test" });
  }
  app.WP.panels.open("news");
  var rows = app.qsa(".news-row", app.panelBody("news"));
  /* SIX. The headline is the value this panel exists to show, so it moved to the value
     tier of the ramp when everything was re-scaled for a 3 m read; six of those fill the
     panel where eight of the old ones left 453 device px of black under the last row. */
  assert.equal(rows.length, 6, "the panel is listing " + rows.length + " headlines");
  assert.match(rows[0].textContent, /Headline number 0/, "the newest is still first");
});
