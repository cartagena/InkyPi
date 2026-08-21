/* WMO code -> coloured SVG icon + words, and the palette discipline that replaced the
   old monochrome-glyph rule.

   History: the icons used to be U+2600-block text glyphs chosen to dodge Android's emoji
   sprites — any emoji-presentation codepoint rendered as a full-colour bitmap the app had
   no say over. The icons are our own SVG now (wx-icons.js), which retires that constraint
   for the WEATHER icons; the rule lives on for the text glyphs that remain (the HA tile
   glyphs, the Device tile, index.html statics), and a new discipline replaces it for the
   SVG: every colour must be a var(--ic-*) token defined in style.css, so the palette has
   exactly one home. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var h = require("./lib/harness.js");

var app = h.createApp({});
var wmo = app.WP.wmo;
var wxIcon = app.WP.wxIcon;

var DOCUMENTED = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
                  71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

/* ---------------- the words ---------------- */

test("every documented WMO code maps to words, unknown degrades to Unknown", function () {
  DOCUMENTED.forEach(function (c) {
    var r = wmo(c, false);
    assert.ok(r.text && r.text !== "Unknown", "code " + c + " has no words");
  });
  [null, undefined, -1, 4, 7, 100, 999, "banana"].forEach(function (code) {
    assert.equal(wmo(code, false).text, "Unknown", "code " + code);
  });
});

/* ---------------- the icons ---------------- */

test("every documented WMO code draws a real icon, day and night", function () {
  DOCUMENTED.forEach(function (c) {
    [false, true].forEach(function (night) {
      var svg = wxIcon(c, night);
      assert.match(svg, /^<svg class="wxi" viewBox="0 0 64 64" aria-hidden="true">/,
        "code " + c + (night ? " night" : " day") + " is not a wxi svg");
      assert.ok(svg.length > 80, "code " + c + " icon is suspiciously empty");
    });
  });
});

test("day/night variants exist exactly where day and night look different", function () {
  /* clear, mostly clear, partly cloudy and the shower families swap sun for moon */
  [0, 1, 2, 80, 81, 85, 86].forEach(function (c) {
    assert.notEqual(wxIcon(c, false), wxIcon(c, true), "code " + c + " should have a night look");
  });
  /* overcast, fog, steady rain and snow look the same at 3am as at 3pm */
  [3, 45, 48, 55, 63, 73, 95].forEach(function (c) {
    assert.equal(wxIcon(c, false), wxIcon(c, true), "code " + c + " grew a pointless variant");
  });
});

test("an unknown code degrades to a placeholder, never to undefined", function () {
  [null, undefined, -1, 4, 100, "banana"].forEach(function (code) {
    var svg = wxIcon(code, false);
    assert.match(svg, /^<svg class="wxi"/, "code " + code);
  });
});

test("condition families share their glyph language", function () {
  /* thunder and heavy showers are the same storm; all steady rain is the same cloud */
  assert.equal(wxIcon(96, false), wxIcon(82, false));
  assert.equal(wxIcon(61, false), wxIcon(63, false));
});

/* ---------------- palette discipline ---------------- */

test("the icons carry no colour of their own — every colour is a style.css token", function () {
  var src = fs.readFileSync(path.join(h.ASSETS, "wx-icons.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false,
    "wx-icons.js hardcodes a hex colour — the palette's one home is style.css");

  var css = h.readAsset("style.css") + h.readAsset("style-theme.css");
  var used = {};
  var m, re = /var\(--ic-([a-z-]+)\)/g;
  while ((m = re.exec(src))) used[m[1]] = true;
  var names = Object.keys(used);
  assert.ok(names.length >= 8, "only " + names.length + " palette tokens used — icons lost their colour");
  names.forEach(function (n) {
    assert.match(css, new RegExp("--ic-" + n + "\\s*:"),
      "wx-icons.js uses --ic-" + n + " but style.css never defines it");
  });
});

test("the moon path really waxes and wanes", function () {
  var mp = wxIcon.moonPath;
  function rx(p) { return parseFloat(mp(32, 32, 24, p).split(" A ")[2]); }
  assert.ok(rx(0.02) > 23, "near-new: terminator hugs the limb");
  assert.ok(rx(0.25) < 0.5, "first quarter: terminator is a straight line");
  assert.ok(rx(0.5) > 23, "full: terminator hugs the far limb");
  assert.ok(rx(0.75) < 0.5, "last quarter");
  /* waxing lights the right limb (outer arc sweep 1), waning the left (sweep 0) */
  assert.match(mp(32, 32, 24, 0.25), /A 24 24 0 0 1/);
  assert.match(mp(32, 32, 24, 0.75), /A 24 24 0 0 0/);
});

/* ---- the monochrome rule, kept for the glyphs that are still font glyphs ----
   Android draws an emoji-presentation codepoint as a full-colour sprite. Unicode's own
   Emoji_Presentation property is not the right oracle (it says "No" for U+26C8, which
   this device rendered in colour anyway), so the rule is an allowlist of codepoints
   actually verified monochrome on the panel — anything else must carry U+FE0E. */
var VERIFIED_MONOCHROME = new Set([
  0x00a0, 0x00b0, 0x00b7, 0x00d7, 0x2013, 0x2014, 0x2026,
  0x2039, 0x203a, 0x2190, 0x2191, 0x2192, 0x2212, 0x2248,
  0x2302, 0x21af, 0x25ad, 0x25ae, 0x25af, 0x25c6, 0x25c7, 0x25cb, 0x25cf,
  0x2600, 0x2601, 0x2602, 0x263d, 0x263e, 0x2699, 0x2715, 0x2744,
  0xfe0e
]);

function offendingCodepoints(s) {
  var bad = [];
  var chars = Array.from(String(s));
  chars.forEach(function (ch, i) {
    var cp = ch.codePointAt(0);
    if (cp < 0x80 || VERIFIED_MONOCHROME.has(cp)) return;
    if (chars[i + 1] === "︎") return;      // text-presentation selector: fine
    bad.push("U+" + cp.toString(16).toUpperCase());
  });
  return bad;
}

test("the monochrome check actually rejects a colour glyph", function () {
  /* Without this, an allowlist that silently matched everything would look like a pass. */
  assert.deepEqual(offendingCodepoints("⚡"), ["U+26A1"]);
  assert.deepEqual(offendingCodepoints("💡"), ["U+1F4A1"]);
  assert.deepEqual(offendingCodepoints("🌡"), ["U+1F321"]);
  assert.deepEqual(offendingCodepoints("⚡︎"), [], "VS15 makes it text-presentation");
  assert.deepEqual(offendingCodepoints("☀ 72° · ok"), []);
});

test("every Home Assistant tile glyph is text-presentation", function () {
  /* Length guard: a forEach over an empty array passes without asserting anything. */
  assert.ok(app.registry.sensors.demoDefs.length >= 6,
    "demoDefs shrank to " + app.registry.sensors.demoDefs.length + " — this test asserts nothing");
  app.registry.sensors.demoDefs.forEach(function (def) {
    assert.deepEqual(offendingCodepoints(def.icon), [], def.id + " icon");
    if (def.iconOff) {
      assert.deepEqual(offendingCodepoints(def.iconOff), [], def.id + " iconOff");
    }
  });
});

test("switch-like entities carry a distinct off glyph", function () {
  /* A lamp that was off used to draw the same lit bulb as a lamp that was on. */
  var switchy = app.registry.sensors.demoDefs.filter(function (def) {
    return def.kind === "toggle" || def.kind === "binary";
  });
  assert.ok(switchy.length >= 3, "only " + switchy.length + " two-state demo entities");
  assert.ok(switchy.some(function (d) { return d.kind === "toggle"; }), "no toggle entity");
  assert.ok(switchy.some(function (d) { return d.kind === "binary"; }), "no binary entity");
  switchy.forEach(function (def) {
    assert.ok(def.iconOff, def.id + " has no off glyph");
    assert.notEqual(def.iconOff, def.icon, def.id + " uses one glyph for both states");
  });
});

test("no static glyph in index.html would render in colour", function () {
  /* Entity-decoded, because the file writes most of its glyphs as &#9881; and friends. */
  var html = require("./lib/minidom.js").decodeEntities(h.readAsset("index.html"));
  var bad = offendingCodepoints(html);
  assert.deepEqual(bad, [], "index.html contains colour codepoints: " + bad.join(", "));
});

test("the Device tile's charging and battery glyphs are monochrome", function () {
  /* "↯" (U+21AF), not "⚡" (U+26A1) — the latter drew a colour sprite in the tile row. */
  var bridge = require("./lib/fake-bridge.js");
  var charged = h.createApp({ bridge: bridge.make({ charging: true }) });
  assert.deepEqual(offendingCodepoints(charged.text("sys-big")), []);
  charged.WP.panels.open("system");
  assert.deepEqual(offendingCodepoints(charged.panelBody("system").textContent), []);
});
