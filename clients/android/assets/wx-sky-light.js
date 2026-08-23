/* Wall panel dashboard — SKY MODEL (the half of the sky layer with no canvas in it).

   Given the clock and the sunrise/sunset the API actually reported: what colour is the
   light right now? And, given a WMO code and a cloud percentage: what weather is it?

   This exists as its own file for two reasons. The obvious one is the 500-line budget —
   wx-sky.js could not carry both the painters and this. The better one is that everything
   here is PURE, which means the part of the layer that decides what the panel feels like
   at 6am is testable without a canvas, and is tested at every phase boundary
   (test/sky-light.test.js). The painters can only be looked at; the model can be pinned.

   WHY THE PAYLOAD AND NOT A CLOCK GUESS: the layer used to key off the WMO code alone,
   with a day/night flag, so half past four in December and half past four in June painted
   the same panel. The Open-Meteo payload has carried daily.sunrise / daily.sunset from the
   first request this app ever made; nothing was reading them. A wall panel that knows when
   the sun came up is the difference between a readout and a window.

   THE ALPHA BUDGET, which is the whole discipline: this runs 24/7 on an AMOLED panel where
   a black pixel is an off pixel, and the text on top of it must never have to fight it.
   Every alpha below is part of one budget — the vertical wash tops out at 0.08 and the
   horizon bloom at 0.17, and those two are the only pair that can land on the same pixel
   (at dawn and at dusk the bloom sits low, where the wash is strongest). 0.08 + 0.17 is
   the 0.25 ceiling exactly, with the arithmetic written down rather than hoped for, and
   the real composite measured off the canvas comes in under it because the wash is only
   at ~0.6 of its peak at the height the bloom sits. Colours are near-saturated and the
   ALPHA does the dimming — a pre-dimmed colour at a high alpha would wash the black out,
   cost real power, and light up pixels that ought to be off.
*/

(function () {
  "use strict";

  var MIN = 60000, DAY = 86400000;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function lerp3(a, b, u) {
    return [Math.round(lerp(a[0], b[0], u)),
            Math.round(lerp(a[1], b[1], u)),
            Math.round(lerp(a[2], b[2], u))];
  }

  /* The six moods a day walks through, and every number the painters need to draw one.

       top/sky     the two ends of the vertical gradient: `top` is the ZENITH and `sky` is
                   the horizon. They are separate because a sky is not one colour — at
                   golden hour the bottom of the window is on fire and the top of it is
                   still blue, and a single-colour wash could only ever paint the whole
                   frame one of those two things. It painted the warm one, which is how a
                   five-o'clock August capture came back reading as sepia dust with no
                   blue in it anywhere. Every daytime zenith below is COOL; warmth is a
                   horizon property and the painter keeps it in the bottom fifth.
       wash        how strong that gradient is at the horizon.
       glow/glowA  the sun or the moon: one soft radial bloom, no disc. A disc would be a
                   sticker; a bloom is weather. The DAYTIME bloom is a cool white — the
                   sky next to a high sun is glare, not amber; the warm blooms belong to
                   the hours when the sun is genuinely low.
       glowX/glowY where that bloom sits, 0..1 of the frame. These interpolate, so over a
                   day the light rises in the east (0.17), passes overhead at noon (0.50,
                   high), and sets in the west (0.86) — the arc is real, and it is also
                   why nothing on this layer ever sits on the same pixels twice.
       stars       0..1 visibility multiplier. Not a hard on/off: stars fade out through
                   dawn and back in through dusk, which is what they do.

     Read as a palette: indigo before dawn, a warm bloom on the horizon at dawn, a neutral
     and almost invisible wash at midday, a long amber through golden hour, violet at dusk,
     cold blue at night. Nothing here is a hue you would call digital. */
  var MOODS = {
    night:   { sky: [ 64, 100, 200], top: [ 34,  54, 150], wash: 0.200,
               glow: [158, 176, 238], glowA: 0.280,
               glowX: 0.66, glowY: 0.30, glowR: 0.42, stars: 1.00 },
    predawn: { sky: [ 74,  76, 210], top: [ 44,  52, 168], wash: 0.240,
               glow: [104, 120, 220], glowA: 0.320,
               glowX: 0.20, glowY: 0.94, glowR: 0.58, stars: 0.55 },
    dawn:    { sky: [255, 138,  92], top: [ 86, 124, 214], wash: 0.280,
               glow: [255, 156,  96], glowA: 0.480,
               glowX: 0.17, glowY: 0.89, glowR: 0.46, stars: 0.06 },
    midday:  { sky: [150, 192, 232], top: [ 74, 140, 236], wash: 0.130,
               glow: [214, 232, 255], glowA: 0.170,
               glowX: 0.50, glowY: 0.08, glowR: 0.55, stars: 0.00 },
    golden:  { sky: [255, 152,  62], top: [ 78, 120, 204], wash: 0.280,
               glow: [255, 168,  76], glowA: 0.420,
               glowX: 0.83, glowY: 0.78, glowR: 0.44, stars: 0.00 },
    dusk:    { sky: [176,  98, 214], top: [ 70,  72, 178], wash: 0.260,
               glow: [188,  98, 178], glowA: 0.400,
               glowX: 0.86, glowY: 0.92, glowR: 0.50, stars: 0.35 }
  };

  /* The ceiling this file promises. Exported so a test can assert the table against it
     rather than against numbers copied out of the table, which would prove nothing.

     Recalibrated UP from 0.08/0.17 after looking at captures: at those numbers golden
     hour composited to about six RGB steps above black — the model computed the right
     phase and nobody standing in the room could have told you which. An ambience nobody
     can perceive is not restraint, it is absence. The worst composited pixel is the
     bloom's core over the wash's horizon at dawn (~0.44 of a warm hue), which sits in a
     corner of the frame; the field stays far below it, and midday remains near-nothing
     on purpose — a wall panel at noon should simply look calm. */
  /* Recalibrated a second time, and the note from the first time earned its keep: the
     owner looked at the 0.14/0.30 captures and said "not enough done". The bar is now
     stated as a capture test, not a taste: golden hour, night and dawn must each be
     recognisable in a screenshot at a glance. The worst composited pixel (bloom core
     over the wash horizon, one corner, dawn/golden) reaches ~0.8 of a warm hue; the
     midday frame stays close to black; white text keeps >10:1 against the worst of it,
     labels >4.5:1. */
  /* And DOWN a step again, which is the third recalibration's own logic run backwards: a
     bloom at 0.52 across two thirds of the frame is not ambience you have to look for, it
     is a warm field over three quarters of the screen — a clear-August capture proved it
     by tinting the white type. That light is spent instead on being in the right PLACE:
     smaller radii, and the painter flattens the low ones onto the horizon. */
  var MAX_WASH = 0.28, MAX_GLOW = 0.48;

  /* No payload yet — first boot, or offline, or a location with no forecast. A civil
     12-hour day centred on local noon. It is wrong by up to two hours in midwinter and
     nobody will ever notice, because the only thing riding on it is which of six very dim
     washes is on screen; what would be noticed is a panel that renders nothing. */
  function fallbackSun(now) {
    var d = new Date(now);
    var mid = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    return { rise: mid + 7 * 3600000, set: mid + 19 * 3600000, real: false };
  }

  /* Anything the API can hand back that is not a usable day, mapped onto one that is.
     Open-Meteo answers `null` for both fields inside a polar day or a polar night, and a
     stale cache can produce a sunset before its sunrise. A synthetic civil day is the
     right answer to all of them: this panel lives on a wall in a house, so a missing
     sun time is overwhelmingly a first boot rather than a winter in Tromsø, and an
     ordinary dim day cycle is a better failure than a frozen black rectangle. */
  function normalize(rise, set, now) {
    var r = (rise instanceof Date) ? rise.getTime() : Number(rise);
    var s = (set instanceof Date) ? set.getTime() : Number(set);
    if (!isFinite(r) || !isFinite(s)) return fallbackSun(now);
    var len = s - r;
    if (len <= 0 || len > DAY) return fallbackSun(now);
    return { rise: r, set: s, real: true };
  }

  /* The six moods pinned to the clock the sun actually keeps, as absolute timestamps.

     The offsets are fractions of the day's own length, not fixed hours: a January dusk is
     not a July dusk, and the whole point of reading the payload is to stop pretending they
     are. The min/max bounds are what keeps a 20-hour Alaskan June from producing a
     three-hour "golden hour" that is really just afternoon.

     Night and midday appear TWICE, and that repetition is the shape of the whole model. A
     stop list interpolates across every gap it has, so with one stop per mood the panel
     would spend the small hours already sliding toward dawn and mid-afternoon already
     sliding toward gold — three in the morning would be lit like five. A repeated stop is
     a plateau: night holds flat from the middle of the night until a couple of hours
     before sunrise, midday holds flat across the middle of the day, and the moods that
     really are transitions get the transitions to themselves. */
  function stops(rise, set) {
    var dayLen = set - rise;
    var nightLen = DAY - dayLen;
    var dawnLead = clamp(nightLen * 0.16, 12 * MIN, 80 * MIN);
    var dawnTail = clamp(dayLen * 0.05, 10 * MIN, 45 * MIN);
    var goldLead = clamp(dayLen * 0.10, 15 * MIN, 85 * MIN);
    var duskTail = clamp(nightLen * 0.16, 12 * MIN, 80 * MIN);

    var out = [
      { t: rise - nightLen / 2, k: "night" },      /* the middle of the night */
      { t: rise - dawnLead * 2.5, k: "night" },    /* still fully dark */
      { t: rise - dawnLead, k: "predawn" },
      { t: rise + dawnTail, k: "dawn" },
      { t: rise + dayLen * 0.30, k: "midday" },    /* morning is over */
      /* WHEN THE AFTERNOON STARTS TO TURN, and this is the line that made a five-o'clock
         August panel look like a sepia photograph. It used to be `set - goldLead * 4`,
         which on a fourteen-hour day is five and a half hours before sunset: the sky was
         already two thirds of the way into golden at three in the afternoon, when a real
         one is still flatly blue. Golden hour is not the afternoon.

         It is a RAMP LENGTH backwards from the golden stop now, not a multiple of the
         lead: the ramp only has to be long enough that nothing in it is caught moving
         (no channel may step more than a couple of levels a minute, and the bloom's alpha
         swings furthest here), and 130 minutes clears that in every season — where a
         multiple of a seasonal lead gave December ninety minutes and June four hours. */
      { t: set - goldLead * 0.45 - clamp(dayLen * 0.16, 130 * MIN, 200 * MIN), k: "midday" },
      { t: set - goldLead * 0.45, k: "golden" },   /* golden hour peaks before sunset */
      { t: set + duskTail, k: "dusk" },
      { t: set + duskTail * 2.5, k: "night" },     /* dark again */
      { t: set + nightLen / 2, k: "night" }
    ];
    /* Monotonic, or the interpolation walks backwards through the day. A polar summer has
       no night to hang a pre-dawn on and the API will happily report a 24-hour day;
       clamping each stop up to its predecessor COLLAPSES the phases that have no room
       instead of inverting them, so the degenerate case is "midday all day", which is
       exactly what a polar summer looks like. */
    for (var i = 1; i < out.length; i++) {
      if (out[i].t < out[i - 1].t) out[i].t = out[i - 1].t;
    }
    return out;
  }

  /* The light at an instant. Everything the painters read comes out of here.

     Interpolated with a smoothstep rather than a straight ramp, because a linear blend
     still has a corner in it at each stop and a corner is a thing the eye catches. With
     the ease, each mood lingers around its own hour and hands over in the middle — the
     panel is never seen changing, but 6am and 8pm are unmistakably different rooms. */
  function at(now, rise, set) {
    var sun = normalize(rise, set, now);
    var st = stops(sun.rise, sun.set);
    var i = 0;
    while (i < st.length - 2 && now >= st[i + 1].t) i++;
    var a = st[i], b = st[i + 1];
    var span = b.t - a.t;
    var u = span <= 0 ? 1 : clamp((now - a.t) / span, 0, 1);
    var e = u * u * (3 - 2 * u);
    var A = MOODS[a.k], B = MOODS[b.k];
    return {
      from: a.k, to: b.k, mix: e,
      /* the mood it READS as — whichever end of the blend is winning */
      phase: e < 0.5 ? a.k : b.k,
      sky: lerp3(A.sky, B.sky, e),
      top: lerp3(A.top, B.top, e),
      wash: lerp(A.wash, B.wash, e),
      glow: lerp3(A.glow, B.glow, e),
      glowA: lerp(A.glowA, B.glowA, e),
      glowX: lerp(A.glowX, B.glowX, e),
      glowY: lerp(A.glowY, B.glowY, e),
      glowR: lerp(A.glowR, B.glowR, e),
      stars: lerp(A.stars, B.stars, e),
      sun: sun
    };
  }

  /* ---------------- what the weather does to the light ----------------
     Kept here with the rest of the pure arithmetic; the painters just multiply. */

  /* Cloud eats the bloom and the stars, in that order. An overcast dawn has no bloom in
     it at all, which is the honest picture and also the reason the layer stops being
     pretty exactly when the weather stops being pretty. The floor of 0.2 on the bloom is
     so an overcast day is not a black rectangle — there is still light up there. */
  function dim(light, cloudPct) {
    var c = clamp((isFinite(cloudPct) ? cloudPct : 0) / 100, 0, 1);
    return {
      glow: clamp(1 - c * 0.8, 0.2, 1),
      stars: clamp(1 - c * 1.15, 0, 1),
      wash: clamp(1 - c * 0.35, 0.5, 1)
    };
  }

  /* Meteorological wind direction is where the wind comes FROM, so a 270° westerly has to
     push the rain toward the RIGHT of a frame whose x grows east. Screen-east component of
     the direction the air is travelling is sin(dir + 180°), i.e. -sin(dir).

     `slant` is dx/dy for a falling drop, capped at 0.7 (~35°): past that, rain stops
     reading as rain and starts reading as scratches ruled across the type. Speed arrives
     in whatever unit the panel is set to, so the caller converts to km/h first — 45 km/h
     is where the cap is reached, which is a gale and looks like one. */
  function wind(speedKmh, dirDeg) {
    var s = isFinite(speedKmh) ? Math.max(0, speedKmh) : 0;
    var dir = isFinite(dirDeg) ? dirDeg : 270;
    var east = -Math.sin(dir * Math.PI / 180);
    return {
      slant: clamp(s / 45, 0, 1) * 0.7 * east,
      /* how hard the air is moving at all, regardless of which way: drives cloud speed
         and the sideways drift of snow */
      force: clamp(s / 45, 0, 1),
      east: east
    };
  }

  /* Where the horizon is, and how hard it is glowing.

     The layer had a bloom and a vertical wash and nothing in between, so a sunrise read as
     a bright corner over a dark rectangle: there was light in the frame but no PLACE for it
     to be coming from. A horizon is the line that makes a wash into a sky.

     It is not a decoration bolted on at a fixed height — it is where the model already says
     the light is (glowY), and it only exists while the light is low. `low` is 0 at noon and
     1 once the bloom has sunk to the bottom of the frame, so the band grows in through dusk
     and is simply absent at midday, which is what a horizon does when the sun is overhead.

     The alpha is a third of the bloom's, which is the whole reason this is safe: the bloom
     is the budgeted element (MAX_GLOW) and this rides at a fraction of it, in the same
     colour, in the same part of the frame it was already lighting. */
  function horizon(light) {
    var low = clamp((light.glowY - 0.55) / 0.38, 0, 1);
    return { y: light.glowY, a: light.glowA * low * 0.34, spread: 0.055 + low * 0.055 };
  }

  /* How many cloud banks the real cover percentage is worth. Not a fixed six: a 15%-cover
     sky with six banks in it is not partly cloudy, it is overcast with gaps. Zero is a
     legal answer — a clear sky should draw nothing. */
  function banks(cloudPct, max) {
    var c = clamp((isFinite(cloudPct) ? cloudPct : 0) / 100, 0, 1);
    return Math.round(c * (max || 9));
  }

  /* ---------------- what weather it is ---------------- */

  /* WMO code -> scene. Pure and exported: the tests pin every code to a scene so a new
     code cannot silently fall through to "clear" while the icon shows a thunderstorm. */
  function sceneFor(code) {
    if (code === 0 || code === 1) return "clear";
    if (code === 2) return "partly";
    if (code === 3) return "cloudy";
    if (code === 45 || code === 48) return "fog";
    if (code >= 51 && code <= 57) return "drizzle";
    if (code >= 71 && code <= 77) return "snow";
    if (code === 85 || code === 86) return "snow";
    if (code === 82 || code === 95 || code === 96 || code === 99) return "storm";
    if (code >= 61 && code <= 67) return "rain";
    if (code === 80 || code === 81) return "rain";
    return "clear";
  }

  /* The code and cloud_cover can disagree — the code is a human-readable summary, the
     percentage is a model output, and "Overcast, 41%" is a thing Open-Meteo says. The Now
     card prints the code, so the code wins as a floor (and, for partly, as a ceiling): a
     panel captioned "Thunderstorm" must never have a clear sky drawn behind the caption. */
  var COVER = {
    clear: [0, 25], partly: [35, 70], cloudy: [80, 100], fog: [90, 100],
    drizzle: [70, 100], rain: [85, 100], snow: [85, 100], storm: [90, 100]
  };
  function coverFor(scene, pct) {
    var b = COVER[scene] || [0, 100];
    /* `pct == null` before isFinite, because isFinite(null) is TRUE — Number(null) is 0 —
       and a missing reading would otherwise silently mean "a clear sky". */
    var c = (pct == null || !isFinite(pct)) ? (b[0] + b[1]) / 2 : Number(pct);
    return clamp(c, b[0], b[1]);
  }

  /* "#9aa8b8" + alpha -> "rgba(154,168,184,a)". Every colour on this layer is a --ic-*
     token, a token is a hex string, and canvas gradients need the channels apart. */
  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
    var r = m ? parseInt(m[1], 16) : 154, g = m ? parseInt(m[2], 16) : 168,
        b = m ? parseInt(m[3], 16) : 184;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }


  /* ---------------- the populations ----------------
     Everything the painter animates, built here because it is data, not drawing: the
     star-magnitude distribution (the fix for "reads as dust" — uniform dots are noise, a
     distribution is a sky), the depth-graded rain and snow fields, the parallax cloud
     banks, and the floor-hugging fog. The painter (wx-sky.js) owns what they look like
     per frame; this file owns what exists. */
  function populate(w, h, MAXCLOUD, MAXDROP, MAXFLAKE) {

      var f = {}, i, m, z;
      function rnd() { return Math.random(); }
      /* DEPTH IS STRATIFIED, not sampled. Seven fog banks drawn from a uniform random
         depth can all land in the middle of the range — and a field with no near member
         and no far one is a field with no parallax in it, which is a scene that renders
         as a smear perhaps one night in twenty. Each member takes its own slice of the
         range and jitters inside it, so the spread is guaranteed and the arrangement is
         still never the same twice. It also puts the field in painter's order: the near
         flakes are drawn last, over the far ones, which is where they belong. */
      function depth(k, n) { return (k + rnd()) / n; }

      f.stars = [];
      for (i = 0; i < 170; i++) {
        /* Magnitude, power-curved: a great many faint, a handful bright. This IS the fix
           for "reads as dust" — uniform dots are noise, a distribution is a sky. */
        m = Math.pow(rnd(), 1.8);
        f.stars.push({
          x: rnd() * w,
          /* biased upward: the sky is denser away from the horizon, and it keeps the
             busiest part of the layer off the bottom of the frame where the dense rows of
             type live */
          y: Math.pow(rnd(), 0.72) * h * 0.88,
          r: 0.5 + m * 3.1, m: m,
          /* On a curve, not a line. 0.10 + 0.34m put the whole field inside a third of a
             stop of each other, so a capture showed a dozen near-identical faint points —
             which is dust, not a sky. A real field is mostly nothing with a handful of
             genuinely bright stars in it; the exponent is what buys those few. */
          a: 0.04 + Math.pow(m, 1.6) * 0.52,       /* ceiling 0.56 — a sky, not a rumour */
          /* two incommensurate rates per star, so the field never blinks in step */
          sp: 0.18 + rnd() * 0.34, sp2: 0.07 + rnd() * 0.16,
          ph: rnd() * 6.28, ph2: rnd() * 6.28
        });
      }

      f.drops = [];
      for (i = 0; i < MAXDROP; i++) {
        z = depth(i, MAXDROP);                      /* depth: 0 far, 1 near */
        f.drops.push({
          x: rnd() * w * 1.4 - w * 0.2, y: rnd() * h, z: z,
          v: 240 + z * 470,
          /* Length varies WITHIN a depth band as well as across it. Three bands of three
             identical streak lengths is a comb; real rain has long drops next to short
             ones at the same distance because they are at different points of their fall.
             The near band runs LONGER than it did (the far one is untouched), which is the
             other half of the fix for "discrete blue dashes with gaps between them": more
             streaks, thinner, and the near ones drawn out rather than chopped. */
          l: (5 + z * 30) * (0.7 + rnd() * 0.6)
        });
      }

      /* SNOW IS FEWER, SOFTER AND MORE UNEQUAL than it was. Ninety flakes of graded size
         at a nearly flat alpha came out as grey dots sitting on DEMO, HUMID and NEWS —
         read as dead pixels rather than as weather, which is the same verdict the star
         field got two rounds ago and for the same reason: a population without a
         distribution is noise. So the alpha now falls away with depth on a curve rather
         than a line (the far half is a rumour, the near few are the snow), the smallest
         flake is a dot rather than a pixel, and a quarter of them carry the out-of-focus
         bloom instead of a tenth. Sixty-four, not ninety: the count that was buying
         density is spent on the ones you can actually see. */
      f.flakes = [];
      for (i = 0; i < MAXFLAKE; i++) {
        z = depth(i, MAXFLAKE);
        f.flakes.push({
          x: rnd() * w, y: rnd() * h, z: z,
          /* TWO LAYERS, not a ramp. The far half is a dot a pixel across drifting slowly;
             the near few are five or six pixels of soft white falling three times as fast.
             A linear 1..3.5 spread put every flake within two pixels of every other, which
             at 711 px is not a depth cue at all — it is one field of identical specks,
             which is exactly the "dust on the glass" verdict this has now earned twice. */
          r: 0.9 + Math.pow(z, 1.7) * 4.2, v: 10 + z * z * 62,
          /* the nearest third carry the out-of-focus bloom — a snowfall is not made of
             hard dots, and it is the depth cue a STILL frame can carry */
          soft: z > 0.68,
          sw: 0.22 + rnd() * 0.55, ph: rnd() * 6.28
        });
      }

      f.clouds = [];
      for (i = 0; i < MAXCLOUD; i++) {
        z = depth(i, MAXCLOUD);
        f.clouds.push({
          x: rnd() * w * 1.6 - w * 0.3,
          /* far banks ride higher, near ones hang low — the parallax the flat version had
             none of */
          y: h * (0.02 + 0.56 * (1 - z) + rnd() * 0.24),
          /* Bigger, and no two the same shape. The old banks were half a screen wide and
             all the same proportions, which reads as wallpaper; a real bank is wider than
             the frame and the next one along is a different animal. */
          /* Scale contrast on a curve, because that is what parallax IS: a far bank is
             half the width of a near one and drifts at a fifth of the speed. 150..410 was
             not a ratio the eye could read as distance — it read as two smudges. */
          rx: 95 + z * z * 420, sq: 0.24 + rnd() * 0.22, z: z, v: 1.2 + z * z * 9
        });
      }

      /* THE FOG BANKS. Seven layers, graded by depth exactly as the rain and snow fields
         are, because the reason the first two fogs read as grey paint is that they had no
         depth at all: five full-width rects at one alpha is one rect at five times the
         alpha, whatever you space them at.

         Near banks (z high) hang low, are tall and slow and stronger; far ones ride
         higher, are thin and quick and faint. Each is wider than the frame so it can never
         show an end, and each breathes on a slow rate of its own so no two are ever at the
         same density. The painter stamps a lumpy sprite into that box, which is where the
         variation ALONG a bank comes from. */
      f.bands = [];
      for (i = 0; i < 7; i++) {
        z = depth(i, 7);
        f.bands.push({
          /* fog sits on the floor of the frame, because that is where fog sits */
          y: h * (0.46 + 0.50 * z + rnd() * 0.10),
          rx: w * (0.55 + z * 0.55), hh: 26 + z * 92,
          x: rnd() * w * 1.6 - w * 0.3, v: 10 - z * 7,
          a: 0.042 + z * 0.070,
          br: 0.035 + rnd() * 0.055, ph: rnd() * 6.28
        });
      }

      /* AND THE BANKS ALOFT. The seven above lie on the floor of the frame, where fog
         lies — and where, on this panel, four opaque cards cover them completely. These
         four drift across the top third, which is the only sky the layout actually
         leaves open; see paintFog for why that is honest rather than a cheat. */
      f.aloft = [];
      for (i = 0; i < 4; i++) {
        z = depth(i, 4);
        f.aloft.push({
          y: h * (0.03 + 0.30 * z), rx: w * (0.6 + z * 0.6), hh: 40 + z * 90,
          x: rnd() * w * 1.6 - w * 0.3, v: 12 - z * 8,
          a: 0.05 + z * 0.055, br: 0.03 + rnd() * 0.05, ph: rnd() * 6.28
        });
      }

      f.flashNext = 4000 + Math.random() * 9000;
      return f;
    
  }

  WP.skyLight = {
    at: at,
    populate: populate,
    stops: stops,
    normalize: normalize,
    fallbackSun: fallbackSun,
    dim: dim,
    wind: wind,
    banks: banks,
    horizon: horizon,
    sceneFor: sceneFor,
    coverFor: coverFor,
    rgba: rgba,
    MOODS: MOODS,
    MAX_WASH: MAX_WASH,
    MAX_GLOW: MAX_GLOW,
    PHASES: ["night", "predawn", "dawn", "midday", "golden", "dusk"]
  };
})();
