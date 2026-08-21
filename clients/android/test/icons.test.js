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
  /* EVERY file the pack is drawn in, not the one it started in: the moon body moved to
     wx-icons-moon.js when wx-icons.js hit the line ceiling, and a rule that names one file
     is a rule that stops covering the drawing the moment the drawing is split. */
  var files = fs.readdirSync(h.ASSETS).filter(function (n) { return /^wx-icons/.test(n); });
  assert.ok(files.length >= 2, "the icon pack is one file again — check this list");
  var src = files.map(function (n) { return fs.readFileSync(path.join(h.ASSETS, n), "utf8"); })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false,
    "an icon file hardcodes a hex colour — the palette's one home is style.css");

  var css = h.readAsset("style.css") + h.readAsset("style-theme.css");
  var used = {};
  var m, re = /var\(--ic-([a-z-]+)\)/g;
  while ((m = re.exec(src))) used[m[1]] = true;
  var names = Object.keys(used);
  assert.ok(names.length >= 8, "only " + names.length + " palette tokens used — icons lost their colour");
  names.forEach(function (n) {
    assert.match(css, new RegExp("--ic-" + n + "\\s*:"),
      "the icon pack uses --ic-" + n + " but style.css never defines it");
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

/* ---------------- one sky, one moon ----------------
   The clear-night glyph used to be a fixed crescent at p=0.18 while the Moon tile three
   inches away on the same dashboard reported the real phase — a capture caught a thin
   crescent in the Now card and a half-lit disc in the tile. The icon set now asks whoever
   owns the model, which is wx-moon.js. */

test("the night glyph is drawn at the live phase, not a fixed crescent", function () {
  var terminator = function (svg) {
    /* the second arc of moonPath is the terminator; its rx is the phase, in units of r */
    var m = /A ([\d.]+) [\d.]+ 0 0 [01] [\d.]+ [\d.]+ Z/.exec(svg);
    return m ? parseFloat(m[1]) : null;
  };
  var quarter = wxIcon(0, true);                       /* app.js has wired the real model */
  wxIcon.usePhase(function () { return 0.25; });
  assert.ok(terminator(wxIcon(0, true)) < 0.5, "first quarter should be a straight terminator");
  wxIcon.usePhase(function () { return 0.5; });
  var full = terminator(wxIcon(0, true));
  assert.ok(full > wxIcon.moonR - 1, "full moon should be a whole lit disc, got rx " + full);
  assert.notEqual(wxIcon(0, true), quarter, "the glyph ignored the phase it was handed");
});

test("a new moon still leaves a moon on screen", function () {
  /* Four nights a month the lit limb is under a unit wide. The glyph clamps rather than
     going to a black disc, because "clear night" has to look like something. */
  [0, 0.005, 0.995, 1].forEach(function (p) {
    wxIcon.usePhase(function () { return p; });
    var svg = wxIcon(0, true);
    var m = /A ([\d.]+) [\d.]+ 0 0 [01] [\d.]+ [\d.]+ Z/.exec(svg);
    assert.ok(parseFloat(m[1]) < wxIcon.moonR * 0.99,
      "p=" + p + " drew a fuller moon than it should");
    assert.match(svg, /class="wxi-moon"/, "p=" + p + " lost its moon entirely");
  });
  /* junk from a broken model degrades to a pleasant crescent, never to NaN in a path */
  [NaN, undefined, "banana"].forEach(function (p) {
    wxIcon.usePhase(function () { return p; });
    assert.equal(/NaN|undefined/.test(wxIcon(0, true)), false, "phase " + p + " leaked into the path");
  });
});

test("the night glyph and the Moon tile are the same moon", function () {
  /* Not "the same number formatted twice" — literally the same path, so they cannot drift. */
  wxIcon.usePhase(function () { return 0.62; });
  var icon = /A ([\d.]+) [\d.]+ 0 0 [01] [\d.]+ [\d.]+ Z/.exec(wxIcon(0, true));
  var tile = /A ([\d.]+) [\d.]+ 0 0 [01] [\d.]+ [\d.]+ Z/.exec(wxIcon.moonDisc(0.62));
  /* both are |cos(2*pi*p)| of their own radius, so the ratio is the ratio of the radii */
  assert.ok(Math.abs(parseFloat(icon[1]) / wxIcon.moonR - parseFloat(tile[1]) / 24) < 0.01,
    "the Now card and the Moon tile are drawing different phases");
  wxIcon.usePhase(app.registry.moon.calc ? function (ms) { return app.registry.moon.calc(ms).p; } : null);
});

test("the clear-sky glyphs carry a subject, not a sprinkle", function () {
  /* The pack is judged on INK, not on bounding box: the first sun spanned 42 of 64 units
     but most of that was empty air between eight thin spikes, and the first night moon was
     a crescent of about 8 square units beside clouds of about 790. Both heroes are pinned
     here as a solid disc big enough to hold its own beside a cumulus. */
  function biggestDisc(svg) {
    var r = 0, m, re = /<circle[^>]*\sr="([\d.]+)"[^>]*fill="(?!none)[^"]*"/g;
    while ((m = re.exec(svg))) {
      /* the halo and the bloom are gradients out to url(#…); the body is a solid or a
         disc gradient, and either way it is the shape the eye weighs */
      if (!/halo|starglow|boltglow/.test(m[0])) r = Math.max(r, parseFloat(m[1]));
    }
    return r;
  }
  assert.ok(biggestDisc(wxIcon(0, false)) >= 13.5, "the sun shrank back to a sprinkle");
  assert.ok(biggestDisc(wxIcon(0, true)) >= 18, "the night moon shrank back to a sliver");
});
