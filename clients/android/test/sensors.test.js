/* Home Assistant tiles: the duty-cycle arithmetic and the demo simulator's physics. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

function boot(opts) { return h.createApp(opts || {}); }
function lamp(app) { return app.registry.sensors.find("light.living_room_lamp"); }

/* ---------------- duty cycle ---------------- */

test("duty cycle is time-weighted, not a mean of samples", function () {
  /* A toggle records an extra off-grid sample the instant it is pressed. An unweighted mean
     would count that instant as heavily as a 30 s interval. */
  var s = boot().registry.sensors;
  var t = 1000000;
  var hist = [
    { t: t, v: 1 },                // on...
    { t: t + 1, v: 0 },            // ...switched off 1 ms later, recorded off-grid
    { t: t + 30000, v: 0 },
    { t: t + 90000, v: 0 }
  ];
  var duty = s.duty(hist);
  assert.ok(Math.abs(duty - 1 / 90000) < 1e-9,
    "on for 1 ms of 90 s should be ~0% duty, got " + (duty * 100).toFixed(2) + "%");

  var unweighted = hist.filter(function (p) { return p.v >= 0.5; }).length / hist.length;
  assert.equal(Math.round(unweighted * 100), 25,
    "a mean of samples would call this 25% — the fixture can tell the formulas apart");
});

test("duty cycle uses the value at the START of each interval", function () {
  var s = boot().registry.sensors;
  var t = 0;
  /* on at t=0, switched off at t=100: the first 100 ms count as on */
  assert.equal(s.duty([{ t: t, v: 1 }, { t: t + 100, v: 0 }]), 1);
  assert.equal(s.duty([{ t: t, v: 0 }, { t: t + 100, v: 1 }]), 0);
});

test("duty cycle degrades safely on thin or broken history", function () {
  var s = boot().registry.sensors;
  assert.equal(s.duty(null), null);
  assert.equal(s.duty([]), null);
  assert.equal(s.duty([{ t: 1, v: 1 }]), null, "one sample spans no time");
  assert.equal(s.duty([{ t: 5, v: 1 }, { t: 5, v: 0 }]), null, "zero-length intervals");
});

test("duty cycle is bounded and matches an all-on / all-off series", function () {
  var s = boot().registry.sensors;
  var on = [], off = [];
  for (var i = 0; i < 20; i++) {
    on.push({ t: i * 30000, v: 1 });
    off.push({ t: i * 30000, v: 0 });
  }
  assert.equal(s.duty(on), 1);
  assert.equal(s.duty(off), 0);
});

test("REGRESSION: the panel's duty figures agree with the state it shows", function () {
  /* The seeded history used to be filled with the entity's *current* state, so the panel
     contradicted itself for two hours after any toggle: "State now: Off" beside
     "On: 100% of window". */
  var app = boot();
  app.WP.panels.open("sensors");
  var e = lamp(app);
  app.registry.sensors.sel = e.id;

  [true, false].forEach(function (want) {
    if (e.on !== want) app.registry.sensors.toggle(e.id);
    app.registry.sensors.paintPanel();
    var stats = readStats(app.panelBody("sensors"));
    assert.equal(stats["State now"], want ? "On" : "Off");

    var last = e.hist[e.hist.length - 1];
    assert.equal(last.v >= 0.5, want, "the newest sample disagrees with the tile");

    var duty = app.registry.sensors.duty(e.hist);
    var pct = Math.round(duty * 100);
    assert.equal(stats["On"], pct + "% of window");
    assert.equal(stats["Off"], (100 - pct) + "% of window");
    assert.ok(pct > 0 && pct < 100,
      "a seeded past that is 0% or 100% is the bug this test exists for (got " + pct + "%)");
  });
  app.WP.panels.closeAll();
});

function readStats(body) {
  var out = {};
  body.querySelectorAll(".stat").forEach(function (st) {
    out[st.querySelector(".stat-k").textContent] = st.querySelector(".stat-v").textContent;
  });
  return out;
}

test("lastChange finds the most recent edge and nothing else", function () {
  var s = boot().registry.sensors;
  var hist = [
    { t: 100, v: 0 }, { t: 200, v: 1 }, { t: 300, v: 1 },
    { t: 400, v: 0 }, { t: 500, v: 0 }
  ];
  assert.equal(s.lastChange(hist), 400);
  assert.equal(s.lastChange([{ t: 1, v: 1 }, { t: 2, v: 1 }]), null, "a flat series has no edge");
  assert.equal(s.lastChange([]), null);
});

/* ---------------- the simulator ---------------- */

test("mean reversion is a proper decay: bounded, and slower for a larger tau", function () {
  var s = boot().registry.sensors;
  var room = { tau: 900000 };        // a room has thermal mass
  var power = { tau: 60000 };        // household load follows in seconds

  [room, power].forEach(function (def) {
    [1, 5000, 30000, 900000].forEach(function (dt) {
      var k = s.reversion(def, dt);
      assert.ok(k > 0 && k < 1, "reversion out of (0,1): " + k);
    });
  });
  assert.ok(s.reversion(room, 5000) < s.reversion(power, 5000),
    "a bigger time constant must react more slowly");
  assert.ok(s.reversion(room, 5000) < s.reversion(room, 30000),
    "a longer step must close more of the gap");
  /* one time constant closes 1 - 1/e of the gap */
  assert.ok(Math.abs(s.reversion(room, 900000) - (1 - 1 / Math.E)) < 1e-9);
});

test("the noise kick scales as sqrt(dt), so a 30 s seed matches a 5 s step", function () {
  /* Otherwise the seeded past and the live trace have a visible seam where one hands over. */
  var s = boot().registry.sensors;
  var def = { noise: 0.1 };
  var n5 = s.noiseFor(def, 5000);
  var n30 = s.noiseFor(def, 30000);
  assert.ok(Math.abs(n5 - 0.1) < 1e-12, "the 5 s step is the reference kick");
  assert.ok(Math.abs(n30 / n5 - Math.sqrt(6)) < 1e-9, "noise did not scale as sqrt(dt)");
});

test("a single simulation step never moves further than tau allows", function () {
  /* With the random kick pinned to its maximum, the step is still bounded by
     gap * k + noise. A step bigger than that means the model is not the model. */
  var app = boot({ random: function () { return 1; } });      // worst-case kick, every time
  var s = app.registry.sensors;

  s.ents.filter(function (e) { return e.kind === "numeric"; }).forEach(function (e) {
    for (var i = 0; i < 40; i++) {
      var before = e.value;
      var tgt = s.target(e.def, new Date(app.clock.now), s.flags());
      var bound = Math.abs(tgt - before) * s.reversion(e.def, s.tickMs)
        + s.noiseFor(e.def, s.tickMs) + 1e-9;
      app.advance(s.tickMs);
      assert.ok(Math.abs(e.value - before) <= bound,
        e.id + " moved " + (e.value - before).toFixed(4) + ", bound " + bound.toFixed(4));
    }
  });
});

test("simulated values stay inside their declared range forever", function () {
  var app = boot({ random: function () { return Math.random(); } });
  var s = app.registry.sensors;
  app.advance(3 * 3600000);                                    // three hours of ticks
  s.ents.filter(function (e) { return e.kind === "numeric"; }).forEach(function (e) {
    assert.ok(e.value >= e.def.min && e.value <= e.def.max,
      e.id + " left its range at " + e.value);
    e.hist.forEach(function (p) {
      assert.ok(p.v >= e.def.min && p.v <= e.def.max, e.id + " history left its range");
    });
  });
});

test("the model reverts toward its target when the noise is switched off", function () {
  var app = boot({ random: function () { return 0.5; } });     // kick of exactly zero
  var s = app.registry.sensors;
  var e = s.find("sensor.living_room_co2");
  var tgt = s.target(e.def, new Date(app.clock.now), s.flags());
  e.value = e.def.max;                                          // start far away
  var gap0 = Math.abs(e.value - tgt);

  app.advance(s.tickMs * 20);
  var gap1 = Math.abs(e.value - s.target(e.def, new Date(app.clock.now), s.flags()));
  assert.ok(gap1 < gap0, "the value did not move toward its target");
  assert.ok(e.value <= e.def.max, "and it never overshoots its ceiling");
});

test("switching the lamp on really does warm the living room", function () {
  var app = boot();
  var s = app.registry.sensors;
  var def = s.find("sensor.living_room_temperature").def;
  var when = new Date(app.clock.now);
  var cold = s.target(def, when, { lamp: false, fan: false, door: false });
  var warm = s.target(def, when, { lamp: true, fan: false, door: false });
  assert.ok(warm > cold, "the lamp has no effect on the room");
  assert.ok(Math.abs((warm - cold) - 1.4) < 1e-9);

  var power = s.find("sensor.house_power").def;
  assert.ok(s.target(power, when, { lamp: true, fan: true }) >
            s.target(power, when, { lamp: false, fan: false }), "switches should draw watts");
});

test("the daily curve peaks near the entity's declared phase", function () {
  var s = boot().registry.sensors;
  var def = s.find("sensor.outside_temperature").def;
  var best = -1, bestV = -Infinity;
  for (var hour = 0; hour < 24; hour++) {
    var v = s.target(def, new Date(2025, 5, 10, hour, 0), {});
    if (v > bestV) { bestV = v; best = hour; }
  }
  assert.ok(Math.abs(best - def.phase) <= 1, "peak at " + best + ", phase " + def.phase);
});

test("the seeded history spans two hours and is deterministic", function () {
  var a = boot(), b = boot();
  var ea = a.registry.sensors.find("sensor.living_room_temperature");
  var eb = b.registry.sensors.find("sensor.living_room_temperature");
  assert.equal(ea.hist.length, eb.hist.length);
  assert.ok(ea.hist.length >= 240, "two hours at 30 s is 241 samples, got " + ea.hist.length);
  var span = ea.hist[ea.hist.length - 1].t - ea.hist[0].t;
  assert.ok(Math.abs(span - 7200000) < 60000, "history span was " + span + " ms");
  ea.hist.forEach(function (p, i) {
    assert.ok(Math.abs(p.v - eb.hist[i].v) < 1e-12, "seeded history is not deterministic");
  });
});

test("the seeded switch history contains real runs, not one flat line", function () {
  var app = boot();
  var e = lamp(app);
  var edges = 0;
  for (var i = 1; i < e.hist.length; i++) {
    if ((e.hist[i].v >= 0.5) !== (e.hist[i - 1].v >= 0.5)) edges++;
  }
  assert.ok(edges >= 1, "the lamp never changed state in two hours of synthetic past");
  assert.equal(e.hist[e.hist.length - 1].v >= 0.5, e.on,
    "the seeded past must join the present without an invented step");
});

test("history is trimmed by age, not by sample count", function () {
  /* The poll interval is configurable, so a fixed cap would mean a different window for
     every refreshSeconds while the panel still calls it "Last 2 hours". */
  var app = boot();
  var s = app.registry.sensors;
  var e = s.find("sensor.house_power");
  app.advance(3 * 3600000);
  var span = e.hist[e.hist.length - 1].t - e.hist[0].t;
  assert.ok(span <= 7200000 + 60000, "window grew to " + span + " ms");
  assert.ok(e.hist.length <= 800);
});

test("a toggle records its edge immediately rather than up to 30 s late", function () {
  var app = boot();
  var s = app.registry.sensors;
  var e = lamp(app);
  var before = e.on;
  var n = e.hist.length;
  s.toggle(e.id);
  assert.equal(e.on, !before);
  assert.equal(e.hist.length, n + 1);
  assert.equal(e.hist[e.hist.length - 1].t, app.clock.now);
  assert.equal(e.hist[e.hist.length - 1].v, e.on ? 1 : 0);
  assert.equal(app.text("toast").indexOf("Lamp") === 0, true);
});

test("a toggle survives a reload", function () {
  var first = boot();
  var was = lamp(first).on;
  first.registry.sensors.toggle("light.living_room_lamp");
  var second = boot({ storage: first.storage.data });
  assert.equal(lamp(second).on, !was, "the lamp forgot its state across a reload");
});

test("tapping a switch tile toggles it; tapping a reading opens the panel", function () {
  var app = boot();
  var tiles = app.qsa("#sensors .sensor");
  var swTile = tiles.filter(function (t) { return t.getAttribute("data-act") === "toggle"; })[0];
  var reading = tiles.filter(function (t) { return t.getAttribute("data-open"); })[0];

  var e = app.registry.sensors.find(swTile.getAttribute("data-arg"));
  var before = e.on;
  app.tap(swTile);
  assert.equal(e.on, !before);
  assert.deepEqual(app.stack(), [], "a toggle must not open a panel");

  app.tap(reading);
  assert.deepEqual(app.stack(), ["sensors"]);
  assert.equal(app.registry.sensors.sel, reading.getAttribute("data-arg"));
});

test("the tile value has a fixed width so the column does not jitter", function () {
  /* Math.round dropped the trailing zero, so the column flickered 72 / 71.9 / 72.1. */
  var app = boot();
  var s = app.registry.sensors;
  var e = s.find("sensor.living_room_temperature");
  e.value = 72;
  assert.equal(s.display(e), "72.0");
  e.value = 71.94;
  assert.equal(s.display(e), "71.9");
  var co2 = s.find("sensor.living_room_co2");
  co2.value = 640.4;
  assert.equal(s.display(co2), "640", "ppm has no decimals");
});

test("demo temperatures follow the unit setting", function () {
  var app = boot();
  var s = app.registry.sensors;
  var e = s.find("sensor.living_room_temperature");
  e.value = 72;
  assert.equal(s.display(e), "72.0");
  assert.equal(s.outUnit(e), "°F");

  app.WP.settings.set("units", "celsius");
  assert.equal(s.outUnit(e), "°C");
  assert.ok(Math.abs(Number(s.display(e)) - 22.2) < 0.05, "got " + s.display(e));

  /* a non-temperature entity is not converted */
  var co2 = s.find("sensor.living_room_co2");
  assert.equal(s.outUnit(co2), "ppm");
});

test("the demo badge says demo and the panel says so exactly once", function () {
  /* CHANGED with the copy sweep. The panel used to say it twice and the two did not agree:
     the subtitle said "nothing here is really happening" and an orange banner fifteen
     centimetres below said "the switches really do change the readings". One notice now,
     in the subtitle; the banner is reserved for a live feed that has stopped answering, so
     its colour means something again. */
  var app = boot();
  assert.equal(app.text("ha-badge"), "demo");
  app.WP.panels.open("sensors");
  assert.match(app.qs('[data-panel="sensors"] [data-sub]').textContent, /Demo data/);
  assert.equal(app.qsa(".demo-note", app.panelBody("sensors")).length, 0,
    "a second demo notice is back in the body");
});

test("live mode is entered only with enabled + baseUrl + token", function () {
  function mode(ha) {
    var cfg = h.defaultConfig();
    cfg.homeAssistant = ha;
    return h.createApp({ config: cfg }).registry.sensors.mode;
  }
  var base = { baseUrl: "http://ha.invalid:8123", token: "t0ken", entities: [] };
  assert.equal(mode(Object.assign({ enabled: true }, base)), "live");
  assert.equal(mode(Object.assign({ enabled: false }, base)), "demo");
  assert.equal(mode({ enabled: true, baseUrl: "", token: "t0ken" }), "demo");
  assert.equal(mode({ enabled: true, baseUrl: "http://ha.invalid:8123", token: "" }), "demo");
  assert.equal(mode({}), "demo");
});

test("the live poll interval is configurable but floored at 5 s", function () {
  /* A mistyped 0 must not turn the panel into a request loop against somebody's HA box. */
  function pollMs(refreshSeconds) {
    var cfg = h.defaultConfig();
    cfg.homeAssistant = {
      enabled: true, baseUrl: "http://ha.invalid:8123", token: "t0ken",
      refreshSeconds: refreshSeconds, entities: []
    };
    return h.createApp({ config: cfg }).registry.sensors.livePollMs;
  }
  assert.equal(pollMs(60), 60000);
  assert.equal(pollMs(15), 15000);
  assert.equal(pollMs(5), 5000);
  assert.equal(pollMs(1), 5000, "1 s would hammer somebody's HA box");
  assert.equal(pollMs(-30), 5000, "a negative interval must not become a request loop");
  assert.equal(pollMs(0), 60000, "0 reads as 'not set' and falls back to the default");
  assert.equal(pollMs(undefined), 60000);
  assert.equal(pollMs("30"), 30000, "a string from a hand-edited config still works");
});

/* ---------------- the trace's y-domain ----------------
   The panel's worst defect, and the reason these tests exist: the sparkline autoscaled to
   whatever range its history happened to contain, so a living room that drifted one degree
   over two hours was drawn as an alpine profile filling a 500 px plot, with no axis on the
   screen to correct the impression. On the only screen that reports on the reader's own
   house, the default state was a false alarm — every day, for ever. */

function traceSpan(app) {
  /* the fraction of the plot's height the drawn line actually uses, 0..1 */
  var line = app.qs('[data-panel="sensors"] .spark-line');
  assert.ok(line, "the trace is not being drawn at all");
  var ys = line.getAttribute("points").split(" ").map(function (p) {
    return parseFloat(p.split(",")[1]);
  });
  return (Math.max.apply(null, ys) - Math.min.apply(null, ys)) / 70;   // viewBox height
}

/* Replace an entity's two hours with a series that swings by `swing` around `base`. */
function drive(app, id, base, swing) {
  var s = app.registry.sensors;
  var e = s.find(id);
  var t = app.clock.now - 7200000;
  e.hist = [];
  for (var i = 0; i <= 240; i++) {
    e.hist.push({ t: t + i * 30000, v: base + (i % 2 ? swing / 2 : -swing / 2) });
  }
  e.value = base;
  app.WP.panels.closeAll();
  app.WP.panels.open("sensors", id);      // onOpen takes the entity as its argument
  return e;
}

test("a degree of drift is drawn as a degree of drift, not as a mountain range", function () {
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 1);
  var span = traceSpan(app);
  assert.ok(span <= 0.3,
    "1 °F of movement fills " + Math.round(span * 100) + "% of the plot; the floor for a"
    + " temperature is 4 °F, so it must fill about a quarter of it");
});

test("a real swing still fills the plot — the floor is a floor, not a clamp", function () {
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 20);
  var span = traceSpan(app);
  assert.ok(span >= 0.6,
    "a 20 °F swing only reached " + Math.round(span * 100) + "% of the plot");
});

test("the floor is per unit, so 1% of humidity and 10 ppm of CO2 read as flat too", function () {
  /* One number would be wrong for at least two of these: 4 is a real change in °F, nothing
     in ppm, and most of the useful range of a percentage. */
  var app = boot();
  drive(app, "sensor.living_room_humidity", 46, 1);
  assert.ok(traceSpan(app) <= 0.3, "1 point of humidity is drawn as movement");
  drive(app, "sensor.living_room_co2", 640, 10);
  assert.ok(traceSpan(app) <= 0.3, "10 ppm of CO2 is drawn as movement");
});

test("the plot prints the range it is drawn at, at both edges", function () {
  /* Without an axis the shape is unopposed: whatever the line does reads as what happened.
     The two figures are the top and the bottom of the y-domain, in the entity's own unit
     and its own decimals, and the ends say which two moments the line spans. */
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 1);
  var body = app.panelBody("sensors");
  var hi = parseFloat(body.querySelector(".plot-hi").textContent);
  var lo = parseFloat(body.querySelector(".plot-lo").textContent);
  assert.ok(hi > lo, "the top of the plot is not above the bottom of it");
  assert.ok(Math.abs((hi - lo) - 4) < 0.2,
    "the axis says " + (hi - lo).toFixed(1) + " °F, the floor is 4");
  assert.match(body.querySelector(".plot-hi").textContent, /°F/, "the range carries no unit");
  assert.equal(body.querySelector(".plot-x").textContent, "2h agonow");
});

test("the panel states ONE range for one series", function () {
  /* The panel used to print two, sixty pixels apart and both labelled °F: the plot corners
     carried the y-DOMAIN (76.4 / 72.4 — the synthetic window the floor above opens up) and
     the stat row directly under them carried the DATA (LOWEST 73.9 / HIGHEST 74.9). Neither
     said which it was, and the pair drawn on the chart was the pair that is not the data.

     The corners are the scale, so the row below is not allowed to be a second scale. Mean,
     spread and net movement are three facts about the series that the axis does not state,
     and none of them is a y-value a reader could hold against the corner labels. */
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 1);
  var body = app.panelBody("sensors");
  var keys = body.querySelectorAll(".stat-k").map(function (n) { return n.textContent; });
  assert.deepEqual(keys, ["Average", "Range", "Change"]);
});

test("a flat two hours says so in words, at a size you can read across a room", function () {
  /* A flat line drawn 250 px wide is still a chart implying that something happened. When
     the drift is under the floor the verdict goes first, in words, at the VALUE tier —
     which is the tier somebody 3 m away can actually read — and the trace behind it becomes
     the evidence rather than the claim. The qualifier names the floor rather than repeating
     the range printed in the grid under it. */
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 1);
  var body = app.panelBody("sensors");
  assert.equal(body.querySelector(".psec .stat-v").textContent, "Steady");
  assert.match(body.querySelector(".psec .stat-x").textContent, /less than 4 °F/);

  /* and a real swing does NOT get the verdict — it gets the chart */
  drive(app, "sensor.living_room_temperature", 75, 20);
  body = app.panelBody("sensors");
  assert.equal(body.querySelector(".psec .stat-v").textContent !== "Steady", true,
    "a 20 °F swing is being called steady");
});

test("when the words say Steady the PICTURE says steady too", function () {
  /* The words landed and the drawing did not, so for a whole round the panel argued with
     itself: `Steady` at the value tier over a line that climbed a visible step and carried
     high-frequency jitter across a 250 px plot. Between a sentence and a picture, the
     picture is the half a person 3 m away believes.

     Two mechanisms, both asserted here because either one alone leaves the contradiction:
     the trace is decimated to ~24 points (a room sensor's sample-to-sample noise is orders
     of magnitude below the 4 °F a person can feel, and drawing every sample draws that
     noise as shape), and the plot is marked .is-flat so the stylesheet can stop it being
     the largest object on the screen. */
  var app = boot();
  drive(app, "sensor.living_room_temperature", 75, 1);
  var body = app.panelBody("sensors");
  var plot = body.querySelector(".plot");
  assert.match(plot.getAttribute("class"), /is-flat/,
    "a flat series still draws a full-height plot");
  var pts = body.querySelector(".spark-line").getAttribute("points").trim().split(/\s+/);
  assert.ok(pts.length <= 24,
    "a flat trace is drawn from " + pts.length + " points; sensor noise is being drawn as shape");

  /* a real swing keeps every sample and the full-height plot — the cap is for the case
     where the panel has already said in words that nothing happened */
  drive(app, "sensor.living_room_temperature", 75, 20);
  body = app.panelBody("sensors");
  assert.equal(/is-flat/.test(body.querySelector(".plot").getAttribute("class") || ""), false,
    "a 20 °F swing is being drawn as if nothing happened");
  assert.ok(body.querySelector(".spark-line").getAttribute("points").trim().split(/\s+/).length > 24,
    "a real swing is being decimated");
});

test("a feed with no readings says so, instead of calling nothing Steady", function () {
  /* Found by pointing the simulator at a Home Assistant that refuses the token — a state
     that is essentially unreachable on a desk, and the one where this panel matters most.
     With zero samples it printed "Steady — less than 4 °F either way in two hours" at the
     value tier, over an empty chart frame whose axis labels ("2.0", "-2.0") were overlaid
     by the word "collecting…", beside a RANGE of "0.0 °F" and two "--". Four separate
     claims about data that did not exist. */
  var app = h.createApp({ bridge: require("./lib/fake-bridge.js").make({}) });
  var s = app.registry.sensors;
  var e = s.ents[0];
  e.hist = [];
  e.value = null;
  e.err = "HTTP 401";
  s.sel = e.id;
  app.WP.panels.open("sensors");
  var body = app.panelBody("sensors");
  var txt = body.textContent;

  assert.equal(/Steady/.test(txt), false, "an empty series was called Steady");
  assert.match(txt, /No readings yet/);
  assert.equal(body.querySelectorAll(".spark").length, 0,
    "an empty series still drew a chart frame");
  assert.equal(/collecting/.test(txt), false, "the empty-chart placeholder is still drawn");

  /* one sample is not a measured range of zero */
  e.hist = [{ t: app.clock.now, v: 71.5 }];
  s.paintPanel();
  var cells = app.qsa('[data-panel="sensors"] .stat').map(function (c) {
    return (c.textContent || "").replace(/\s+/g, " ").trim();
  });
  var range = cells.filter(function (c) { return c.indexOf("Range") === 0; })[0] || "";
  assert.equal(/Range\s*0/.test(range), false,
    "a single reading reported a range of zero: " + range);
});

test("an on/off trace keeps its fixed 0..1 domain and says On / Off on the axis", function () {
  /* A switch has no range to floor: it is high or it is low, and a domain taken from the
     data would redraw a lamp that never moved as noise. */
  var app = boot();
  app.WP.panels.closeAll();
  app.WP.panels.open("sensors", "light.living_room_lamp");
  var body = app.panelBody("sensors");
  assert.equal(body.querySelector(".plot-hi").textContent, "On");
  assert.equal(body.querySelector(".plot-lo").textContent, "Off");
});
