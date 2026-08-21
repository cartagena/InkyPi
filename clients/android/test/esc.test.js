/* esc() — everything that reaches innerHTML goes through it. The only genuinely untrusted
   strings on this panel come from a Home Assistant feed, so the escaping is checked both as
   a function and at the place it actually protects. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var esc = h.createApp({}).WP.esc;

test("esc escapes the four characters that break out of markup", function () {
  assert.equal(esc("<script>"), "&lt;script&gt;");
  assert.equal(esc('a "quoted" value'), "a &quot;quoted&quot; value");
  assert.equal(esc("Tom & Jerry"), "Tom &amp; Jerry");
  assert.equal(esc("a > b < c"), "a &gt; b &lt; c");
});

test("esc escapes the ampersand first, so entities cannot be smuggled through", function () {
  /* Escaping < before & would turn "&lt;" into "&amp;lt;" -> renders as "&lt;". Escaping &
     first is what makes the output stable. */
  assert.equal(esc("&lt;img&gt;"), "&amp;lt;img&amp;gt;");
  assert.equal(esc("&amp;"), "&amp;amp;");
});

test("esc survives a double pass without corrupting the text", function () {
  var once = esc('<a href="x">');
  assert.equal(esc(once).replace(/&amp;/g, "&"), once);
});

test("esc turns null and undefined into an empty string, not into words", function () {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(""), "");
  assert.equal(esc(0), "0", "zero is a value, not an absence");
  assert.equal(esc(false), "false");
  assert.equal(esc(NaN), "NaN");
});

test("esc stringifies objects and arrays rather than throwing", function () {
  assert.equal(esc(["a", "b"]), "a,b");
  assert.equal(esc({ toString: function () { return "<x>"; } }), "&lt;x&gt;");
});

test("esc leaves the panel's own glyphs and accented text alone", function () {
  assert.equal(esc("☀ 72° · CO₂"), "☀ 72° · CO₂");
  assert.equal(esc("Café"), "Café");
});

test("a hostile attribute value cannot break out of a generated attribute", function () {
  /* Entity ids land inside data-arg="..." on every sensor tile. */
  var hostile = '" data-open="settings" x="';
  var html = '<button data-arg="' + esc(hostile) + '"></button>';
  var doc = require("./lib/minidom.js").createDocument("<body>" + html + "</body>");
  var btn = doc.querySelector("button");
  assert.equal(btn.getAttribute("data-open"), null, "the value escaped its attribute");
  assert.equal(btn.getAttribute("data-arg"), hostile);
});

test("a hostile unit from a live Home Assistant feed is escaped, not rendered", function () {
  /* unit_of_measurement comes straight off the wire and is written into the tile markup.
     It is the one field on this panel a remote box gets to choose. */
  var cfg = h.defaultConfig();
  cfg.homeAssistant = {
    enabled: true, baseUrl: "http://ha.invalid:8123", token: "t0ken",
    refreshSeconds: 60,
    entities: [{ id: "sensor.hostile", label: "Hostile" }]
  };
  var payload = {
    entity_id: "sensor.hostile",
    state: "21.5",
    attributes: { unit_of_measurement: '"><img src=x onerror="boom()">' }
  };
  var app = h.createApp({
    config: cfg,
    fetch: function () {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(payload); }
      });
    }
  });

  return app.flush().then(function () {
    var box = app.$("sensors");
    assert.equal(box.querySelectorAll("img").length, 0, "markup from the feed was executed");
    assert.match(box.innerHTML, /&lt;img/, "the hostile unit was not escaped");
    /* 22, not 21.5: a live entity whose unit is not a temperature is rounded to whole
       numbers (see the dp rule in wx-sensors) — and this one's "unit" is an injection
       attempt, so it is certainly not a temperature. What matters here is that the real
       reading still reaches the tile at all. */
    assert.match(box.textContent, /Hostile22/, "the real reading should still be shown");
  });
});

test("a hostile entity id cannot smuggle an action onto a tile", function () {
  var cfg = h.defaultConfig();
  cfg.homeAssistant = {
    enabled: true, baseUrl: "http://ha.invalid:8123", token: "t0ken",
    refreshSeconds: 60,
    entities: [{ id: 'switch.x" data-act="reset', label: "Sneaky" }]
  };
  var app = h.createApp({
    config: cfg,
    fetch: function () {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ state: "on", attributes: {} }); }
      });
    }
  });
  return app.flush().then(function () {
    var tile = app.qs("#sensors .sensor");
    assert.ok(tile, "no tile rendered");
    assert.equal(tile.getAttribute("data-act"), "toggle",
      "an entity id rewrote the tile's action");
  });
});
