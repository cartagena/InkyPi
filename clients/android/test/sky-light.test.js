/* The sky layer's pure half (assets/wx-sky-light.js).

   The painters can only be judged by looking at a screenshot. This — which mood the panel
   is in, what colour the light is, how hard the rain leans — is arithmetic, and arithmetic
   gets pinned. The layer runs 24 hours a day for years on somebody's wall, so the two
   things worth being ruthless about are (a) it never jumps, because a jump is the one
   thing a person walking past would actually catch, and (b) it never exceeds its alpha
   budget, because the budget is what keeps the text readable and the panel from burning in.

   Every phase boundary is walked, a whole day is walked minute by minute, and the
   degenerate inputs — no payload at all, a polar day, a polar night, a corrupt cache — are
   pinned to a defined answer rather than left to whatever NaN does. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

var L = h.createApp({}).WP.skyLight;

var MIN = 60000, HOUR = 3600000, DAY = 86400000;

/* A June-ish day: up at 05:41, down at 20:16, in whatever zone the machine is in — the
   app reads local ISO stamps with no offset, so local is the only zone that exists here. */
function day(y, m, d) {
  function at(hh, mm) { return new Date(y, m, d, hh, mm, 0, 0).getTime(); }
  return { at: at, rise: at(5, 41), set: at(20, 16), midnight: at(0, 0) };
}
var D = day(2025, 5, 10);

function everyMinute(from, to, fn) {
  for (var t = from; t <= to; t += MIN) fn(t);
}

/* ---------------- the phases, and the boundaries between them ---------------- */

test("the stops walk night -> predawn -> dawn -> midday -> golden -> dusk -> night", function () {
  var st = L.stops(D.rise, D.set);
  /* night and midday repeat: a repeated stop is a PLATEAU, and the plateaus are what stop
     three in the morning from being lit like five. See the comment on stops(). */
  assert.equal(st.map(function (s) { return s.k; }).join(" "),
    "night night predawn dawn midday midday golden dusk night night");
  for (var i = 1; i < st.length; i++) {
    assert.ok(st[i].t >= st[i - 1].t,
      "stop " + st[i].k + " lands before " + st[i - 1].k);
  }
  /* the whole cycle is exactly one day: half a night before sunrise to half a night after
     sunset is 24 hours, which is what makes the model wrap without a seam */
  assert.equal(st[st.length - 1].t - st[0].t, DAY);
});

test("AT a stop the light is that mood exactly — no blend bleeding across a boundary", function () {
  /* This is the phase-boundary pin the whole model rests on: the stop times are where each
     of the six moods is at full strength, so a table edit that broke the lookup would show
     up here rather than as a colour nobody can name.

     mix is 0 at every stop but the last, where there is no following segment to open and
     the model is sitting at the far end of the one behind it — either way the record must
     equal the mood's own row exactly. */
  var st = L.stops(D.rise, D.set);
  st.forEach(function (s, i) {
    var got = L.at(s.t, D.rise, D.set);
    var want = L.MOODS[s.k];
    assert.equal(got.mix, i === st.length - 1 ? 1 : 0, "mix at the " + s.k + " stop");
    assert.equal(got.phase, s.k, "the " + s.k + " stop reads as " + got.phase);
    assert.equal(got.sky.join(","), want.sky.join(","), s.k + " sky colour");
    assert.equal(got.wash, want.wash, s.k + " wash");
    assert.equal(got.glowA, want.glowA, s.k + " bloom alpha");
    assert.equal(got.stars, want.stars, s.k + " star visibility");
    assert.equal(got.glowX, want.glowX, s.k + " bloom x");
  });
});

test("every one of the six moods is actually reached over a day, in order", function () {
  var seen = [];
  everyMinute(D.midnight, D.midnight + DAY, function (t) {
    var p = L.at(t, D.rise, D.set).phase;
    if (seen[seen.length - 1] !== p) seen.push(p);
  });
  /* a calendar day starts and ends in the night, so night appears at both ends */
  assert.deepEqual(seen, ["night", "predawn", "dawn", "midday", "golden", "dusk", "night"]);
  L.PHASES.forEach(function (p) {
    assert.ok(seen.indexOf(p) !== -1, "the day never reaches " + p);
  });
});

test("the hours a person would name land in the mood they would name", function () {
  function phaseAt(hh, mm) { return L.at(D.at(hh, mm), D.rise, D.set).phase; }
  assert.equal(phaseAt(3, 0), "night", "3am");
  assert.equal(phaseAt(4, 45), "predawn", "an hour before sunrise");
  assert.equal(phaseAt(6, 0), "dawn", "just after sunrise");
  assert.equal(phaseAt(13, 0), "midday", "early afternoon");
  assert.equal(phaseAt(19, 40), "golden", "half an hour before sunset");
  assert.equal(phaseAt(21, 0), "dusk", "three quarters of an hour after sunset");
  assert.equal(phaseAt(23, 30), "night", "half eleven");
});

/* ---------------- it must never be caught moving ---------------- */

test("nothing in the light jumps: a whole day, minute by minute, is continuous", function () {
  /* The one artefact a person on the far side of a room WOULD notice is a cut.

     The colours are measured COMPOSITED — channel x alpha, i.e. what actually reaches the
     glass over black — because a bare channel delta is meaningless at these alphas: the
     wash colour swings 180 points through dawn, but at 0.078 alpha that is fourteen
     levels out of 255 spread over two hours. Half a level a minute is the bar, and half a
     level a minute is well under what anybody could catch. */
  var prev = null, worst = { wash: 0, glow: 0, washA: 0, glowA: 0, glowX: 0, glowY: 0, stars: 0 };
  function lit(l, key, aKey) {
    return [l[key][0] * l[aKey], l[key][1] * l[aKey], l[key][2] * l[aKey]];
  }
  everyMinute(D.midnight, D.midnight + DAY, function (t) {
    var l = L.at(t, D.rise, D.set);
    if (prev) {
      [["wash", "sky", "wash"], ["glow", "glow", "glowA"]].forEach(function (c) {
        var a = lit(l, c[1], c[2]), b = lit(prev, c[1], c[2]);
        for (var i = 0; i < 3; i++) worst[c[0]] = Math.max(worst[c[0]], Math.abs(a[i] - b[i]));
      });
      ["washA", "glowA", "glowX", "glowY", "stars"].forEach(function (k) {
        var kk = k === "washA" ? "wash" : k;
        worst[k] = Math.max(worst[k], Math.abs(l[kk] - prev[kk]));
      });
    }
    prev = l;
  });
  /* One RGB level per minute is the real invisibility criterion — a single-level change
     is imperceptible even side by side, let alone sixty seconds apart. The old 0.5 pin
     was not a threshold anybody chose; it was whatever the first amplitude table
     happened to produce, and it broke the moment the ambience was raised to visible. */
  /* Two RGB levels per minute is still invisibility: dawn's full swing now spans ~130
     levels and the transitions are 25 minutes long, so the worst minute moves ~1.4
     levels — imperceptible sixty seconds apart, and the price of an ambience that is
     visible at all. */
  assert.ok(worst.wash <= 2.0, "the wash steps " + worst.wash.toFixed(3) + " levels a minute");
  assert.ok(worst.glow <= 2.0, "the bloom steps " + worst.glow.toFixed(3) + " levels a minute");
  assert.ok(worst.washA <= 0.004, "the wash alpha steps " + worst.washA + " per minute");
  assert.ok(worst.glowA <= 0.004, "the bloom alpha steps " + worst.glowA + " per minute");
  assert.ok(worst.glowX <= 0.01, "the bloom slides " + worst.glowX + " of the frame a minute");
  assert.ok(worst.glowY <= 0.01, "the bloom rises " + worst.glowY + " of the frame a minute");
  assert.ok(worst.stars <= 0.01, "the stars fade " + worst.stars + " a minute");
});

test("the light does move — a day is not one flat colour", function () {
  /* The other half of the continuity check. A model that returned a constant would pass
     every "no jumps" assertion above and be useless. */
  var dawn = L.at(D.at(6, 0), D.rise, D.set);
  var noon = L.at(D.at(13, 0), D.rise, D.set);
  var night = L.at(D.at(2, 0), D.rise, D.set);
  assert.ok(dawn.sky[0] - dawn.sky[2] > 60, "dawn is not warm");
  assert.ok(night.sky[2] - night.sky[0] > 60, "night is not cold");
  assert.ok(noon.wash < dawn.wash / 1.6, "midday's wash is not the quiet one");
  assert.equal(noon.stars, 0, "there are stars out at one in the afternoon");
  assert.equal(night.stars, 1, "the night has no stars in it");
  /* the bloom crosses the frame east to west over the day, which is both the real sun and
     the reason a bright spot never sits on the same pixels */
  assert.ok(dawn.glowX < 0.3 && noon.glowX > 0.4 && noon.glowX < 0.6,
    "the sun does not rise in the east");
  assert.ok(L.at(D.at(19, 40), D.rise, D.set).glowX > 0.75, "the sun does not set in the west");
});

/* ---------------- the alpha budget ---------------- */

test("no mood exceeds the stated alpha budget, and no pair of them can together", function () {
  /* The budget is the product decision: black pixels are off pixels and the text must
     never have to fight the background. The ceiling was first set at 0.25 composited —
     and the captures showed why that was wrong: golden hour rendered ~6 RGB steps above
     black, an ambience no one in the room could perceive. It is 0.45 now, carried
     entirely by the bloom's core over the wash's horizon — one corner of the frame at
     dawn/golden — while midday stays near-nothing and the star field keeps its own 0.22
     ceiling. Raised by LOOKING, not by drift: if this number moves again it should be
     because a capture demanded it, in either direction. */
  Object.keys(L.MOODS).forEach(function (k) {
    var m = L.MOODS[k];
    assert.ok(m.wash <= L.MAX_WASH, k + " wash " + m.wash + " over budget");
    assert.ok(m.glowA <= L.MAX_GLOW, k + " bloom " + m.glowA + " over budget");
    m.sky.concat(m.glow).forEach(function (ch) {
      assert.ok(ch >= 0 && ch <= 255, k + " has a channel outside 0..255");
    });
  });
  /* 0.80: the second recalibration, made because the owner looked at the 0.44-budget
     captures and said "not enough done". The worst pixel is still one corner of the
     frame at dawn/golden; the midday frame stays near black; and the capture set under
     shots/day is the evidence this number was set by eye, not by drift. */
  assert.ok(L.MAX_WASH + L.MAX_GLOW <= 0.80, "the budget itself does not add up");

  var worst = 0;
  everyMinute(D.midnight, D.midnight + DAY, function (t) {
    var l = L.at(t, D.rise, D.set);
    worst = Math.max(worst, l.wash + l.glowA);
  });
  assert.ok(worst <= 0.80, "the composited ambience peaks at " + worst.toFixed(3));
});

/* ---------------- the seasons, which is the point of reading the payload ---------------- */

test("a December day and a June day are different panels at the same clock time", function () {
  var win = day(2025, 11, 15);
  var wRise = win.at(7, 22), wSet = win.at(16, 34);
  /* 17:00: high summer is still broad daylight, mid-December is already past sunset */
  var summer = L.at(D.at(17, 0), D.rise, D.set);
  var winter = L.at(win.at(17, 0), wRise, wSet);
  assert.equal(summer.phase, "midday", "five o'clock in June is not full daylight");
  assert.ok(winter.phase === "golden" || winter.phase === "dusk",
    "five o'clock in December reads as " + winter.phase);
  assert.ok(winter.stars > summer.stars, "the short day has no more night in it");
  assert.ok(winter.sky[0] > summer.sky[0], "the December panel is not the warmer one");
  /* and an hour later the short day has gone over into dusk with the stars coming back,
     while June is only just starting to warm toward its own gold */
  assert.equal(L.at(win.at(18, 0), wRise, wSet).phase, "dusk");
  assert.equal(L.at(D.at(18, 0), D.rise, D.set).stars, 0, "stars out at six on a June evening");
});

test("golden hour is proportional to the day, not a fixed number of minutes", function () {
  var win = day(2025, 11, 15);
  function goldenLen(rise, set) {
    var st = L.stops(rise, set);
    var g = 0, d = 0;
    st.forEach(function (s) { if (s.k === "golden") g = s.t; if (s.k === "dusk") d = s.t; });
    return d - g;
  }
  var longDay = goldenLen(D.rise, D.set);
  var shortDay = goldenLen(win.at(7, 22), win.at(16, 34));
  assert.ok(longDay > shortDay, "a 14-hour day golden-hours no longer than a 9-hour one");
  /* and both stay inside the bounds that stop "golden hour" from becoming "afternoon" */
  [longDay, shortDay].forEach(function (v) {
    assert.ok(v > 20 * MIN && v < 3 * HOUR, "golden hour is " + Math.round(v / MIN) + " min");
  });
});

/* ---------------- degenerate inputs ---------------- */

test("with no payload at all the panel still has a sun", function () {
  /* First boot, or offline, or a location the forecast does not cover. The app must render;
     a black rectangle with no ambience is a worse failure than a generic civil day. */
  [undefined, null, NaN, "", "not a date"].forEach(function (bad) {
    var l = L.at(D.at(13, 0), bad, bad);
    assert.equal(l.sun.real, false, "claims a real sun for " + String(bad));
    assert.equal(l.phase, "midday", "one in the afternoon is not midday for " + String(bad));
    assert.ok(l.wash > 0 && l.wash <= L.MAX_WASH);
    assert.equal(l.sky.length, 3);
  });
  var f = L.fallbackSun(D.at(13, 0));
  assert.equal(f.set - f.rise, 12 * HOUR, "the fallback day is not twelve hours");
  assert.equal(new Date(f.rise).getHours(), 7);
  assert.equal(new Date(f.set).getHours(), 19);
});

test("the fallback still walks all six moods, so an offline panel is not frozen", function () {
  var seen = {};
  everyMinute(D.midnight, D.midnight + DAY, function (t) {
    seen[L.at(t, null, null).phase] = true;
  });
  L.PHASES.forEach(function (p) {
    assert.ok(seen[p], "an offline panel never reaches " + p);
  });
});

test("a sunset before its sunrise, or a day longer than a day, falls back", function () {
  /* A stale cache, a timezone the API and the device disagree about, a hand-edited
     fixture. Whatever produced it, it is not a day, and the model says so rather than
     interpolating backwards through six moods. */
  assert.equal(L.normalize(D.set, D.rise, D.at(13, 0)).real, false, "backwards day accepted");
  assert.equal(L.normalize(D.rise, D.rise, D.at(13, 0)).real, false, "zero-length day accepted");
  assert.equal(L.normalize(D.rise, D.rise + DAY + HOUR, D.at(13, 0)).real, false,
    "a 25-hour day accepted");
  /* exactly 24 hours IS a legal answer — it is a polar summer, see below */
  assert.equal(L.normalize(D.rise, D.rise + DAY, D.at(13, 0)).real, true);
});

test("a polar summer collapses to daylight instead of inverting the day", function () {
  /* Open-Meteo reports a 24-hour day above the circle in June. There is no night to hang a
     pre-dawn on, so the stops that have no room collapse onto each other; what must never
     happen is a stop landing before the one in front of it, which would run the
     interpolation backwards and strobe the panel. */
  var rise = D.midnight, set = D.midnight + DAY;
  var st = L.stops(rise, set);
  for (var i = 1; i < st.length; i++) {
    assert.ok(st[i].t >= st[i - 1].t, "polar summer inverts at " + st[i].k);
  }
  var seen = {};
  everyMinute(rise, set, function (t) { seen[L.at(t, rise, set).phase] = true; });
  assert.ok(seen.midday, "a polar summer is not mostly daylight");
  assert.ok(!seen.night, "a polar summer has a night in it");
  assert.equal(L.at(rise + 12 * HOUR, rise, set).stars, 0, "stars at polar noon");
});

test("a polar winter is twilight and night, and never inverts either", function () {
  /* The other end: the sun clears the horizon for a few minutes, or the API hands back a
     sunrise and sunset a minute apart. Every daytime stop collapses into that minute. */
  var rise = D.at(12, 0), set = D.at(12, 1);
  var st = L.stops(rise, set);
  for (var i = 1; i < st.length; i++) {
    assert.ok(st[i].t >= st[i - 1].t, "polar winter inverts at " + st[i].k);
  }
  assert.equal(L.at(D.at(3, 0), rise, set).phase, "night", "3am in a polar winter");
  assert.equal(L.at(D.at(23, 0), rise, set).phase, "night", "11pm in a polar winter");
  var noon = L.at(D.at(12, 0), rise, set);
  assert.ok(noon.stars < 1, "the sun never troubles the stars at all");
});

test("a time far outside the modelled day is night, not a crash and not a NaN", function () {
  /* The payload carries TODAY's sun times and refreshes every fifteen minutes, but a
     tablet that lost the network at teatime will still be drawing at four in the morning
     off yesterday's numbers. Both ends of the range are night, so clamping is honest. */
  [D.midnight - 2 * DAY, D.midnight + 3 * DAY].forEach(function (t) {
    var l = L.at(t, D.rise, D.set);
    assert.equal(l.phase, "night");
    assert.ok(isFinite(l.wash) && isFinite(l.glowA) && isFinite(l.glowX));
    l.sky.forEach(function (c) { assert.ok(isFinite(c), "a NaN channel"); });
  });
});

/* ---------------- what the weather does to the light ---------------- */

test("cloud eats the bloom and then the stars", function () {
  var clear = L.dim(null, 0), half = L.dim(null, 50), solid = L.dim(null, 100);
  assert.equal(clear.glow, 1);
  assert.equal(clear.stars, 1);
  assert.ok(half.glow < clear.glow && half.glow > solid.glow);
  assert.equal(solid.stars, 0, "stars through solid overcast");
  assert.ok(solid.glow >= 0.2, "an overcast noon has no light in the sky at all");
  /* stars go before the bloom does: thin cloud still has a moon behind it */
  assert.ok(L.dim(null, 70).stars < L.dim(null, 70).glow);
  /* nonsense in, sane out */
  assert.equal(L.dim(null, undefined).glow, 1);
  assert.equal(L.dim(null, 400).stars, 0);
  assert.equal(L.dim(null, -20).stars, 1);
});

test("rain leans the way the wind is actually blowing", function () {
  /* Meteorological direction is where the wind comes FROM. A westerly (270) must push the
     rain toward the right of a frame whose x grows east; an easterly (90) to the left.
     Getting this backwards is the kind of thing nobody spots and everybody feels. */
  assert.ok(L.wind(30, 270).slant > 0.3, "a westerly does not push the rain right");
  assert.ok(L.wind(30, 90).slant < -0.3, "an easterly does not push the rain left");
  assert.ok(Math.abs(L.wind(30, 0).slant) < 0.01, "a northerly slants the rain sideways");
  assert.ok(Math.abs(L.wind(30, 180).slant) < 0.01, "a southerly slants the rain sideways");
  assert.equal(L.wind(0, 270).slant, 0, "still air slants the rain");
  /* capped: past about 35 degrees rain reads as scratches ruled across the type */
  assert.ok(Math.abs(L.wind(200, 270).slant) <= 0.7, "a hurricane is uncapped");
  assert.equal(L.wind(200, 270).force, 1);
  /* a payload with holes in it must not produce NaN in a canvas coordinate */
  [undefined, null, NaN].forEach(function (bad) {
    assert.ok(isFinite(L.wind(bad, bad).slant), "wind(" + String(bad) + ") is not finite");
    assert.ok(isFinite(L.wind(10, bad).slant));
  });
});

test("how many cloud banks is the real cover percentage", function () {
  assert.equal(L.banks(0, 9), 0, "a clear sky draws cloud");
  assert.equal(L.banks(100, 9), 9);
  assert.equal(L.banks(50, 9), 5);
  assert.equal(L.banks(undefined, 9), 0);
  assert.equal(L.banks(160, 9), 9, "over 100% cover");
  assert.equal(L.banks(-5, 9), 0);
});

test("the code overrules a cloud percentage that contradicts the card", function () {
  /* The Now card prints the WMO code's own words. A panel captioned "Thunderstorm" with a
     clear sky drawn behind it is the layer disagreeing with the card, which is the one
     thing this layer exists not to do. */
  assert.ok(L.coverFor("storm", 5) >= 90, "a storm drew a clear sky");
  assert.ok(L.coverFor("rain", 0) >= 85, "rain drew a clear sky");
  assert.ok(L.coverFor("partly", 100) <= 70, "partly cloudy drew solid overcast");
  assert.ok(L.coverFor("clear", 90) <= 25, "a clear sky drew overcast");
  /* no reading at all -> the middle of the band the code implies */
  assert.equal(L.coverFor("partly", undefined), 52.5);
  assert.equal(L.coverFor("clear", null), 12.5);
});

test("a token hex survives the trip into a canvas gradient", function () {
  assert.equal(L.rgba("#9aa8b8", 0.1), "rgba(154,168,184,0.1)");
  assert.equal(L.rgba("  #CFD4FF  ", 0), "rgba(207,212,255,0)");
  /* a token that came back empty (no cascade, or a typo in the var name) must not put
     "rgba(NaN,...)" into a fillStyle, which silently paints nothing */
  assert.equal(L.rgba("", 0.2), "rgba(154,168,184,0.2)");
  assert.equal(L.rgba("var(--nope)", 0.2), "rgba(154,168,184,0.2)");
});
