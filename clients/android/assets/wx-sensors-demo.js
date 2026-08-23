/* Wall panel dashboard — HOME ASSISTANT DEMO SIMULATOR.

   Everything that makes the sensors card believable with no Home Assistant configured:
   the demo entity definitions, the seeded two-hour history, and the forward stepper.
   wx-sensors.js owns state, rendering and the live feed; it calls seed()/step() here and
   exposes defs as its demoDefs. Loaded BEFORE wx-sensors.js — the widget reads
   WP.sensorsDemo.defs while its object literal parses.

   The model in one paragraph: every numeric entity is pulled toward a target (a base
   level plus a daily sinusoid plus the effect of whatever is switched on) with a random
   kick scaled as sqrt(dt), and both the seed and the stepper use the same reversion/noise
   pair so the trace has no seam where the synthesised past hands over to the live tick.
   Switches are walked BACKWARDS from their current state in randomised dwell runs, and
   the numerics are integrated forward along that same timeline — the lamp having been on
   an hour ago shows up in the living-room temperature an hour ago too.

   One file, one job (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var HA_STATE_KEY = "inky.ha.v1";        // same key the widget persists toggles under

  /* deterministic PRNG so seeded history is stable across a repaint */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Glyphs are text-presentation symbols from the Geometric Shapes / Misc Symbols blocks,
     not emoji (Android draws emoji as full-colour sprites). Switch-like entities carry
     TWO glyphs and swap on state: filled = energised, hollow = not — legible at 2-4 m in
     a way a colour shift is not. The lamp sits fifth so the capped home card (first five
     entities) still demos a switch. */
  var defs = [
    { id: "sensor.living_room_temperature", label: "Living room", short: "Living", icon: "⌂",
      unit: "°F", base: 72.5, amp: 2.4, phase: 16,
      tau: 900000, noise: 0.018, min: 62, max: 84, dp: 1 },
    { id: "sensor.bedroom_temperature", label: "Bedroom", short: "Bed", icon: "☾",
      unit: "°F", base: 70.0, amp: 1.9, phase: 15,
      tau: 900000, noise: 0.016, min: 60, max: 82, dp: 1 },
    { id: "sensor.outside_temperature", label: "Outside", short: "Outside", icon: "☀",
      unit: "°F", base: 68.0, amp: 11.0, phase: 16,
      tau: 600000, noise: 0.056, min: 38, max: 105, dp: 1 },
    { id: "sensor.living_room_humidity", label: "Humidity", short: "Humid", icon: "☂",
      unit: "%", base: 46, amp: 7, phase: 4,
      tau: 600000, noise: 0.11, min: 22, max: 78, dp: 0 },
    { id: "light.living_room_lamp", label: "Lamp", short: "Lamp", icon: "●", iconOff: "○",
      kind: "toggle", domain: "light",
      dwell: { on: [25 * 60000, 95 * 60000], off: [18 * 60000, 70 * 60000] } },
    { id: "sensor.living_room_co2", label: "CO₂", short: "CO₂", icon: "≈",
      unit: "ppm", base: 640, amp: 190, phase: 21,
      tau: 300000, noise: 3.8, min: 400, max: 1800, dp: 0 },
    { id: "sensor.house_power", label: "Power", short: "Power", icon: "↯",
      unit: "W", base: 430, amp: 210, phase: 19,
      tau: 60000, noise: 18, min: 80, max: 4200, dp: 0 },
    { id: "switch.office_fan", label: "Office fan", short: "Fan", icon: "◆", iconOff: "◇",
      kind: "toggle", domain: "switch",
      dwell: { on: [12 * 60000, 40 * 60000], off: [22 * 60000, 90 * 60000] } },
    { id: "binary_sensor.front_door", label: "Front door", short: "Door", icon: "▯",
      iconOff: "▮", kind: "binary", onText: "Open", offText: "Closed",
      dwell: { on: [40000, 160000], off: [7 * 60000, 25 * 60000] } }
  ];

  /* the pull toward target decays over the entity's own time constant; the random kick
     scales as sqrt(dt) like any diffusion — shared by the seed and the stepper */
  function reversion(def, dtMs) { return 1 - Math.exp(-dtMs / (def.tau || 300000)); }
  function noiseFor(sensors, def, dtMs) { return def.noise * Math.sqrt(dtMs / sensors.tickMs); }

  /* Where the model is pulling toward right now: a base level plus a daily sinusoid,
     plus the effect of whatever is switched on. */
  function target(def, when, flags) {
    var h = when.getHours() + when.getMinutes() / 60;
    var v = def.base + def.amp * Math.sin(2 * Math.PI * (h - def.phase + 6) / 24);
    if (def.id === "sensor.living_room_temperature" && flags.lamp) v += 1.4;
    if (def.id === "sensor.bedroom_temperature" && flags.fan) v -= 0.9;
    if (def.id === "sensor.house_power") {
      if (flags.lamp) v += 9;
      if (flags.fan) v += 48;
    }
    if (def.id === "sensor.living_room_co2" && flags.door) v -= 220;
    if (def.id === "sensor.living_room_humidity" && flags.door) v += 4;
    return v;
  }

  function liveFlags(sensors) {
    var f = {};
    sensors.ents.forEach(function (e) {
      if (e.id === "light.living_room_lamp") f.lamp = e.on;
      if (e.id === "switch.office_fan") f.fan = e.on;
      if (e.id === "binary_sensor.front_door") f.door = e.on;
    });
    return f;
  }

  /* Walk an on/off entity backwards from its current state in randomised dwell times and
     sample the resulting runs onto the shared grid. The newest run is only partly
     elapsed (the state did not change the instant the app booted), and the last sample
     is by construction the current state, so the seeded past joins the live data with no
     invented step. Deterministic per entity id. */
  function seedSwitch(e, times, now) {
    var d = (e.def && e.def.dwell) || { on: [1500000, 3600000], off: [1500000, 3600000] };
    var rnd = mulberry32(hashStr(e.id + "|runs"));
    function span(on) { var r = on ? d.on : d.off; return r[0] + rnd() * (r[1] - r[0]); }

    var segs = [], end = now, v = e.on ? 1 : 0, first = true, full = 0, part = 0;
    while (end > times[0]) {
      var dur = span(v === 1);
      if (first) { full = dur; part = dur * (0.10 + rnd() * 0.75); dur = part; first = false; }
      segs.push({ from: end - dur, to: end, v: v });
      end -= dur;
      v = 1 - v;
    }
    segs.reverse();                                   // oldest first
    var si = 0;
    e.hist = times.map(function (ts) {
      while (si < segs.length - 1 && ts >= segs[si].to) si++;
      return { t: ts, v: segs[si].v };
    });
    e.last = segs[segs.length - 1].from;              // when the current run began
    /* the door's live stepper carries on from where the seeded run left off */
    if (e.kind === "binary") e.nextFlip = now + Math.max(20000, full - part);
  }

  /* Build the entities and their two hours of history. `sensors` is the widget. */
  function seed(sensors) {
    var saved = WP.store.readJSON(HA_STATE_KEY, {}) || {};
    var now = Date.now();
    var step = sensors.sampleMs;
    var times = [];
    for (var t = now - sensors.windowMs; t <= now; t += step) times.push(t);

    sensors.ents = defs.map(function (def) {
      return {
        id: def.id, label: def.label, short: def.short || def.label,
        icon: def.icon, iconOff: def.iconOff, unit: def.unit || "",
        kind: def.kind || "numeric", domain: def.domain, dp: def.dp,
        def: def, hist: [], on: !!saved[def.id], last: now
      };
    });

    /* switches first — the numeric model reads their timeline as it integrates */
    var sw = {};
    sensors.ents.forEach(function (e) {
      if (e.kind === "numeric") return;
      if (e.kind === "binary") e.on = false;          // the door starts closed
      seedSwitch(e, times, now);
      sw[e.id] = e;
    });
    function at(e, i) { return !!(e && e.hist[i] && e.hist[i].v >= 0.5); }
    function flagsAt(i) {
      return {
        lamp: at(sw["light.living_room_lamp"], i),
        fan:  at(sw["switch.office_fan"], i),
        door: at(sw["binary_sensor.front_door"], i)
      };
    }

    sensors.ents.forEach(function (e) {
      if (e.kind !== "numeric") return;
      var rnd = mulberry32(hashStr(e.id));
      var k = reversion(e.def, step), n = noiseFor(sensors, e.def, step);
      var v = target(e.def, new Date(times[0]), flagsAt(0));
      e.hist = times.map(function (ts, i) {
        var tgt = target(e.def, new Date(ts), flagsAt(i));
        v += (tgt - v) * k + (rnd() * 2 - 1) * n;
        v = Math.max(e.def.min, Math.min(e.def.max, v));
        return { t: ts, v: v };
      });
      e.value = v;
    });
    sensors.lastSample = now;
  }

  /* One simulation tick: numerics diffuse toward target, the door flips on its dwell. */
  function step(sensors) {
    var now = Date.now(), f = liveFlags(sensors);
    var takeSample = (now - sensors.lastSample >= sensors.sampleMs);

    sensors.ents.forEach(function (e) {
      if (e.kind === "numeric") {
        var tgt = target(e.def, new Date(now), f);
        e.value += (tgt - e.value) * reversion(e.def, sensors.tickMs)
          + (Math.random() * 2 - 1) * noiseFor(sensors, e.def, sensors.tickMs);
        e.value = Math.max(e.def.min, Math.min(e.def.max, e.value));
      } else if (e.kind === "binary" && now >= e.nextFlip) {
        /* a door that opens for a minute or two, then closes for several — the same
           dwell ranges the seeded history was built from */
        var d = e.def.dwell;
        e.on = !e.on;
        var r = e.on ? d.on : d.off;
        e.nextFlip = now + r[0] + Math.random() * (r[1] - r[0]);
        e.last = now;
        sensors.sample(e, now);          // show the edge immediately, not up to 30 s late
        return;
      }
      if (takeSample) sensors.sample(e, now);
    });
    if (takeSample) sensors.lastSample = now;
  }

  WP.sensorsDemo = {
    defs: defs, seed: seed, step: step,
    /* the model itself stays reachable: the tests pin its statistics (decay bounds,
       sqrt-dt noise, target phase) rather than trusting the pretty trace */
    reversion: reversion, noiseFor: noiseFor, target: target, flags: liveFlags
  };
})();
