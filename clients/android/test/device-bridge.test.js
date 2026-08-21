/* The Device widget and the Android bridge behind it.

   This is the JS half of the contract with MainActivity's @JavascriptInterface object. It
   cannot exercise the Java, but it does pin the shape and the degradation behaviour, so a
   change on the shell side that drops a field shows up here rather than as "n/a" on a wall.
   The WebView hardening in MainActivity (navigation allowlist, debug socket gating) must
   leave every one of these passing. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");
var fake = require("./lib/fake-bridge.js");

/* Storage and Memory both have a "Free" and a "Used", so stats are read per section. The
   section titles carry the total now ("Storage free · 128 GB"), so the lookup matches on a
   prefix rather than on the whole heading. */
function stats(body, sectionTitle) {
  var root = body;
  if (sectionTitle) {
    root = body.querySelectorAll(".psec").filter(function (s) {
      return s.querySelector(".psec-t").textContent.indexOf(sectionTitle) === 0;
    })[0];
    assert.ok(root, "no section titled " + sectionTitle);
  }
  var out = {};
  root.querySelectorAll(".stat").forEach(function (st) {
    out[st.querySelector(".stat-k").textContent] = st.querySelector(".stat-v").textContent;
  });
  return out;
}

test("the tile reports real battery, storage, uptime and network", function () {
  var app = h.createApp({ bridge: fake.make({}) });
  assert.equal(app.text("sys-big"), "74%");
  /* CHANGED in the fit round: every home-tile sub-line has to SET in about eleven
     characters. Six tiles share one line of the home column, so a tile is 102 CSS px
     wide with an 80 px content box, and three of the six were ellipsising against
     empty space beside them. See the comments at each tile's renderer. */
  assert.equal(app.text("sys-sub"), "41 GB");
});

test("charging adds the bolt", function () {
  var app = h.createApp({ bridge: fake.make({ charging: true }) });
  assert.equal(app.text("sys-big"), "74% ↯");
});

test("the panel renders every section from one snapshot", function () {
  /* CHANGED with the copy sweep. Four battery cells, "Low memory", "Used %" x2, the
     network interface name and "(API 33)" were removed as jargon or as restatements of
     something already on the screen — see the comments in wx-system.js. Every field that
     went is still asserted here, against the element that now carries it, so this test
     still proves the whole snapshot reaches the panel and not only the part of it that
     survived a layout change. */
  var app = h.createApp({ bridge: fake.make({}) });
  app.tap(app.qs('[data-open="system"]'));
  var body = app.panelBody("system");

  /* level and status live in the hero, which is where they always visually were */
  assert.equal(body.querySelector(".big-time").textContent, "74%");
  assert.equal(body.querySelector(".big-sub").textContent, "Discharging");

  /* the level is also DRAWN: the hero glyph is a battery filled to the charge, which is
     what the hollow "▭" beside "74%" was not */
  var icon = body.querySelector(".big-icon .bat-fill");
  assert.ok(icon, "the battery hero lost its drawn level");
  assert.equal(Math.round(parseFloat(icon.getAttribute("width")) / 40 * 100), 74,
    "the battery icon is not drawn at the level it is reporting");

  var bat = stats(body, "Battery");
  assert.equal(bat["Health"], "Good");
  assert.equal(bat["Temperature"], "83.1 °F");
  /* CHANGED in the fit round: VOLTAGE and CELLS are gone. 4.102 V is a figure the owner of
     a tablet cannot act on and "Li-ion" is the same word every day for the life of the
     device — prime space on the one screen that answers "is the panel on my wall healthy".
     Asserted absent rather than merely un-asserted, so trivia cannot drift back in. */
  assert.deepEqual(Object.keys(bat).filter(function (k) {
    return k === "Level" || k === "Charging" || k === "Status"
        || k === "Voltage" || k === "Cells";
  }), [], "the battery grid is restating the hero, or back to reporting trivia");

  /* CHANGED: the TOTAL moved from a grid cell into the section heading, and the heading
     also names the bar's direction. Free + used + total is three figures of which any two
     determine the third — the grid was doing arithmetic out loud — and the constant of the
     three is the one that belongs in the name of the thing rather than in a cell. The
     direction matters because a nearly-full bar beside "FREE 104 GB" reads as "nearly full"
     to every human alive; these bars fill with what is LEFT, and now they say so. */
  function heading(title) {
    return body.querySelectorAll(".psec-t").filter(function (n) {
      return n.textContent.indexOf(title) === 0;
    })[0].textContent;
  }
  assert.equal(heading("Storage"), "Storage free · 128 GB");
  assert.equal(heading("Memory"), "Memory free · 6 GB");

  var st = stats(body, "Storage");
  assert.equal(st["Free"], "41 GB");
  assert.equal(st["Used"], "87 GB");
  assert.equal(st["Total"], undefined, "the total is in the heading, not a third cell");

  var mem = stats(body, "Memory");
  assert.equal(mem["Free"], "2 GB");
  assert.equal(mem["Used"], "4 GB");
  assert.equal(mem["Total"], undefined, "the total is in the heading, not a third cell");

  /* CHANGED in the fit round: DOWN and UP are one cell, because they are one measurement
     of one link and as two cells they spilled a three-across grid onto a second row the
     screen did not have. METERED went with them — it is a property of the plan, not of the
     wall. The figures themselves are still asserted, in the cell that now carries them. */
  var net = stats(body, "Network");
  assert.equal(net["Transport"], "Wi-Fi");
  assert.equal(net["Internet"], "Working");
  assert.equal(net["Speed"], "144 / 72");

  /* ANDROID, SCREEN, BRIGHTNESS and TABLET went the same way: the panel's own subtitle
     says "TEST-PANEL · Android 13" four lines above, so the model and the version were
     already on the screen, and a pixel count and a percentage of a byte are facts about
     the hardware rather than about the room. The subtitle assertion below is what keeps
     the model and the Android version asserted at all. */
  /* Uptime followed them into the subtitle. It had a section headed UPTIME holding a cell
     labelled UPTIME — the label printed inside its own value — beside an AWAKE cell that on
     a wall panel prints the identical string, because a wall panel never sleeps. The awake
     figure survives as a SHARE, which is the form in which it can differ from uptime and so
     the form in which it is worth the pixels: 2 of 3.17 days is 63%. */
  assert.match(app.qs('[data-panel="system"] [data-sub]').textContent,
    /TEST-PANEL · Android 13 · up 3d 4h 0m, 63% awake/);
});

test("battery temperature follows the unit setting", function () {
  var app = h.createApp({ bridge: fake.make({}) });
  app.WP.settings.set("units", "celsius");
  app.WP.panels.open("system");
  assert.equal(stats(app.panelBody("system"))["Temperature"], "28.4 °C");
});

test("storage and memory percentages come out of the snapshot's own numbers", function () {
  var app = h.createApp({
    bridge: fake.make({ storage: { total: 100, free: 25 }, memory: { total: 8, free: 2 } })
  });
  app.WP.panels.open("system");
  var body = app.panelBody("system");
  var s = stats(body, "Storage");
  assert.equal(s["Used"], "75 B");

  /* CHANGED with the copy sweep: the percentage used to be a "Used %" cell, which was the
     fourth cell of a three-across grid and so sat alone on the row the footer cut in half.
     It was also the bar directly above it, written out. Assert the BAR now — both the
     width it is drawn at and the percentage it announces — which is a strictly better
     check, because the bar is the thing on the screen and the cell never was.

     CHANGED AGAIN in the colour round: all three bars on this panel fill with what is
     LEFT. Storage and memory filled with what was USED while the battery bar right above
     them filled with what REMAINED — three identical grey bars at three lengths, two of
     them meaning the opposite of the third, with nothing on the screen to say which way
     round any of them ran. 25 of 100 bytes free is a quarter-full bar now, and every bar
     on the screen means "more is better". */
  function pct(label) {
    var b = body.querySelectorAll(".bar").filter(function (n) {
      return (n.getAttribute("aria-label") || "").indexOf(label) === 0;
    })[0];
    assert.ok(b, "no " + label + " bar");
    return { width: b.querySelector(".bar-fill").getAttribute("style"),
             said: b.getAttribute("aria-label") };
  }
  assert.equal(pct("storage free").width, "width:25.0%");
  assert.equal(pct("storage free").said, "storage free 25 percent");
  assert.equal(pct("memory free").width, "width:25.0%");
  assert.equal(pct("memory free").said, "memory free 25 percent");
  assert.equal(body.querySelectorAll(".bar").filter(function (n) {
    return /used/.test(n.getAttribute("aria-label") || "");
  }).length, 0, "a bar on this panel still fills with what is used");
});

test("no bridge at all degrades to an explicit message, not a blank card", function () {
  var app = h.createApp({});                       // window.Android absent
  assert.equal(app.text("sys-big"), "n/a");
  assert.equal(app.text("sys-sub"), "no device link");
  assert.equal(app.WP.bridge.present(), false);

  app.WP.panels.open("system");
  assert.match(app.panelBody("system").textContent, /link is not available/);
  assert.match(app.qs('[data-panel="system"] [data-sub]').textContent, /sensors unavailable/);
  assert.deepEqual(app.logs.error, []);
});

test("a bridge that returns junk is treated as absent, not as a crash", function () {
  var app = h.createApp({ bridge: fake.make({ broken: true }) });
  assert.equal(app.text("sys-big"), "n/a");
  assert.equal(app.text("sys-sub"), "sensor error", "a present-but-broken bridge says so");
  assert.deepEqual(app.logs.error, []);
});

test("a bridge that throws is caught and logged, not propagated", function () {
  var app = h.createApp({
    bridge: { deviceInfo: function () { throw new Error("JNI exploded"); } }
  });
  assert.equal(app.text("sys-big"), "n/a");
  assert.deepEqual(app.logs.error, []);
  assert.match(app.logs.warn.join(" "), /bridge deviceInfo failed/);
});

test("bridge.has and bridge.call answer honestly about missing methods", function () {
  var app = h.createApp({ bridge: { deviceInfo: function () { return "{}"; } } });
  var b = app.WP.bridge;
  assert.equal(b.present(), true);
  assert.equal(b.has("deviceInfo"), true);
  assert.equal(b.has("setPref"), false, "a method the shell does not expose");
  assert.equal(b.call("setPref", "x"), null, "calling a missing method must return null");
  assert.equal(b.json("nope"), null);
});

test("a partial snapshot renders what it has and dashes the rest", function () {
  var app = h.createApp({
    bridge: { deviceInfo: function () { return JSON.stringify({ uptimeMs: 5000 }); } }
  });
  assert.equal(app.text("sys-big"), "--%");
  assert.equal(app.text("sys-sub"), "--");
  app.WP.panels.open("system");
  var body = app.panelBody("system");
  /* CHANGED with the copy sweep: level moved to the hero. CHANGED again in the fit round:
     the TABLET cell went entirely (the subtitle already carries the model), so the missing
     field asserted here is one of the ones still on the screen. Same assertion — a missing
     field must dash, never print "undefined" or vanish. */
  assert.equal(body.querySelector(".big-time").textContent, "--%");
  var s = stats(body);
  assert.equal(s["Health"], "--");
  assert.equal(s["Speed"], "-- / --");
  assert.equal(s["Transport"], "none");
  assert.equal(/undefined|NaN|null/.test(body.textContent), false,
    "a missing field leaked a JS value onto the wall");
  assert.deepEqual(app.logs.error, []);
});

function jni(bridge) {
  return bridge.calls.filter(function (c) { return c === "deviceInfo"; }).length;
}

test("the widget re-reads the bridge on its refresh cadence", function () {
  var bridge = fake.make({});
  var app = h.createApp({ bridge: bridge });
  var first = jni(bridge);
  app.advance(11 * 60000);
  assert.ok(jni(bridge) > first, "the Device widget stopped polling the bridge");
});

/* ---------------- poll cadence ----------------
   The bridge poll is the app's only JNI traffic and it used to run at 5 s forever, panel
   open or closed: ~17,300 crossings a day plus a full tile re-render on each one, to keep a
   battery percentage and a rounded uptime current. These three tests pin the replacement —
   the cadence, the fact that opening the panel does not have to wait for it, and the fact
   that the tile is still live with the panel closed. */

test("with the Device panel closed the bridge is polled once a minute, not every 5 s", function () {
  var bridge = fake.make({});
  var app = h.createApp({ bridge: bridge });
  var atBoot = jni(bridge);
  assert.equal(atBoot, 1, "boot should take exactly one reading");

  app.advance(3600000);                          // one hour, panel closed
  var perHour = jni(bridge) - atBoot;
  assert.equal(perHour, 60, "expected 60 polls an hour with the panel closed, got " + perHour);
  /* the old cadence would be 720; state the comparison so the number cannot rot silently */
  assert.ok(perHour < 720 / 6, "the idle backoff is not actually backing off");
});

test("opening the Device panel restores the 5 s cadence and reads immediately", function () {
  var bridge = fake.make({});
  var app = h.createApp({ bridge: bridge });
  app.advance(30000);                            // mid-way through an idle period
  var before = jni(bridge);

  app.WP.panels.open("system");
  assert.equal(jni(bridge), before + 1,
    "opening the panel must take a reading, not show a up-to-a-minute-old one");

  app.advance(60000);                            // a minute with the panel open
  var open = jni(bridge) - (before + 1);
  assert.equal(open, 12, "expected 12 polls a minute with the panel open, got " + open);

  app.WP.panels.closeAll();
  var afterClose = jni(bridge);
  app.advance(30000);
  assert.equal(jni(bridge), afterClose, "the 5 s cadence outlived the panel that needed it");
});

test("a live battery change still reaches the closed tile by itself", function () {
  var bridge = fake.make({});
  var app = h.createApp({ bridge: bridge });
  assert.equal(app.text("sys-big"), "74%");
  bridge.snapshot.battery.level = 12;
  bridge.snapshot.battery.charging = true;
  app.advance(61000);                            // one idle period
  assert.equal(app.text("sys-big"), "12% ↯", "the tile stopped updating on its own");
});

test("an unchanged snapshot writes nothing to the tile", function () {
  /* Backing off the poll is only half of it: the poll that does happen re-rendered the tile
     whether or not anything had moved. */
  var bridge = fake.make({});
  var app = h.createApp({ bridge: bridge });
  var big = app.$("sys-big"), sub = app.$("sys-sub");
  var proto = Object.getPrototypeOf(big);
  var desc = Object.getOwnPropertyDescriptor(proto, "textContent");
  var writes = 0;
  [big, sub].forEach(function (el) {
    Object.defineProperty(el, "textContent", {
      configurable: true,
      get: function () { return desc.get.call(this); },
      set: function (v) { writes++; desc.set.call(this, v); }
    });
  });

  app.advance(3600000);                          // an hour of polls, nothing changing
  assert.equal(writes, 0, "an unchanged device snapshot rewrote the tile " + writes + " times");

  bridge.snapshot.battery.level = 73;
  app.advance(61000);
  assert.equal(writes, 1, "a real change did not reach the tile (or wrote more than it needed)");
});

test("the Settings panel reports whether the bridge is attached", function () {
  /* CHANGED with the copy sweep: the About block said "device sensors: connected · screen
     711 × 1138". The screen figure was the CSS viewport rather than the screen and was
     jargon either way; the rest is now a sentence. Same fact, still asserted both ways
     round, and the viewport figure is asserted GONE so it cannot come back.

     CHANGED AGAIN in the fit round: the sentence lost its ABOUT heading and half its
     words, because Settings was overflowing its screen by 1157 px and a heading over one
     sentence is a heading spent on nothing. The fact this test exists for — that the panel
     says out loud whether the tablet's own sensors are readable — is unchanged, and it is
     still the closest thing the wall has to "am I still alive". */
  var withBridge = h.createApp({ bridge: fake.make({}) });
  withBridge.WP.panels.open("settings");
  var on = withBridge.panelBody("settings").textContent;
  assert.match(on, /tablet sensors connected/);
  assert.equal(/\d+ ?[×x] ?\d+/.test(on), false, "the viewport measurement is back");

  var without = h.createApp({});
  without.WP.panels.open("settings");
  assert.match(without.panelBody("settings").textContent,
    /tablet sensors not readable/);
});
