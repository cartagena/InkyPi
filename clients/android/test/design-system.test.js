/* The design system: the type ramp, the one-idiom-per-concept rule, the label recipe, the
   touch-target floor and the accessible names on generated controls.

   These are the properties that make eight panels read as one app, and every one of them is
   the kind of thing that decays by accident — somebody needs a size "just a bit bigger" and
   authors a literal, or adds a boolean as a pair of buttons because the pair above it was
   one. None of it is visible in a screenshot of a single panel, which is exactly why it is
   asserted here instead of eyeballed.

   The conversion used throughout: this panel is a 711 x 1138 CSS px portrait viewport at
   devicePixelRatio 2.25, so 1vh = 11.38 CSS px = 25.6 device px, and the spec's 88 device
   px minimum touch target is 3.44vh. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var CSS = ["style.css", "style-home.css", "style-panels.css", "style-widgets.css",
           "style-theme.css"]
  .map(h.readAsset).join("\n");
var HTML = h.readAsset("index.html");
var VIEW_JS = h.readAsset("app-view.js");
/* every widget file, concatenated — the rule below is about the whole widget layer, and
   reading the directory means a new wx-*.js is covered the day it is added */
var WIDGETS_JS = require("node:fs").readdirSync(h.ASSETS)
  .filter(function (n) { return /^wx-.*\.js$/.test(n); })
  .map(function (n) { return h.readAsset(n); })
  .join("\n");

var DEVICE_PX_PER_VH = 25.6;
var MIN_TARGET_VH = 88 / DEVICE_PX_PER_VH;      // 3.44vh

/* ---------------- helpers over the stylesheet ----------------
   The reading is done by test/lib/css.js — a flat rule list, a token resolver and a small
   box model, all over the AUTHORED text, which is the thing under test. It lives in lib
   rather than here because the box model is what lets the touch-target check derive its
   subject list from the DOM instead of from a hand-written allowlist. */

var css = require("./lib/css.js");
var stripComments = css.stripComments;
var decl = css.decl;
function rules() { return css.rules(); }
var ramp = css.ramp;

/* The rule for `sel`. A selector legitimately appears more than once — .psec-t takes its
   type from the shared label recipe and its margin from the panel-content block — so when
   a property is named, the rule that actually declares it is the one wanted. */
function ruleFor(sel, prop) {
  var r = rules().filter(function (x) {
    return x.sel === sel && (!prop || decl(x.body, prop) != null);
  });
  assert.equal(r.length >= 1, true, "no rule for " + sel + (prop ? " setting " + prop : ""));
  return r[r.length - 1];
}

test("the type ramp is declared once, in vh, and is strictly increasing", function () {
  var r = ramp();
  var order = ["fs-caption", "fs-label", "fs-note", "fs-body", "fs-body-lg",
               "fs-title-sm", "fs-title", "fs-title-lg", "fs-hero", "fs-display",
               "fs-display-xl"];
  order.forEach(function (k) {
    assert.equal(typeof r[k], "number", "the ramp has no --" + k);
  });
  assert.equal(Object.keys(r).length, order.length,
    "the ramp gained or lost a step: " + Object.keys(r).join(", "));
  for (var i = 1; i < order.length; i++) {
    assert.ok(r[order[i]] > r[order[i - 1]],
      order[i] + " (" + r[order[i]] + ") is not larger than " + order[i - 1]);
  }
});

test("the text tiers step by a consistent ratio — no tier is a rounding error", function () {
  /* Two tiers a hair apart are not a hierarchy. The five text tiers were 1.5 / 1.6 / 1.65 /
     1.7 vh before this, i.e. four "different" sizes inside 0.2vh, which is 5 device px. */
  var r = ramp();
  var text = ["fs-caption", "fs-label", "fs-note", "fs-body", "fs-body-lg",
              "fs-title-sm", "fs-title", "fs-title-lg"];
  for (var i = 1; i < text.length; i++) {
    var ratio = r[text[i]] / r[text[i - 1]];
    assert.ok(ratio > 1.1 && ratio < 1.25,
      text[i - 1] + " -> " + text[i] + " is a ratio of " + ratio.toFixed(3)
      + "; the ramp is meant to step by ~1.16");
  }
});

test("no font-size anywhere is authored as a literal", function () {
  /* The single rule that keeps the ramp real. Every size must come from a token, so that
     changing a tier changes it everywhere and adding a size means choosing a step. */
  var offenders = rules().filter(function (r) {
    if (/^:root/.test(r.sel)) return false;              // the ramp itself
    var v = decl(r.body, "font-size");
    return v && v.indexOf("var(--fs-") === -1;
  });
  assert.deepEqual(offenders.map(function (r) {
    return r.sel + " { font-size: " + decl(r.body, "font-size") + " }";
  }), []);
});

test("neither the markup nor the widgets author any size of their own", function () {
  assert.equal(/font-size/.test(HTML), false, "index.html sets a font-size inline");
  assert.equal(/font-size/.test(stripComments(WIDGETS_JS)), false,
    "widgets.js emits a font-size; a widget picks a CLASS, never a size");
});

test("landscape restates the whole ramp rather than overriding elements piecemeal", function () {
  /* The old landscape block hand-tuned nine elements at nine different multipliers (.time
     2.2x, .wx-temp 2.1x, .big-icon 1.5x), which is a second, inconsistent design system for
     an orientation nobody looks at. */
  var land = /@media \(orientation: landscape\)\s*\{([\s\S]*)$/.exec(stripComments(CSS));
  assert.ok(land, "no landscape block");
  var names = Object.keys(ramp());
  names.forEach(function (k) {
    assert.match(land[1], new RegExp("--" + k + "\\s*:"),
      "landscape does not restate --" + k);
  });
  assert.equal(/font-size/.test(land[1]), false,
    "landscape still overrides a font-size directly");
});

test("the landscape ramp is a RAMP, not ten restatements of one number", function () {
  /* The test above only asks that every token is mentioned again, and a mutation that set
     all ten landscape steps to the same 2.0vh passed it: the hierarchy was gone —
     the clock, a chip and a caption all the same size — while the suite stayed green.
     Restating a token is not the property; being a scale is. Both scales are therefore
     asserted the same way, and the landscape one has to be larger, since the whole reason
     the block exists is that a landscape viewport is short. */
  var portrait = ramp(), land = css.landscapeRamp();
  var order = ["fs-caption", "fs-label", "fs-note", "fs-body", "fs-body-lg",
               "fs-title-sm", "fs-title", "fs-title-lg", "fs-hero", "fs-display",
               "fs-display-xl"];
  order.forEach(function (k) {
    assert.equal(typeof land[k], "number", "the landscape ramp has no --" + k);
    assert.ok(land[k] > portrait[k],
      "--" + k + " is " + land[k] + "vh in landscape and " + portrait[k] + "vh in portrait;"
      + " a shorter viewport needs a larger vh for the same physical size");
  });
  for (var i = 1; i < order.length; i++) {
    assert.ok(land[order[i]] > land[order[i - 1]],
      "landscape --" + order[i] + " (" + land[order[i]] + ") is not larger than --"
      + order[i - 1] + " (" + land[order[i - 1]] + ")");
  }
  /* and the text tiers keep the same ~1.16 relationship they have in portrait */
  for (var j = 1; j < 8; j++) {
    var ratio = land[order[j]] / land[order[j - 1]];
    assert.ok(ratio > 1.1 && ratio < 1.25,
      "landscape " + order[j - 1] + " -> " + order[j] + " is a ratio of " + ratio.toFixed(3));
  }
});

/* ---------------- the label recipe (D6) ---------------- */

test("every small-caps label is drawn from one recipe", function () {
  /* UNITS in Settings, AIR in Conditions, BATTERY in Device and NOW on the home card have
     to be the same object. They were authored separately and had drifted to five sizes,
     four letter-spacings and two weights. */
  var recipe = rules().filter(function (r) {
    return r.sel.indexOf(".psec-t,") === 0 && /text-transform/.test(r.body);
  })[0];
  assert.ok(recipe, "the shared label rule is gone");
  [".card-label", ".mini-head", ".stat-k", ".fc-name", ".hr-t", ".wc-city"].forEach(function (s) {
    assert.ok(recipe.sel.indexOf(s) !== -1, s + " is no longer on the shared label rule");
  });
  assert.equal(decl(recipe.body, "letter-spacing"), "var(--label-track)");
  assert.equal(decl(recipe.body, "font-weight"), "var(--label-weight)");
  assert.equal(decl(recipe.body, "text-transform"), "uppercase");

  /* The tokens' VALUES, not just the fact that they are referenced. A mutation that set
     --label-track to 0em and --label-weight to 900 survived every assertion above: the
     recipe was still one recipe, still referenced, still uppercase — and every label in
     the app had become bold, tightly-set capitals, which is a different design. Ranges
     rather than exact numbers, because the point is the look and not the digit: tracking
     is what makes capitals legible at 2-4 m, and a light weight is what stops a wall of
     small caps shouting. */
  var root = /:root\s*\{([\s\S]*?)\}/.exec(stripComments(CSS))[1];
  var track = parseFloat(/--label-track:\s*([\d.]+)em/.exec(root)[1]);
  var weight = parseInt(/--label-weight:\s*(\d+)/.exec(root)[1], 10);
  assert.ok(track >= 0.1 && track <= 0.25,
    "--label-track is " + track + "em; small caps without tracking read as a smudge");
  assert.ok(weight >= 400 && weight <= 600,
    "--label-weight is " + weight + "; a label is not meant to outweigh its own value");

  /* and nothing re-declares those properties for itself afterwards */
  var strays = rules().filter(function (r) {
    if (r.sel === recipe.sel) return false;
    return /(^|,\s*)\.(card-label|mini-head|stat-k|fc-name|hr-t|wc-city)\b/.test(r.sel)
      && (decl(r.body, "letter-spacing") || decl(r.body, "text-transform"));
  });
  assert.deepEqual(strays.map(function (r) { return r.sel; }), []);
});

test("a section heading outranks the field labels under it", function () {
  /* .psec-t was 1.7vh and .stat-k 1.6vh, both --dimmer: a 0.1vh difference is not a
     hierarchy, and the Conditions panel read as one flat wall of small caps. The heading
     then moved to --fs-note and the field label stayed put, which fixed the heading and
     left the tier that carries the meaning at the bottom of the ramp. Then BOTH moved up
     one step — and that was the trap: --fs-body over --fs-note at the same --dim is a 14%
     size step and no colour step at all, so cropped from the Conditions panel AIR and
     HUMIDITY were indistinguishable as tiers, and the page read as grey / grey / white
     repeated nine times.

     So the property is no longer "the heading is one token higher". It is that the two
     tiers differ on BOTH available axes at once: a full ramp step in size AND a full step
     in the grey scale. Either one alone is what produced the flat wall, twice. */
  var r = ramp();
  var psec = ruleFor(".psec-t", "font-size");
  var statk = ruleFor(".stat-k", "font-size");

  var headVh = css.vh(decl(psec.body, "font-size"));
  var labelVh = css.vh(decl(statk.body, "font-size"));
  assert.ok(headVh / labelVh >= 1.15,
    "a section heading is " + headVh + "vh over a field label's " + labelVh
    + "vh — a ratio of " + (headVh / labelVh).toFixed(3) + "; under a whole ramp step "
    + "the two tiers read as one");

  assert.equal(decl(psec.body, "color"), "var(--dim)", "a section heading is --dim");
  assert.equal(decl(statk.body, "color"), "var(--dimmer)",
    "a field label must be a shade BELOW its own heading — at --dim they were the same "
    + "object at two sizes, and the wider word won");
  assert.ok(r["fs-title"] > headVh,
    "a section heading has reached the panel TITLE size; the screen's name has to outrank "
    + "the names of the blocks on it");
});

test("a panel's field label is legible from across the room", function () {
  /* The property, not the token: a field label is what tells you whether 29.91 is a
     pressure or a price, and at 1.6vh / --dimmer it measured ~41 device px at 4.9:1 — the
     smallest step in the ramp at the lowest contrast in the palette, which at 2-4 m is
     not small, it is absent. It was then raised by 2.9 CSS px, to 3.7 arcminutes, which is
     still under the 5' that 20/20 acuity resolves — a 16% bump where the diagnosis called
     for 75%. Stating the floor in vh is what let that happen twice, because a vh number
     does not say whether anybody can read it. It is stated in ARCMINUTES AT 3 M now, which
     is the only form of this assertion that has an answer. */
  var statk = ruleFor(".stat-k", "font-size");
  var a = css.arcmin(css.vh(decl(statk.body, "font-size")));
  /* 5.0, not 4.8. The floor was written one notch under the number it names, so the tier
     could sit at 4.95' — under acuity — with the suite green and the comment still saying
     "20/20 resolves 5'". A floor that is not the number in its own sentence is a floor
     somebody rounded down. --fs-body-lg moved 2.45 -> 2.5vh to land on the right side of
     it, which also evened out the ramp; see the ratio note in style.css. */
  assert.ok(a >= 5.0,
    "a field label subtends " + a.toFixed(1) + "' of cap height at 3 m; 20/20 acuity "
    + "resolves 5', so anything under that is not small print, it is a blank");
});

test("a panel's VALUE is a size you read, not a size you resolve", function () {
  /* The single number that capped the whole build: every value on all twelve panels was
     --fs-title-sm = 33 CSS px = 5.9 arcminutes at 3 m, i.e. sitting ON the 20/20 threshold.
     The home clock is 15.3' and the home hero 10.5', which is exactly why those two were
     the only things in the app anybody could read from the sofa, and why the panels were
     screens you walked to. A value is the thing its screen exists to say; it gets the
     reading size, and the floor is stated where the eye is rather than where the
     stylesheet is. */
  [".stat-v", ".wc-time"].forEach(function (sel) {
    var a = css.arcmin(css.vh(decl(ruleFor(sel, "font-size").body, "font-size")));
    assert.ok(a >= 7.5,
      sel + " subtends " + a.toFixed(1) + "' at 3 m; a value tier wants 8' or better");
  });
  /* and it stays a rung of the same ladder, not a size somebody typed */
  assert.equal(decl(ruleFor(".stat-v", "font-size").body, "font-size"), "var(--fs-title-lg)");
});

test("a chart's annotations are sized like the chart, not like a footnote", function () {
  /* A y-axis number, an x tick and a peak callout are not decoration ON a chart, they are
     what makes the chart's height mean anything: without them whatever the line does reads
     as what happened. Every one of them in the build was at --fs-caption — 2.8 arcminutes
     at 3 m, under the threshold at which a glyph resolves — including three that were built
     that way by the round which had just diagnosed exactly that fault.

     THE FLOOR IS 5.0, and the history of this number is the reason it is written down.
     The round that moved these off the ramp's floor moved them to --fs-note, measured the
     result at 3.61', and wrote the assertion as `a >= 3.6` — so the suite certified as
     passing the exact class of mark it had been written to catch, and the `93°` peak on the
     Hourly chart, the one number that chart exists to deliver, was the least legible thing
     on its own screen. A floor set below the acuity threshold is not a floor; it is a
     record of what happened to be there.

     5.0' is what 20/20 resolves and what every other tier in this file is held to. There is
     no tier in this build that is allowed to be unreadable, and a chart is the LAST place
     to put one, because a chart with unreadable numbers is a picture.

     A chart is also the one place where "it did not fit" is not an argument: if the
     annotation will not fit, the chart is too small or has too many bars, and both of those
     are the chart's problem to solve. It was solved that way — the Hourly and Daily axes
     carry six labels each instead of eight, and nothing was shrunk to make room. */
  [".plot-hi, .plot-lo", ".plot-x", ".hc-ticks span", ".hc-hi, .hc-lo",
   ".daybar-v", ".daybar-t"]
    .forEach(function (sel) {
      var a = css.arcmin(css.vh(decl(ruleFor(sel, "font-size").body, "font-size")));
      assert.ok(a >= 5.0,
        sel + " subtends " + a.toFixed(1) + "' at 3 m; 20/20 acuity resolves 5', so a chart "
        + "annotation under that is a chart with no numbers on it");
    });
});

test("no field label is wider than the column it has to fit in", function () {
  /* The bug this is for, and the reason it is a SWEEP over the rendered DOM rather than an
     assertion about the Clock panel: re-scaling the label tier made `DAY OF YEAR` too wide
     for its third of a three-column grid, so it wrapped, so its value landed ~90 device px
     below the two values beside it, so the TODAY row had three baselines and stopped being
     a row. Nothing equalises that — a stat grid is independent cells, each stacking its own
     label over its own value — and nothing in the suite could see it, because the fault was
     a WIDTH and every legibility assertion here is about heights.

     `white-space: nowrap` on .stat-k means the next one overhangs instead of moving a
     number, which is visible and local. This is the budget that stops it happening at all,
     and it is arithmetic rather than taste: a cell in a three-column grid is ~212 CSS px in
     portrait; the label recipe is uppercase at --fs-body-lg with 0.16em of tracking, so an
     upper-case advance is about 0.78em = 22 px, and 212 / 22 is nine characters. A space is
     narrower than a letter, so counting every character is the conservative form.

     The class of bug is "a bigger ramp breaks what used to fit", and it will come back the
     next time a tier moves. When it does, this fails on the label rather than on the wall. */
  var LIMIT = { 2: 14, 3: 9 };          // 2-col cells are ~324 px, 3-col ~212
  /* WITH DATA, or this sweeps four empty panels and reports nothing: Conditions, Hourly,
     Daily and Air only build their grids once a payload lands, and Device only with a
     bridge. The Clock panel that shipped the wrap would have been caught either way; the
     next one might be on Conditions. */
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();
  app.registry.air.data = wx.aqi({ now: app.clock.now });
  /* the picture widgets render an IMAGE; seed one so their panels are not the no-shell
     fallback during the sweep */
  app.registry.paper.uri = "data:image/jpeg;base64,AAAA";
  app.registry.paper.shownDay = new Date(app.clock.now).getDate();
  app.registry.gallery.slots.xkcd = { uri: "data:image/png;base64,AAAA",
    title: "Sweep fixture", note: "alt text for the sweep", at: app.clock.now };
  app.registry.gallery.cur = "xkcd";
  var over = [];
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    app.qsa(".stat-grid", p).forEach(function (g) {
      var cols = /cols3/.test(g.getAttribute("class") || "") ? 3 : 2;
      app.qsa(".stat-k", g).forEach(function (k) {
        var t = (k.textContent || "").trim();
        if (t.length > LIMIT[cols]) {
          over.push(name + " " + cols + "-col: " + JSON.stringify(t)
            + " is " + t.length + " chars, budget " + LIMIT[cols]);
        }
      });
    });
    app.WP.panels.close();
  });
  assert.deepEqual(over, []);
});

test("nothing is drawn at the ramp's floor AND the palette's floor", function () {
  /* THE BAN. --fs-caption at --dimmer is 15.9 CSS px at 4.9:1 = 2.8' at 3 m — under the
     threshold at which the eye resolves a glyph at all. The round that first diagnosed
     "smallest size AND lowest contrast = gone" then built the sensor chart's new y-axis,
     the daily panel's hour ticks and the ug/m3 units at precisely that spec, because the
     diagnosis lived in a comment and nothing in the suite could see it. A chart's axis
     numbers ARE the chart — they are what makes its height mean anything — so this is
     enforced over the RENDERED DOM of every screen rather than over a list of selectors
     somebody has to remember to extend.

     Where the width genuinely cannot pay (five Home Assistant tiles across a 711 px card,
     24 hour bars across a panel) the size stays and the contrast gives: --fs-caption at
     --dim is allowed, and --dimmer at any larger step is allowed. It is the PAIR that is
     the blank. */
  var app = h.createApp({});
  var offenders = [];
  function sweep(root, where) {
    app.qsa("*", root).forEach(function (el) {
      if (css.inherited(el, "font-size") !== "var(--fs-caption)") return;
      if (css.inherited(el, "color") !== "var(--dimmer)") return;
      offenders.push(where + ": " + (el.getAttribute("class") || el.tagName)
        + " " + JSON.stringify((el.textContent || "").slice(0, 24)));
    });
  }
  sweep(app.doc, "home");
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    sweep(p, name);
    app.WP.panels.close();
  });
  assert.deepEqual(offenders, []);
});

/* ---------------- one idiom per concept (D1) ---------------- */

test("Settings uses paired buttons only for a genuine two-value choice", function () {
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var panel = app.qs('[data-panel="settings"]');

  var segs = panel.querySelectorAll(".seg");
  var acts = segs.map(function (s) {
    return s.querySelector("[data-act]").getAttribute("data-act");
  }).sort();
  assert.deepEqual(acts, ["hours", "units"],
    "a boolean came back as a pair of buttons: " + acts.join(", "));
});

test("every on/off in Settings is the same switch row", function () {
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var panel = app.qs('[data-panel="settings"]');

  var rows = panel.querySelectorAll(".srow");
  var acts = rows.map(function (r) { return r.getAttribute("data-act"); });
  /* seconds, burn-in, and one per widget */
  assert.equal(acts.filter(function (a) { return a === "secs"; }).length, 1);
  assert.equal(acts.filter(function (a) { return a === "burn"; }).length, 1);
  assert.equal(acts.filter(function (a) { return a === "widget"; }).length,
    app.WP.WIDGETS.length);

  rows.forEach(function (r) {
    assert.equal(r.getAttribute("role"), "switch", r.getAttribute("data-act") + " row");
    assert.match(r.getAttribute("aria-checked") || "", /^(true|false)$/);
    assert.ok(r.querySelector(".switch"), "a switch row with no switch in it");
  });
});

test("a switch row's aria-checked follows the setting it controls", function () {
  var app = h.createApp({});
  app.WP.panels.open("settings");
  function row(act, arg) {
    return app.qs('[data-panel="settings"] [data-act="' + act + '"]'
      + (arg ? '[data-arg="' + arg + '"]' : ""));
  }
  assert.equal(row("secs").getAttribute("aria-checked"), "false");
  app.tap(row("secs"));
  assert.equal(app.WP.settings.get("seconds"), true, "the row did not toggle the setting");
  assert.equal(row("secs").getAttribute("aria-checked"), "true");
  assert.ok(row("secs").querySelector(".switch").classList.contains("on"));

  /* tapping again toggles back — a switch is not a one-way button */
  app.tap(row("secs"));
  assert.equal(app.WP.settings.get("seconds"), false);
  assert.equal(row("secs").getAttribute("aria-checked"), "false");

  assert.equal(row("widget", "daily").getAttribute("aria-checked"), "true");
  app.tap(row("widget", "daily"));
  assert.equal(app.WP.settings.get("show").daily, false);
  assert.equal(row("widget", "daily").getAttribute("aria-checked"), "false");
});

test("burn-in protection is explained in one line, not a paragraph", function () {
  /* D5. It was five lines of body copy on a settings screen; the long version lives in
     INTERACTIVE.md. The switch's own note is the only prose allowed here. */
  var app = h.createApp({});
  app.WP.panels.open("settings");
  var burn = app.qs('[data-panel="settings"] [data-act="burn"]');
  var note = burn.querySelector(".srow-x");
  assert.ok(note, "the burn-in switch lost its one-line reason");
  assert.ok(note.textContent.length < 90,
    "the burn-in note is " + note.textContent.length + " characters: " + note.textContent);
  var sec = app.qsa('[data-panel="settings"] .psec').filter(function (s) {
    return s.querySelector(".psec-t").textContent === "Display";
  })[0];
  assert.equal(sec.querySelectorAll(".muted").length, 0,
    "the burn-in paragraph is back");
});

/* ---------------- developer language (D4) ----------------

   This used to read [data-sub] and nothing else, which is why it passed for five rounds
   while the wall itself carried `sensor.living_room_temperature` twice, `UNIX TIME
   1786999387`, `DOMAIN / SOURCE / SAMPLES`, `screen 711 × 1138` and `Interface wlan0`. A
   subtitle is one line out of a few hundred; the rest of the panel is what a person reads.

   So it sweeps every rendered string in the home view and in all eight panel bodies.

   Text is collected as individual LEAF TEXT NODES, not as textContent: concatenating a
   panel gives you "Samples241Entity", which destroys the word boundaries these patterns
   depend on and hides an offender inside a run of digits.

   Each pattern is something no one standing in front of a wall panel would say. It is
   deliberately not a list of banned words: a Device panel may legitimately report a screen
   size and an Android version, so what is banned is naming the MACHINERY (an entity id, a
   kernel interface name, an epoch counter, a CSS viewport) rather than naming a fact. */

var JARGON = [
  ["names where a setting is stored", /localStorage|force-stop|\bconfig\.js\b|\bassets\//i],
  ["a URL, an origin or a credential", /https?:\/\/|baseUrl|API key|\bbearer\b|\btoken\b/i],
  ["a raw Home Assistant entity id",
   /\b(sensor|switch|light|fan|binary_sensor|climate|cover|lock|media_player)\.[a-z0-9_]+/],
  ["the machinery behind a reading",
   /\bentity[ _]?id\b|\bdomain\b|\bsamples?\b|\bsimulator\b|\bpayload\b|\bendpoint\b/i],
  ["a clock only a computer reads", /\bunix\b|\bepoch\b|\bISO ?8601\b|\bmillis(econds)?\b/i],
  ["a rendering detail rather than a fact about the room",
   /\bviewport\b|\bdpr\b|\bdevice ?pixel|\bcss px\b|\bscreen \d+\s*[×x]\s*\d+/i],
  ["an internal interface", /\bREST\b|\bJSON\b|\bAPI\b|\bJNI\b|\bbridge\b|\b(wlan|eth)\d\b/i],
  ["a JavaScript value that escaped onto the wall", /\b(undefined|NaN|\[object)\b/]
];

/* every leaf string under `root`, trimmed, empties dropped */
function strings(root) {
  var out = [];
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.nodeType === 3) { var s = c.data.trim(); if (s) out.push(s); return; }
      walk(c);
    });
  })(root);
  return out;
}

test("nothing the wall says is written for whoever built the app", function () {
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();
  app.registry.air.data = wx.aqi({ now: app.clock.now });
  /* the picture widgets render an IMAGE; seed one so their panels are not the no-shell
     fallback during the sweep */
  app.registry.paper.uri = "data:image/jpeg;base64,AAAA";
  app.registry.paper.shownDay = new Date(app.clock.now).getDate();
  app.registry.gallery.slots.xkcd = { uri: "data:image/png;base64,AAAA",
    title: "Sweep fixture", note: "alt text for the sweep", at: app.clock.now };
  app.registry.gallery.cur = "xkcd";

  var offenders = [];
  function sweep(where, label) {
    strings(where).forEach(function (s) {
      JARGON.forEach(function (rule) {
        if (rule[1].test(s)) offenders.push(label + ": “" + s + "” — " + rule[0]);
      });
    });
  }

  sweep(app.$("home"), "home");
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    sweep(p.querySelector("[data-sub]"), name + " subtitle");
    sweep(app.panelBody(name), name);
    app.WP.panels.close();
  });
  assert.deepEqual(offenders, []);
});

test("the copy sweep can actually see a panel body", function () {
  /* The failure this test exists to prevent is the previous one's: a sweep pointed at a
     node that is empty passes forever. Assert the corpus is real, and that the patterns
     fire when something bad is genuinely in it. */
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();
  app.registry.air.data = wx.aqi({ now: app.clock.now });
  /* the picture widgets render an IMAGE; seed one so their panels are not the no-shell
     fallback during the sweep */
  app.registry.paper.uri = "data:image/jpeg;base64,AAAA";
  app.registry.paper.shownDay = new Date(app.clock.now).getDate();
  app.registry.gallery.slots.xkcd = { uri: "data:image/png;base64,AAAA",
    title: "Sweep fixture", note: "alt text for the sweep", at: app.clock.now };
  app.registry.gallery.cur = "xkcd";
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    /* Paper and Picture are IMAGES with at most a caption: five text nodes is the wrong
       bar for a screen whose content is a photograph. The rendered picture standing in
       the body is the proof the sweep reached it. */
    var pictured = app.panelBody(name).querySelectorAll(".page-img").length > 0;
    assert.ok(strings(app.panelBody(name)).length >= 5 || pictured,
      name + " panel body yielded almost no text — the sweep is reading the wrong node");
    app.WP.panels.close();
  });

  [["sensor.living_room_temperature", 2], ["Unix time", 4], ["Samples", 3],
   ["screen 711 × 1138", 5], ["Interface wlan0", 6], ["saved to localStorage", 0]
  ].forEach(function (probe) {
    assert.equal(JARGON[probe[1]][1].test(probe[0]), true,
      "the sweep would no longer catch: " + probe[0]);
  });
});

/* ---------------- the home tile row (D8) ---------------- */

test("the three home tiles are one object repeated", function () {
  var app = h.createApp({});
  var tiles = app.qsa("#home .row3 .card.mini");
  assert.equal(tiles.length, 7);   // device/timer/setup + moon/air/paper/picture
  var shape = tiles.map(function (t) {
    return t.children.filter(function (c) { return c.nodeType === 1; })
      .map(function (c) { return c.getAttribute("class").split(" ")[0]; }).join(",");
  });
  assert.deepEqual(shape, shape.map(function () { return shape[0]; }),
    "the tiles do not have the same three lines: " + shape.join(" | "));
  assert.equal(shape[0], "mini-head,mini-big,mini-sub");

  /* the value line's BOX is pinned, so the third line sits on one baseline across all six
     whatever the value happens to be */
  var big = ruleFor(".mini-big", "height");
  assert.match(decl(big.body, "height") || "", /calc\(var\(--fs-title-sm\)/);

  /* And every one of the six value lines carries a VALUE. The Setup tile used to put a gear
     glyph here — decorative, aria-hidden, in the one row of the home screen the eye scans
     as a strip of numbers, and directly under a heading that already said "Setup". Five
     tiles answered "what is it now" and the sixth answered "what am I". */
  tiles.forEach(function (t) {
    var v = t.querySelector(".mini-big");
    assert.equal(v.getAttribute("aria-hidden"), null,
      t.querySelector(".mini-head").textContent + "'s value line is decorative");
    assert.equal((v.getAttribute("class") || "").indexOf("glyph"), -1,
      t.querySelector(".mini-head").textContent + " is back to a glyph where a value goes");
  });
});

/* ---------------- motion (D7) ---------------- */

test("every duration in the app comes from a motion token", function () {
  /* ANIMATION as well as TRANSITION. This read `transition:` only, and the stylesheet had
     three `animation: pulse 1s infinite` declarations sitting off the token scale — so the
     comment beside the tokens ("nothing in the app animates on a number that is not one of
     these") was false, and a mutation moving the alert pulse to 3.7s passed. A duration is
     a duration whichever property carries it. */
  var offenders = [];
  rules().forEach(function (r) {
    ["transition", "animation", "animation-duration", "transition-duration"].forEach(function (prop) {
      var t = decl(r.body, prop);
      if (!t) return;
      (t.match(/(^|\s)[\d.]+m?s\b/g) || []).forEach(function (lit) {
        offenders.push(r.sel + " { " + prop + ": ..." + lit.trim() + "... }");
      });
    });
  });
  assert.deepEqual(offenders, []);
  ["--ease", "--dur-press", "--dur-ui", "--dur-fill", "--dur-drift", "--dur-pulse"]
    .forEach(function (k) {
      assert.match(CSS, new RegExp(k + "\\s*:"), "no " + k + " token");
    });
  /* and the pulse is still a breath rather than a blink */
  assert.match(stripComments(CSS), /--dur-pulse:\s*(0\.[6-9]|1(\.[0-5])?)s/);
});

test("the switch knob slides and the panel fade is unchanged", function () {
  /* "switches animate their knob rather than snapping" — the knob moves by transform, and
     a transform with no transition is a snap. */
  var knob = ruleFor(".switch span", "transition");
  assert.match(decl(knob.body, "transition") || "", /transform var\(--dur-ui\)/);
  assert.match(decl(ruleFor(".sensor-sw span", "transition").body, "transition") || "",
    /transform var\(--dur-ui\)/);
  /* the 200ms panel entrance is a do-not-regress item, so pin the token's value too */
  assert.match(stripComments(CSS), /--dur-ui:\s*0\.2s/);
  assert.match(stripComments(CSS), /--dur-drift:\s*4s/);
});

test("every tappable class has a pressed state on the press clock", function () {
  var press = ruleFor(".tappable.is-press", "transform");
  assert.ok(decl(press.body, "background-color"), "no pressed fill");
  assert.ok(decl(press.body, "transform"), "no pressed movement");
  assert.match(decl(ruleFor(".tappable", "transition").body, "transition") || "", /var\(--dur-press\)/);
});

/* ---------------- touch targets ----------------

   The subject list is taken from the DOM — every distinct class carrying `.tappable`,
   anywhere in the home view or in any of the eight panels — and not from an allowlist.
   The allowlist named eight selectors and the app has thirteen kinds of control; the five
   it did not name included the Home Assistant tile and the hourly chip, and a mutation
   that drove the tile's padding to zero passed. A list maintained by hand goes stale the
   first time a widget gains a control; this one cannot. */

/* Boot everything so that every kind of control is on screen at least once: the bridge for
   the Device panel and a forecast for the strip, the hourly list and the daily row.
   (`.lap` was on the old allowlist and is not here, correctly — a lap row is a read-only
   line of text, not something a finger aims at. It takes its padding off the same scale
   regardless, because it sits in a list among things that are.) */
function everyTappable() {
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();

  var found = Object.create(null);
  function sweep(where, label) {
    app.qsa(".tappable", where).forEach(function (n) {
      var kind = (n.getAttribute("class") || "").split(/\s+/)[0];
      if (kind && !found[kind]) found[kind] = { el: n, where: label };
    });
  }
  sweep(app.doc, "home");
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    sweep(p, name);
    app.WP.panels.close();
  });
  return found;
}

test("no control anywhere in the app is under 88 device px", function () {
  var found = everyTappable();
  var kinds = Object.keys(found);
  assert.ok(kinds.length >= 12,
    "only " + kinds.length + " kinds of control were found — the sweep is not reaching the "
    + "panels, and a sweep that finds nothing passes forever");
  /* the three the old allowlist did not name, and one of which a mutation walked through */
  ["sensor", "hr", "fc-day", "card"].forEach(function (k) {
    assert.ok(kinds.indexOf(k) !== -1,
      "the sweep missed ." + k + "; it found: " + kinds.join(", "));
  });

  var small = kinds.filter(function (k) {
    return css.boxVh(found[k].el) < MIN_TARGET_VH;
  }).map(function (k) {
    return "." + k + " is " + (css.boxVh(found[k].el) * DEVICE_PX_PER_VH).toFixed(0)
      + " device px tall (" + found[k].where + ")";
  });
  assert.deepEqual(small, []);
});

test("every control's padding comes off the spacing scale", function () {
  /* The floor above has roughly 2x slack on most controls, which is why a mutation that
     cut a settings row's vertical padding by 76% — visibly wrecking the rhythm of the
     panel — sailed through it: only a padding of exactly zero was ever caught. So the
     assertion is the same shape as the type ramp's: a control does not author a spacing of
     its own, it picks a step. That makes "0.4vh" a failure for the reason it is actually
     wrong (it is not one of the sizes this app draws controls at), rather than waiting for
     it to breach a minimum it never quite breaches. */
  var scale = css.tokens();
  var steps = Object.keys(scale).filter(function (k) { return k.indexOf("pad-") === 0; });
  assert.ok(steps.length >= 4 && steps.length <= 6,
    "the spacing scale has " + steps.length + " steps; a scale with one step per control "
    + "is not a scale: " + steps.join(", "));

  var found = everyTappable();
  var offenders = [];
  Object.keys(found).forEach(function (k) {
    var el = found[k].el;
    /* a control sized by an explicit height (the two round icon buttons) sets no padding */
    if (css.vh(css.styleOf(el, "height")) != null) return;
    var p = css.styleOf(el, "padding");
    if (!p) return;                                     // inherits its box from a parent
    var name = css.tokenName(p.split(/\s+/)[0]);
    if (!name || name.indexOf("pad-") !== 0) {
      offenders.push("." + k + " { padding: " + p + " } — not a step on the scale");
    }
  });
  assert.deepEqual(offenders, []);
});

test("the hourly list is a table, so its columns have a fixed origin", function () {
  /* Measured on device: the sun rows' bars started at x=382, the moon rows' at 356 and the
     cloud rows' at 391 — a 35 device px swing driven purely by which glyph the weather put
     in the column, because `.hrow-i` was the one column authored `flex: 0 0 auto` while
     every sibling had a fixed basis. Columns that move per row are not columns. No test
     touched this geometry at all, and two mutations against it survived.

     The row used to BE a bar chart, and is not any more: `.hrow-bar` drew each hour as a
     fill of a full-width grey track, which implies a maximum temperature has no zero to
     fill from, thirty pixels under a curve already drawing the same eight hours. The
     column that takes the remainder now says what the weather is in words. The geometry
     property is unchanged and is the reason this test exists. */
  [".hrow-t", ".hrow-i", ".hrow-d", ".hrow-p"].forEach(function (sel) {
    var flex = decl(ruleFor(sel, "flex").body, "flex");
    assert.match(flex, /^0 0 [\d.]+v[wh]$/,
      sel + " is `flex: " + flex + "`; a column with no fixed basis moves the one beside it");
  });
  assert.match(decl(ruleFor(".hrow-w", "flex").body, "flex"), /^1 1 auto$/,
    "exactly one column may take the remainder, and it is the words");
  assert.equal(/\.hrow-bar\b/.test(css.CSS), false,
    "the progress track is back; temperature does not have a zero to fill from");
  assert.equal(decl(ruleFor(".hrow-i", "text-align").body, "text-align"), "center",
    "a glyph narrower than its column has to be centred in it or the origin moves again");
});

/* ---------------- accessible names on generated controls ---------------- */

/* what a reader would actually be given: aria-label wins, otherwise the text with every
   aria-hidden subtree removed */
function accessibleName(el) {
  var label = el.getAttribute("aria-label");
  if (label) return label.trim();
  var out = "";
  (function walk(n) {
    (n.children || []).forEach(function (c) {
      if (c.nodeType === 3) { out += c.data; return; }
      if (c.getAttribute && c.getAttribute("aria-hidden") === "true") return;
      walk(c);
    });
  })(el);
  return out.trim();
}

test("every button in the app has an accessible name, in every panel", function () {
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();

  var nameless = [];
  function sweep(where) {
    app.qsa("button", where).forEach(function (b) {
      var n = accessibleName(b);
      /* a name made only of symbols is not a name — that is the icon-only case */
      if (!n || !/[a-z0-9]/i.test(n)) {
        nameless.push((where === app.doc ? "home" : where.getAttribute("data-panel"))
          + ": <" + (b.getAttribute("class") || "").split(" ")[0] + ">");
      }
    });
  }
  sweep(app.doc);
  app.qsa("[data-panel]").forEach(function (p) {
    app.WP.panels.open(p.getAttribute("data-panel"));
    sweep(p);
    app.WP.panels.close();
  });
  assert.deepEqual(nameless, []);
});

test("generated toggles announce as switches and say which way they are set", function () {
  var app = h.createApp({});
  var tiles = app.qsa("#sensors .sensor").filter(function (t) {
    return t.getAttribute("data-act") === "toggle";
  });
  /* the card caps at five entities since the news ticker took the second tile row;
     the demo keeps exactly one switch (the lamp) on the wall, the rest in the panel */
  assert.ok(tiles.length >= 1, "no toggle tiles to check");
  tiles.forEach(function (t) {
    assert.equal(t.getAttribute("role"), "switch");
    var e = app.registry.sensors.find(t.getAttribute("data-arg"));
    assert.equal(t.getAttribute("aria-checked"), e.on ? "true" : "false");
  });

  var t0 = tiles[0];
  var before = t0.getAttribute("aria-checked");
  app.tap(t0);
  var after = app.qs('#sensors [data-arg="' + t0.getAttribute("data-arg") + '"]')
    .getAttribute("aria-checked");
  assert.notEqual(after, before, "aria-checked did not follow the toggle");
});

test("every tappable is reachable and named, whatever element it is built from", function () {
  /* The a11y sweep next to this one only ever looked at <button>. Nine of the app's
     targets are whole <section> cards — Clock, Conditions, Device, Timer, Settings, Moon,
     Air and the news ticker — so a screen reader was told nothing was there at
     all, and eight of the twelve screens had no accessible route in. Found by reading the
     accessibility tree of the running app rather than the markup. */
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var offenders = [];
  function sweep(root, where) {
    app.qsa(".tappable", root).forEach(function (n) {
      if (n.tagName === "BUTTON") return;              // implicit role and name
      var role = n.getAttribute("role");
      var name = n.getAttribute("aria-label");
      if (role !== "button" && role !== "switch") {
        offenders.push(where + " ." + (n.getAttribute("class") || "").split(" ")[0]
          + " has no role");
      } else if (!name && !(n.textContent || "").trim()) {
        offenders.push(where + " ." + (n.getAttribute("class") || "").split(" ")[0]
          + " has no accessible name");
      }
    });
  }
  sweep(app.doc, "home");
  app.qsa("[data-panel]").forEach(function (p) {
    var name = p.getAttribute("data-panel");
    app.WP.panels.open(name);
    sweep(p, name);
    app.WP.panels.close();
  });
  assert.deepEqual(offenders, []);
});

test("single-choice button groups are radiogroups, not loose buttons", function () {
  /* Without this a reader is told "12-hour, button" and "24-hour, button" with nothing to
     say that they are alternatives or which one is in force. */
  var app = h.createApp({});
  ["settings", "timer"].forEach(function (name) {
    app.WP.panels.open(name);
    app.qsa('[data-panel="' + name + '"] .seg').forEach(function (g) {
      assert.equal(g.getAttribute("role"), "radiogroup", name + " .seg");
      assert.ok(g.getAttribute("aria-label"), name + " .seg has no group name");
      var checked = g.querySelectorAll('[role="radio"]').filter(function (b) {
        return b.getAttribute("aria-checked") === "true";
      });
      assert.equal(checked.length, 1, name + ": exactly one option must be checked");
    });
    app.WP.panels.close();
  });
});

test("decorative glyphs are hidden from the accessibility tree, not read out", function () {
  var app = h.createApp({});
  var wx = require("./lib/wx-fixture.js");
  app.registry.weather.data = wx.build({ now: app.clock.now, hours: 48 });
  app.registry.weather.publish();

  /* the home card glyphs, and the ones inside generated buttons */
  assert.equal(app.$("wx-icon").getAttribute("aria-hidden"), "true");
  app.qsa("#hourly .hr").forEach(function (chip) {
    assert.equal(chip.querySelector(".hr-i").getAttribute("aria-hidden"), "true");
    assert.match(chip.getAttribute("aria-label") || "", /\d/,
      "an hour chip with a hidden glyph and no spoken label says nothing");
  });
  app.qsa("#forecast .fc-day").forEach(function (d) {
    assert.equal(d.querySelector(".fc-icon").getAttribute("aria-hidden"), "true");
    assert.ok(d.getAttribute("aria-label"));
  });
});

test("the live regions are the two lines that actually change on their own", function () {
  assert.match(HTML, /id="status"[^>]*aria-live="polite"/);
  assert.match(HTML, /id="toast"[^>]*aria-live="polite"/);
  /* the full-screen alarm is the one thing that must interrupt */
  assert.match(HTML, /id="alarm"[^>]*[\s\S]{0,120}role="alertdialog"/);
});

test("ARIA did not arrive by turning controls into non-buttons", function () {
  /* Every regression risk in this area is the same shape: a role attribute silently
     replaces the delegation contract. hit() resolves on data-open / data-act / data-close,
     and boot() already warns about orphans — assert the count is zero rather than trusting
     the warning to be read. */
  var app = h.createApp({});
  app.WP.panels.open("settings");
  assert.deepEqual(app.logs.warn, []);
  app.qsa('[data-panel="settings"] .srow').forEach(function (r) {
    assert.equal(r.tagName, "BUTTON", "a switch row stopped being a button");
    assert.ok(r.getAttribute("data-act"), "a switch row left the pointer delegation");
  });
});

test("the day chart's temperature ramp is applied to EVERY bar, or to none", function () {
  /* Rewritten, because the property it used to pin has been superseded twice by the same
     mistake in opposite directions and the narrow assertion could not see either.

     It was written for a real inversion — `.peak` marked BOTH the warmest and the coldest
     hour and painted both var(--temp-hot), so the day's minimum was the same red-orange as
     its maximum. That was fixed by giving the cold extreme its own rule, which the old
     assertion pinned exactly: `.daybar.peak.cold`. And that fix produced the NEXT fault,
     which this test was blind to by construction: 22 of 24 bars identical grey, and the
     only two coloured ones drawn in the two lowest-contrast colours on the screen. Height
     carried the whole chart and colour marked two extremes nobody can resolve at 3 m.

     A ramp is either the chart's language or it is not in the chart. So the property is now
     the general one: every bar's cap is picked from the three temperature tokens by the
     same function the hourly curve and the hourly list use, and no bar may wear a token
     that disagrees with its own class. Half-application is what fails here now — which is
     exactly what shipped while the old assertion was green. */
  var tones = ["t-hot", "t-warm", "t-cold"];
  tones.forEach(function (tone) {
    var r = rules().filter(function (x) {
      return x.sel.indexOf(".daybar." + tone + " ") !== -1 && /daybar-c/.test(x.sel);
    })[0];
    assert.ok(r, "the day chart has no cap colour for " + tone
      + " — the ramp is applied to some bars and not others again");
    var token = "--temp-" + tone.slice(2);
    assert.match(r.body, new RegExp(token));
    tones.filter(function (o) { return o !== tone; }).forEach(function (other) {
      assert.equal(new RegExp("--temp-" + other.slice(2)).test(r.body), false,
        tone + " bars are painted with the " + other + " token");
    });
  });

  /* and the widget tones EVERY bar, not only the two extremes */
  var src = stripComments(h.readAsset("wx-daily.js"));
  assert.match(src, /class="daybar \s*'\s*\+\s*tempTone\(/,
    "the daily chart is not asking WP.ui.tempTone for each bar's stop");
  assert.match(src, /peak \? " peak" : ""/, "the two extremes no longer carry their number");
});

test("one function decides which temperature stop a reading wears", function () {
  /* 72 degrees rendered BLUE in the hourly panel's list and pale warm-cream on the curve
     400 px above it — same datum, same screen, two answers — because the list bucketed at
     0.66 / 0.33 while the curve's middle gradient stop sat at 0.55. Two mappings for one
     variable is two design systems, and the only fix that stays fixed is one function that
     every caller shares and boundaries that are the gradient's own midpoints. */
  var ui = stripComments(h.readAsset("wx-ui.js"));
  assert.match(ui, /function tempTone/, "the shared stop-picker has left the vocabulary file");
  assert.match(ui, /f > 0\.75 \? "t-hot" : f > 0\.25 \? "t-warm" : "t-cold"/,
    "the buckets are no longer the midpoints between the curve's three stops");

  /* the curve's stops are what those numbers are derived from: hot at 0, warm at the
     MIDDLE, cold at 1, so the nearest stop to a reading at fraction f is the class above */
  var hourly = stripComments(h.readAsset("wx-hourly.js"));
  /* The curve is BANDED at the same cut points, not smoothly blended: against a continuous
     gradient there is no height at which a three-class list and the curve agree except by
     luck. Warm runs 0.3-0.7 of the plot, which brackets the 0.25/0.75 bucket edges. */
  assert.match(hourly, /offset="0\.28" stop-color="var\(--temp-warm\)"/,
    "the curve's warm band no longer starts where the warm bucket does");
  assert.match(hourly, /offset="0\.72" stop-color="var\(--temp-warm\)"/,
    "the curve's warm band no longer ends where the warm bucket does");
  assert.equal(/function tempTone/.test(hourly), false,
    "wx-hourly has its own copy of the stop-picker again");
  assert.match(stripComments(h.readAsset("wx-daily.js")), /tempTone = ui\.tempTone/,
    "the daily chart is not using the shared stop-picker");
});

test("the scroll fade only appears on a strip that is actually scrolling", function () {
  /* The mask that dissolves the last 4vw of the hourly strip was authored on .hstrip
     unconditionally. In landscape the card is nearly twice as wide, all eight chips fit,
     nothing scrolls — and the last column was still rendered at reduced opacity, hour,
     glyph and temperature together, inside a card with spare width. On the most-looked-at
     card in the product that reads as a broken renderer, not as "there is more this way".
     A mask cannot ask whether its own content overflows, so relayoutHome() answers it and
     the mask hangs off the answer. */
  var plain = ruleFor(".hstrip", "overflow-x");
  assert.equal(decl(plain.body, "mask-image"), null,
    "the fade is back on every .hstrip, scrolling or not");
  var scrolls = ruleFor(".hstrip.scrolls", "mask-image");
  assert.match(decl(scrolls.body, "mask-image"), /linear-gradient/);
  assert.match(stripComments(VIEW_JS), /classList\.toggle\("scrolls"/,
    "nothing sets .scrolls, so the fade can never appear at all");
});

test("an affordance is not painted in the colour of a temperature", function () {
  /* --accent and --temp-cold are the same hex. On the home screen that meant blue marked
     both "this number is a low" (65° 64° 64°) and "this thing opens something"
     ("Details ›"), two centimetres apart. Data keeps the colour. */
  [".link-btn", ".wide-btn"].forEach(function (sel) {
    var r = ruleFor(sel, "color");
    assert.equal(decl(r.body, "color"), "var(--fg)",
      sel + " is drawn in " + decl(r.body, "color") + ", which is the cold-temperature blue");
  });
});

test("a control's STATE is not painted in the colour of a temperature either", function () {
  /* The other half of the same defect, and the half that survived: blue marked cold AND
     selected AND on. Every toggle in Settings, the selected day chip on Daily (a hand's
     width from that day's blue low), the selected hour row and the Home Assistant tiles were
     all --accent, which is --temp-cold's hex. A state of a control is drawn as more light,
     not as a hue; a hue on this wall means a datum. */
  [".chip.on", ".seg-b.on", ".switch.on", ".btn.fill", ".hrow.sel"].forEach(function (sel) {
    var r = ruleFor(sel, "background");
    var bg = decl(r.body, "background");
    assert.equal(/109,\s*179,\s*242|var\(--accent\)/.test(bg), false,
      sel + " fills with " + bg + ", which is the cold-temperature blue");
  });
});

test("nothing outside the stylesheets paints itself the cold-temperature blue", function () {
  /* The third and last place this defect hid, and the only one the two tests above could
     not see: a colour authored in a WIDGET rather than in a rule. wx-system.js filled the
     charging battery with `var(--accent)`, which style.css documents — in a comment on the
     token itself — as the same hex as --temp-cold. So the one screen in the build whose
     panel comment states the rule was the one screen that broke it, and it broke it in a
     file no CSS assertion reads.

     --accent is allowed to mean a LINE of data (the sensor trace, the countdown bar, the
     rain figure) and those all live in the stylesheets where the two tests above can see
     them. A widget that wants a colour picks a CLASS, like everything else here. */
  ["wx-system.js", "wx-air.js", "wx-moon.js", "wx-timer.js", "wx-sensors.js",
   "wx-sensors-panel.js", "wx-weather.js", "wx-daily.js", "wx-hourly.js",
   "wx-icons.js", "wx-news.js", "wx-clock.js"].forEach(function (f) {
    var src = stripComments(h.readAsset(f));
    assert.equal(/var\(--accent\)/.test(src), false,
      f + " authors var(--accent) — the same hex as --temp-cold — outside the stylesheets");
  });
});

test("colour marks DATA, so no button carries a hue of its own", function () {
  /* .btn.primary (green Start) and .btn.danger (red "Reset to defaults") took the palette
     from three hues to five and spent both additions on affordances. What a button does is
     its word and its position; --danger stays for a STATE — the countdown alarm's flash and
     a reading in the red. */
  ["primary", "danger"].forEach(function (v) {
    assert.equal(new RegExp("\\.btn\\." + v + "\\b").test(css.CSS), false,
      ".btn." + v + " is back; an affordance does not get a hue");
  });
  assert.equal(/"(primary|danger)"/.test(stripComments(WIDGETS_JS)), false,
    "a widget is still asking for a coloured button");
});
