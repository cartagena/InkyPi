/* Wall panel dashboard — WEATHER ICONS (layered, shaded SVG).

   Replaces the U+2600 text glyphs. Those existed to dodge Android's emoji sprites: any
   codepoint with emoji-presentation rendered as a full-colour bitmap the app had no say
   over, so the safe set was monochrome text symbols. Drawing the icons ourselves removes
   the constraint the monochrome rule existed for — every colour below is a token from
   style-theme.css (--ic-*), so the palette is decided in exactly one place and the icons
   follow the theme, not the font.

   WHAT CHANGED, and why it was worth the bytes. The first set was flat: three circles and
   a slab for a cloud, eight straight rays for a sun, four crossed lines for a flake. Flat
   fill is what makes an icon read as a placeholder — the eye gets a silhouette and no
   object. Every primitive here is built the way a paid pack builds one: a single silhouette
   PATH rather than overlapping discs (overlaps are invisible under a flat fill and glaring
   under a gradient), a vertical light-to-dark gradient across it, a rim light where the sky
   would catch it, and a soft shadow where it would not. Nothing is drawn twice at two
   scales — the 28 WMO codes are assembled from seven primitives, so they cannot drift apart.

   MOTION lives in style-icons.css, not here: the shapes carry class names (wxi-rays,
   wxi-cloud, wxi-drop, …) and the stylesheet decides what moves and how fast, off the
   --dur-wx-* motion tokens. It is deliberately applied only to the two icons drawn at hero
   size (the Now card and a panel hero). A 24-hour strip of animated icons is 24 running
   compositor animations for art that is 20 px tall — the motion would be invisible and the
   cost would not.

   GRADIENT IDS are shared and deterministic: two icons that need the same material emit
   the same <defs> with the same id, so whichever copy the document resolves first is by
   construction identical to every other. wrap() emits only the defs an icon actually
   references, so an hourly strip does not carry twenty-four copies of the bolt glow.

   One flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  /* ---------------- materials ----------------
     All colours are var(--ic-*) references — a literal hex here is a test failure
     (icons.test.js), because it would fork the palette away from the stylesheet.
     stop-opacity carries the softness; the hue always stays a token. */

  function lin(id, y1, y2, stops) {
    return '<linearGradient id="' + id + '" x1="0" y1="' + y1 + '" x2="0" y2="' + y2 + '">'
      + stops + "</linearGradient>";
  }
  function stop(off, tok, op) {
    return '<stop offset="' + off + '" stop-color="var(--ic-' + tok + ')"'
      + (op == null ? "" : ' stop-opacity="' + op + '"') + "/>";
  }

  var GRAD = {
    /* cumulus: sky-lit on top, own shadow underneath */
    "wxg-cloud": lin("wxg-cloud", 0, 1,
      stop(0, "cloud-lit") + stop(0.42, "cloud") + stop(1, "cloud-dk")),
    /* the same cloud with the light taken out of it — overcast, and the storm anvil */
    "wxg-cloudd": lin("wxg-cloudd", 0, 1,
      stop(0, "cloud") + stop(0.45, "cloud-dk") + stop(1, "cloud-dkr")),
    /* the soft dark under the belly of a bank, so the base is not a straight cut */
    "wxg-belly": '<radialGradient id="wxg-belly">'
      + stop(0, "cloud-dkr", 0.55) + stop(1, "cloud-dkr", 0) + "</radialGradient>",
    /* the disc: hot centre up and left, cooling to the rim */
    "wxg-sun": '<radialGradient id="wxg-sun" cx="0.38" cy="0.33" r="0.75">'
      + stop(0, "sun-lit") + stop(0.5, "sun") + stop(1, "ray") + "</radialGradient>",
    /* the air around it — this is what a sun looks like through an atmosphere */
    "wxg-halo": '<radialGradient id="wxg-halo">'
      + stop(0, "sun-lit", 0.38) + stop(0.45, "sun", 0.2) + stop(1, "sun", 0)
      + "</radialGradient>",
    "wxg-moon": '<radialGradient id="wxg-moon" cx="0.6" cy="0.34" r="0.8">'
      + stop(0, "moon-lit") + stop(0.55, "moon") + stop(1, "moon-dim") + "</radialGradient>",
    "wxg-starglow": '<radialGradient id="wxg-starglow">'
      + stop(0, "star", 0.5) + stop(1, "star", 0) + "</radialGradient>",
    /* Rain and fog take userSpaceOnUse: a drop's bounding box is a hair wide, so an
       object-box gradient on its stroke degenerates. Every icon shares one 64x64 space,
       so one definition in that space serves all of them. */
    "wxg-rain": '<linearGradient id="wxg-rain" gradientUnits="userSpaceOnUse"'
      + ' x1="0" y1="36" x2="0" y2="64">'
      + stop(0, "rain", 0.12) + stop(0.45, "rain", 0.85) + stop(1, "rain-lit", 1)
      + "</linearGradient>",
    "wxg-fog": '<linearGradient id="wxg-fog" gradientUnits="userSpaceOnUse"'
      + ' x1="4" y1="0" x2="60" y2="0">'
      + stop(0, "fog", 0) + stop(0.22, "fog", 0.95) + stop(0.78, "fog", 0.95)
      + stop(1, "fog", 0) + "</linearGradient>",
    "wxg-bolt": lin("wxg-bolt", 0, 1, stop(0, "bolt-hi") + stop(1, "bolt")),
    "wxg-boltglow": '<radialGradient id="wxg-boltglow">'
      + stop(0, "bolt", 0.42) + stop(1, "bolt", 0) + "</radialGradient>"
  };

  /* ---------------- primitives ---------------- */

  /* The cumulus silhouette, authored once in its own 64-space: four lobes traced as one
     path with a flat base at y=45, spanning x 2..59.5. One path and not four circles
     because a gradient makes every overlap visible, and because a single outline is what
     lets the rim light follow the top edge. */
  var CL_W = 57.5, CL_MID = 30.75, CL_BASE = 45;
  var CL_D = "M 12 45 C 6.5 45 2 40.5 2 35 C 2 30 5.8 25.8 10.7 25.1"
    + " C 12.2 18.6 18 13.8 24.9 13.8 C 31 13.8 36.3 17.6 38.4 23"
    + " C 39.7 22.2 41.2 21.8 42.8 21.8 C 47.6 21.8 51.5 25.7 51.5 30.5"
    + " C 51.5 31.2 51.4 31.9 51.2 32.5 C 55.9 33.3 59.5 37.4 59.5 42.3"
    + " C 59.5 43.8 58.3 45 56.8 45 Z";
  /* the top-left arc of that same outline, offset inward — the edge the sky lights */
  var CL_RIM = "M 3.4 31.8 C 5.3 27.8 8.8 25.6 12.4 25.2"
    + " C 13.8 19 19 14.6 25.3 14.6 C 30.1 14.6 34.4 17 37 21.2";

  /* Placed by where it should SIT, not by a magic translate: centre x, the line its base
     rests on, and how wide it is. Everything else is arithmetic, so moving a bank two
     pixels does not mean re-deriving a scale factor. */
  function cloud(cx, base, w, dark) {
    var s = w / CL_W;
    var tx = cx - s * CL_MID, ty = base - s * CL_BASE;
    return '<g class="wxi-cloud" transform="translate(' + tx.toFixed(2) + " "
      + ty.toFixed(2) + ") scale(" + s.toFixed(3) + ')">'
      + '<path d="' + CL_D + '" fill="url(#wxg-' + (dark ? "cloudd" : "cloud") + ')"/>'
      + '<ellipse cx="31" cy="42" rx="22" ry="5.2" fill="url(#wxg-belly)"/>'
      + '<path d="' + CL_RIM + '" fill="none" stroke="var(--ic-cloud-lit)"'
      + ' stroke-width="2" stroke-linecap="round" opacity="' + (dark ? 0.28 : 0.5) + '"/>'
      + "</g>";
  }

  /* Disc, hot spot, halo, and eight tapered rays. The rays are their own group because
     the stylesheet rocks that group a few degrees and leaves the disc still. */
  function sun(cx, cy, r) {
    var rays = "";
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI / 4) * i + Math.PI / 8;
      var c = Math.cos(a), s = Math.sin(a);
      /* a ray is a wedge, not a stick: wide at the disc, a point at the tip */
      var i1 = r + 3.4, o1 = r + 9.6, hw = 1.9;
      rays += '<path d="M ' + (cx + c * i1 - s * hw).toFixed(1) + " "
        + (cy + s * i1 + c * hw).toFixed(1)
        + " L " + (cx + c * o1).toFixed(1) + " " + (cy + s * o1).toFixed(1)
        + " L " + (cx + c * i1 + s * hw).toFixed(1) + " "
        + (cy + s * i1 - c * hw).toFixed(1) + ' Z"/>';
    }
    return '<circle class="wxi-halo" cx="' + cx + '" cy="' + cy + '" r="' + (r * 2.3).toFixed(1)
      + '" fill="url(#wxg-halo)"/>'
      + '<g class="wxi-rays" fill="var(--ic-ray)">' + rays + "</g>"
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-sun)"/>'
      + '<ellipse cx="' + (cx - r * 0.26).toFixed(1) + '" cy="' + (cy - r * 0.3).toFixed(1)
      + '" rx="' + (r * 0.42).toFixed(1) + '" ry="' + (r * 0.36).toFixed(1)
      + '" fill="var(--ic-sun-lit)" opacity="0.5"/>';
  }

  /* Crescent between an outer circular arc and an inner elliptical terminator.
     p is the synodic phase 0..1 (0 = new). Shared with the Moon widget so the icon in the
     tile and the big disc in the panel are literally the same shape. */
  function moonPath(cx, cy, r, p) {
    var c = Math.cos(2 * Math.PI * p);        // +1 new … 0 quarter … -1 full
    var waxing = p < 0.5;
    var rx = (Math.abs(c) * r).toFixed(2);
    var outer = waxing ? 1 : 0;               // lit limb: right when waxing, left waning
    var inner = waxing ? (c > 0 ? 0 : 1) : (c > 0 ? 1 : 0);
    return "M " + cx + " " + (cy - r)
      + " A " + r + " " + r + " 0 0 " + outer + " " + cx + " " + (cy + r)
      + " A " + rx + " " + r + " 0 0 " + inner + " " + cx + " " + (cy - r) + " Z";
  }

  /* Maria, in the 64-space of a full disc. Placed where the real ones are, roughly, so a
     full moon reads as a face rather than as a plate. */
  var CRATERS = '<circle cx="25" cy="21.5" r="4.4" opacity="0.3"/>'
    + '<circle cx="38.5" cy="26" r="2.6" opacity="0.26"/>'
    + '<circle cx="30" cy="37" r="5.6" opacity="0.22"/>'
    + '<circle cx="43" cy="40.5" r="3" opacity="0.26"/>'
    + '<circle cx="19.5" cy="33" r="2.3" opacity="0.24"/>'
    + '<circle cx="35" cy="46" r="2" opacity="0.2"/>';

  /* The lit limb with its craters, at any size. The craters are CLIPPED to the lit path:
     a crater on the dark side is a crater in shadow, and drawing one there is the single
     detail that makes a phase disc look printed rather than lit. The clip id is derived
     from the phase, so two discs of the same phase share one identical definition and two
     different phases can never collide. */
  function litLimb(cx, cy, r, p) {
    var d = moonPath(cx, cy, r, p);
    var id = "wxm" + Math.round(p * 10000);
    var s = r / 24, tx = cx - s * 32, ty = cy - s * 32;
    return '<clipPath id="' + id + '"><path d="' + d + '"/></clipPath>'
      + '<path d="' + d + '" fill="url(#wxg-moon)"/>'
      + '<g clip-path="url(#' + id + ')" fill="var(--ic-moon-dim)" transform="translate('
      + tx.toFixed(2) + " " + ty.toFixed(2) + ") scale(" + s.toFixed(3) + ')">'
      + CRATERS + "</g>";
  }

  /* The icon moon is a fixed pleasant crescent, not the live phase — at 2.9vh nobody can
     read a gibbous from a quarter, and the Moon tile shows the real phase. */
  function moon(cx, cy, r) {
    return litLimb(cx, cy, r, 0.18);
  }

  /* The Moon widget's disc: the whole body, with the unlit part present as earthshine
     rather than absent. Exported so the tile, the week strip and the panel hero are one
     drawing at three sizes. */
  function moonDisc(p, cls) {
    return '<svg class="' + (cls || "wxi") + '" viewBox="0 0 64 64" aria-hidden="true">'
      + "<defs>" + GRAD["wxg-moon"] + "</defs>"
      + '<circle cx="32" cy="32" r="24" fill="var(--ic-moon-dk)"/>'
      + litLimb(32, 32, 24, p)
      + '<circle cx="32" cy="32" r="24" fill="none" stroke="var(--ic-moon-dim)"'
      + ' stroke-width="0.7" opacity="0.3"/>'
      + "</svg>";
  }

  function star(cx, cy, s) {
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + (s * 2.6).toFixed(1)
      + '" fill="url(#wxg-starglow)"/>'
      + '<path class="wxi-star" d="M ' + cx + " " + (cy - s)
      + " Q " + cx + " " + cy + " " + (cx + s) + " " + cy
      + " Q " + cx + " " + cy + " " + cx + " " + (cy + s)
      + " Q " + cx + " " + cy + " " + (cx - s) + " " + cy
      + " Q " + cx + " " + cy + " " + cx + " " + (cy - s)
      + ' Z" fill="var(--ic-star)"/>';
  }

  /* Falling water. Length, weight and lateral offset all vary — three identical strokes
     is a comb, and a comb is what the old drops looked like. The gradient fades each
     streak out at its top, which is what gives it a direction without drawing an arrow. */
  function drops(n, len, y) {
    var xs = n === 2 ? [25, 39] : [21, 32, 43];
    var k = [1, 0.78, 1.12];
    return '<g class="wxi-rain" stroke="url(#wxg-rain)" stroke-linecap="round" fill="none">'
      + xs.map(function (x, i) {
        var l = len * k[i % 3];
        return '<line class="wxi-drop" stroke-width="' + (2.6 + (i % 2) * 0.8).toFixed(1)
          + '" x1="' + x + '" y1="' + (y + (i % 2) * 2).toFixed(1)
          + '" x2="' + (x - l * 0.3).toFixed(1) + '" y2="' + (y + (i % 2) * 2 + l).toFixed(1)
          + '"/>';
      }).join("") + "</g>";
  }

  /* A six-armed flake with branch ticks, not a plus sign with an X through it. Small
     enough that the branches read as texture rather than as detail, which is the point:
     at 20 px it should still say "snow" and not "asterisk". */
  function flake(cx, cy, r) {
    var arms = "";
    for (var i = 0; i < 3; i++) {
      var a = (Math.PI / 3) * i;
      var c = Math.cos(a), s = Math.sin(a);
      arms += '<line x1="' + (cx - c * r).toFixed(1) + '" y1="' + (cy - s * r).toFixed(1)
        + '" x2="' + (cx + c * r).toFixed(1) + '" y2="' + (cy + s * r).toFixed(1) + '"/>';
      [1, -1].forEach(function (sg) {
        var bx = cx + sg * c * r * 0.62, by = cy + sg * s * r * 0.62;
        var b = a + sg * 0.9, b2 = a - sg * 0.9;
        arms += '<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1)
          + '" x2="' + (bx + Math.cos(b) * r * 0.34 * sg).toFixed(1)
          + '" y2="' + (by + Math.sin(b) * r * 0.34 * sg).toFixed(1) + '"/>'
          + '<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1)
          + '" x2="' + (bx + Math.cos(b2) * r * 0.34 * sg).toFixed(1)
          + '" y2="' + (by + Math.sin(b2) * r * 0.34 * sg).toFixed(1) + '"/>';
      });
    }
    return '<g class="wxi-flake" stroke="var(--ic-snow)" stroke-width="1.3"'
      + ' stroke-linecap="round">' + arms + "</g>";
  }

  function flakes(n, y) {
    var xs = n === 2 ? [25, 40] : [21, 32, 43];
    return xs.map(function (x, i) {
      return flake(x, y + (i === 1 ? 3.5 : 0), i === 1 ? 5.4 : 4.4);
    }).join("");
  }

  /* Glow first, then the bolt, then a hot core down its spine — a flat yellow zigzag is a
     road sign, and the glow is what makes it light. */
  function bolt(dx) {
    var x = dx || 0;
    return '<g class="wxi-bolt" transform="translate(' + x + ' 0)">'
      + '<ellipse cx="34" cy="50" rx="15" ry="14" fill="url(#wxg-boltglow)"/>'
      + '<path d="M 36 36 L 25 52 L 32 52 L 28 64 L 43 47 L 35.5 47 L 40 36 Z"'
      + ' fill="url(#wxg-bolt)"/>'
      + '<path d="M 36.5 39 L 30 50 L 34 50 L 32 58" fill="none"'
      + ' stroke="var(--ic-bolt-hi)" stroke-width="1.2" stroke-linecap="round"'
      + ' opacity="0.75"/></g>';
  }

  /* Fog is layers of air, so it is drawn as layers: bands of different length and weight
     that fade out at both ends instead of stopping at a cap. */
  function fog(y) {
    /* Three bands, not four, and no two the same length or weight. Evenly spaced bands of
       equal length are a barcode — which is exactly what the first attempt drew. */
    var band = [[26, 3.6, 0], [17, 2.5, 5], [22, 3.2, -3]];
    var rows = band.map(function (b, i) {
      return '<line class="wxi-fogband" stroke-width="' + b[1]
        + '" x1="' + (32 + b[2] - b[0]) + '" y1="' + (y + i * 8)
        + '" x2="' + (32 + b[2] + b[0]) + '" y2="' + (y + i * 8) + '"/>';
    }).join("");
    return '<g stroke="url(#wxg-fog)" stroke-linecap="round">' + rows + "</g>";
  }

  /* Only the materials an icon actually references travel with it: a 24-hour strip should
     not carry twenty-four copies of the bolt glow. Sorted, so the same icon is always the
     same string — the tests compare whole icons for equality. */
  function wrap(inner) {
    var need = {}, m, re = /url\(#(wxg-[a-z]+)\)/g;
    while ((m = re.exec(inner))) need[m[1]] = true;
    var defs = Object.keys(need).sort().map(function (k) { return GRAD[k]; }).join("");
    return '<svg class="wxi" viewBox="0 0 64 64" aria-hidden="true">'
      + (defs ? "<defs>" + defs + "</defs>" : "") + inner + "</svg>";
  }

  /* ---------------- composites per WMO group ----------------
     One placement language across all 28: a bank's base sits where the precipitation
     starts, the light source (sun or moon) sits behind its top-left shoulder, and
     anything falling occupies the bottom third. */

  var clearDay = sun(32, 30, 11.5);
  var clearNight = moon(30, 31, 13.5) + star(48, 16, 3.4) + star(53, 33, 2.4)
    + star(41, 47, 2);
  var partlyDay = sun(21, 19, 9.5) + cloud(36, 49, 43);
  var partlyNight = moon(20, 18, 10) + star(52, 15, 2.6) + cloud(36, 49, 43);
  var overcast = cloud(25, 36, 38, true) + cloud(35, 48, 45);
  var foggy = cloud(32, 34, 42) + fog(42);
  var drizzle = cloud(32, 40, 45) + drops(2, 7, 45);
  var rain = cloud(32, 40, 45) + drops(3, 12, 44);
  /* one drop beside one flake: rain that freezes */
  var freezing = cloud(32, 40, 45)
    + '<g class="wxi-rain" stroke="url(#wxg-rain)" stroke-linecap="round" fill="none">'
    + '<line class="wxi-drop" stroke-width="3" x1="24" y1="45" x2="20.5" y2="56"/></g>'
    + flake(40, 51, 5.6);
  var snow = cloud(32, 40, 45) + flakes(3, 51);
  var showersDay = sun(19, 16, 7.5) + cloud(36, 42, 40) + drops(3, 11, 46);
  var showersNight = moon(18, 16, 8) + cloud(36, 42, 40) + drops(3, 11, 46);
  var storm = cloud(32, 38, 46, true) + bolt(0);
  var stormRain = cloud(32, 38, 46, true) + bolt(0)
    + '<g class="wxi-rain" stroke="url(#wxg-rain)" stroke-linecap="round" fill="none">'
    + '<line class="wxi-drop" stroke-width="2.6" x1="19" y1="42" x2="15.5" y2="53"/>'
    + '<line class="wxi-drop" stroke-width="2.6" x1="49" y1="42" x2="45.5" y2="53"/></g>';
  var snowShowersDay = sun(19, 16, 7.5) + cloud(36, 42, 40) + flakes(2, 51);
  var snowShowersNight = moon(18, 16, 8) + cloud(36, 42, 40) + flakes(2, 51);

  /* code -> [day icon, night icon]; text stays in app.js's WMO table. */
  var ICONS = {
    0: [clearDay, clearNight], 1: [clearDay, clearNight],
    2: [partlyDay, partlyNight], 3: [overcast, overcast],
    45: [foggy, foggy], 48: [foggy, foggy],
    51: [drizzle, drizzle], 53: [drizzle, drizzle], 55: [rain, rain],
    56: [freezing, freezing], 57: [freezing, freezing],
    61: [rain, rain], 63: [rain, rain], 65: [rain, rain],
    66: [freezing, freezing], 67: [freezing, freezing],
    71: [snow, snow], 73: [snow, snow], 75: [snow, snow], 77: [snow, snow],
    80: [showersDay, showersNight], 81: [showersDay, showersNight],
    82: [stormRain, stormRain],
    85: [snowShowersDay, snowShowersNight], 86: [snowShowersDay, snowShowersNight],
    95: [storm, storm], 96: [stormRain, stormRain], 99: [stormRain, stormRain]
  };
  var UNKNOWN = wrap('<circle cx="32" cy="32" r="13" fill="none" stroke="var(--ic-fog)"'
    + ' stroke-width="3" opacity="0.7"/>'
    + '<circle cx="32" cy="32" r="3.4" fill="var(--ic-fog)"/>');

  WP.wxIcon = function (code, night) {
    var e = ICONS[code];
    return e ? wrap(night ? e[1] : e[0]) : UNKNOWN;
  };
  /* Exposed for the Moon widget and for the tests. */
  WP.wxIcon.moonPath = moonPath;
  WP.wxIcon.moonDisc = moonDisc;
  WP.wxIcon.codes = Object.keys(ICONS).map(Number);
})();
