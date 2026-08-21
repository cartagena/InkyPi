/* Wall panel dashboard — WEATHER ICONS (layered, shaded SVG).

   Replaces the U+2600 text glyphs. Those existed to dodge Android's emoji sprites: any
   codepoint with emoji-presentation rendered as a full-colour bitmap the app had no say
   over, so the safe set was monochrome text symbols. Drawing the icons ourselves removes
   the constraint the monochrome rule existed for — every colour below is a token from
   style-theme.css (--ic-*), so the palette is decided in exactly one place and the icons
   follow the theme, not the font.

   HOW A SHAPE IS BUILT, and why it is worth the bytes. Flat fill is what makes an icon
   read as a placeholder — the eye gets a silhouette and no object. So every primitive is
   built the way a paid pack builds one: a single silhouette PATH rather than overlapping
   discs, a RADIAL gradient placed where the light is rather than a top-to-bottom ramp (a
   vertical ramp is a cylinder, and a cylinder is what "clip-art" looks like at hero size),
   a rim light where the sky would catch the edge, a soft shadow under the belly, and — on
   the two icons big enough for it to register — a static noise texture that takes the
   compass off the outline. Nothing is drawn twice at two scales: the 28 WMO codes are
   assembled from seven primitives, so they cannot drift apart.

   ONE MASS PER CLOUD is the rule that took the longest to learn. Overcast used to be two
   cloud() calls stacked, and under a flat fill nobody could see the join; under a gradient
   the overlap is a seam running through the middle of the biggest drawing in the product.
   Every composite here draws at most one cumulus and, where the sky wants a heavier look,
   swaps the silhouette for the wider DECK — never two silhouettes in one mass.

   MATERIALS are in wx-icons-mat.js and MOTION in style-icons.css. The shapes carry class
   names (wxi-rays, wxi-cloud, wxi-mass, wxi-drop, …); the stylesheet decides what moves
   and what carries the expensive filter, off the --dur-wx-* tokens.

   One flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  /* ---------------- primitives ---------------- */

  /* The cumulus silhouette, authored once in its own 64-space: four lobes traced as one
     path with a scalloped base, spanning x 2..59.5. One path and not four circles because
     a gradient makes every overlap visible, and because a single outline is what lets the
     rim light follow the top edge. */
  var CL_D = "M 12 45 C 6.5 45 2 40.5 2 35 C 2 30 5.8 25.8 10.7 25.1"
    + " C 12.2 18.6 18 13.8 24.9 13.8 C 31 13.8 36.3 17.6 38.4 23"
    + " C 39.7 22.2 41.2 21.8 42.8 21.8 C 47.6 21.8 51.5 25.7 51.5 30.5"
    + " C 51.5 31.2 51.4 31.9 51.2 32.5 C 55.9 33.3 59.5 37.4 59.5 42.3"
    + " C 59.5 43.8 58.3 45 56.8 45"
    /* THE BASE IS SCALLOPED, not ruled: a cumulus with a flat bottom sits on an invisible
       shelf — the one edge in the drawing that no light and no shadow could explain. */
    + " C 50.5 46.3 45.5 46.3 40.5 45 C 34.5 46.4 28 46.4 22.5 45"
    + " C 18.5 45.8 15 45.8 12 45 Z";
  /* The top-left arc of that same outline, offset inward — the edge the sky lights. Thin
     and bright rather than thick and pale: a wide soft rim is a haze that fills the lobe
     and flattens it. */
  var CL_RIM = "M 4.6 32.6 C 6.2 28.6 9.2 26.5 12.6 26"
    + " C 14.1 19.8 19.2 15.5 25.3 15.5 C 29.9 15.5 34 17.8 36.5 21.8";
  /* AND THE RIGHT LOBE GETS ONE TOO, much fainter — it is a sphere in the same sky and
     catches the same light, at a glancing angle. Struck as a circular arc inside the
     lobe's own outline so it cannot stray outside the shape. */
  var CL_RIM_R = "M 42.8 23.3 A 7.2 7.2 0 0 1 49.6 28";
  /* Where one lobe tucks behind the next. A single gradient over a single silhouette gives
     the eye one surface; these two soft creases are what say "four lobes". */
  var CL_FOLD = "M 12.4 26.4 C 14.2 32.5 14 38.6 13 43.8"
    + "M 38.2 24 C 40.5 29.5 41.4 36.6 41 43.8";

  /* THE DECK: overcast and the storm anvil. Wider than the cumulus, half again as flat,
     and — the point — still ONE outline. Its creases run across it rather than down it,
     because what makes a grey sky read as overcast is layers stacked to the horizon, not
     lobes stacked into a heap. */
  var OV_D = "M 8 47 C 3.6 47 1 43.8 1.6 40.2 C 2.2 36.9 5 34.6 8.4 34.6"
    + " C 8.6 30.2 12.2 26.8 16.6 26.8 C 18.4 22.4 22.7 19.4 27.6 19.4"
    + " C 32.6 19.4 36.9 22.5 38.6 27 C 40 26.1 41.7 25.6 43.5 25.6"
    + " C 48.2 25.6 52 29.2 52.5 33.8 C 57.3 34.6 60.9 38.4 60.9 43"
    + " C 60.9 45.2 59.1 47 56.9 47"
    + " C 48 48.5 39 48.5 30.5 47 C 22.5 48.4 15.5 48.4 8 47 Z";
  var OV_RIM = "M 3.2 39.6 C 3.8 37 5.9 35.6 8.9 35.6"
    + " C 9.2 31.6 12.6 28.4 16.9 28.2 C 18.8 24 22.9 21 27.6 21";
  var OV_RIM_R = "M 43.5 27.2 A 7.4 7.4 0 0 1 50.7 33.2";
  /* The deck's creases run ACROSS it, not down it, and they are cut in the belly colour
     rather than the body colour: at the height they sit the surrounding fill has already
     gone to the shadow grey, so a mid-grey stroke there reads as a bright rule scored
     across the cloud — which is what the first draft looked like. */
  var OV_FOLD = "M 6.2 36.6 C 18 34.4 34 34.9 56 36.9"
    + "M 10.5 42.2 C 25 40.5 40 40.8 55.5 42.4";

  var CUMULUS = { W: 57.5, MID: 30.75, BASE: 45, D: CL_D, RIM: CL_RIM, RIM2: CL_RIM_R,
                  FOLD: CL_FOLD, FTOK: "cloud-dk", FOP: 0.34, BX: 29.5 };
  var DECK = { W: 59.9, MID: 31.25, BASE: 47, D: OV_D, RIM: OV_RIM, RIM2: OV_RIM_R,
               FOLD: OV_FOLD, FTOK: "cloud-dkr", FOP: 0.5, BX: 31 };

  /* Placed by where it should SIT, not by a magic translate: centre x, the line its base
     rests on, and how wide it is. Everything else is arithmetic.

     The mass is nested one group deep on purpose. The bob lives on .wxi-cloud and the
     texture filter on .wxi-mass, so the filtered raster is produced once and then
     composited by the transform above it — an animated geometry under a filter is a
     repaint every frame, which is exactly what the 855 cannot afford. */
  function body(art, cx, base, w, dark) {
    var s = w / art.W;
    var tx = cx - s * art.MID, ty = base - s * art.BASE;
    return '<g class="wxi-cloud" transform="translate(' + tx.toFixed(2) + " "
      + ty.toFixed(2) + ") scale(" + s.toFixed(3) + ')"><g class="wxi-mass">'
      + '<path d="' + art.D + '" fill="url(#wxg-' + (dark ? "cloudd" : "cloud") + ')"/>'
      /* TWO bellies. One ellipse softened the centre of the base and left the rest of it
         a straight cut; the second is wider, fainter and offset, so the shadow runs the
         whole width of the base and thins unevenly along it. Both sit ENTIRELY inside the
         silhouette: they used to hang a few units under it, invisible under a flat fill
         and — once the noise filter arrived — a scatter of specks below the cloud. */
      + '<ellipse cx="' + art.BX + '" cy="' + (art.BASE - 3.4).toFixed(1) + '" rx="'
      + (art.W * 0.47).toFixed(1) + '" ry="5" fill="url(#wxg-belly)" opacity="0.42"/>'
      + '<ellipse cx="' + (art.BX + 1.5) + '" cy="' + (art.BASE - 5).toFixed(1) + '" rx="'
      + (art.W * 0.38).toFixed(1) + '" ry="4.2" fill="url(#wxg-belly)"/>'
      + '<path d="' + art.FOLD + '" fill="none" stroke="var(--ic-' + art.FTOK + ')"'
      + ' stroke-width="1.7" stroke-linecap="round" opacity="' + art.FOP + '"/>'
      + '<path d="' + art.RIM + '" fill="none" stroke="url(#wxg-rim)"'
      + ' stroke-width="1.25" stroke-linecap="round" opacity="' + (dark ? 0.5 : 0.9) + '"/>'
      + '<path d="' + art.RIM2 + '" fill="none" stroke="url(#wxg-rim)"'
      + ' stroke-width="1.1" stroke-linecap="round" opacity="' + (dark ? 0.18 : 0.32) + '"/>'
      + "</g></g>";
  }
  function cloud(cx, base, w, dark) { return body(CUMULUS, cx, base, w, dark); }
  function deck(cx, base, w) { return body(DECK, cx, base, w, true); }

  /* What a bolt does to the cloud it just left, and the one mark that tells a storm from a
     dark cumulus in a STILL frame: a warm bloom pressed up under the belly. Drawn outside
     the mass so the texture filter never touches it — a blurred gradient through a
     displacement map is expensive and looks like nothing. */
  function underglow(cx, base, w) {
    return '<ellipse class="wxi-underglow" cx="' + cx + '" cy="' + (base - 2).toFixed(1)
      + '" rx="' + (w * 0.46).toFixed(1) + '" ry="' + (w * 0.19).toFixed(1)
      + '" fill="url(#wxg-underglow)"/>';
  }

  /* Core, corona, halo and rays — a sun is a light source, and a light source is layers.

     The rays are SHORT and the disc is LARGE, which is the opposite of the first draft: a
     pack is judged on ink, not on bounding box, and eight thin spikes around a small disc
     read as a small object beside a cumulus carrying ~790 units of solid fill. There are
     two ray sets now — eight wedges that rock, and eight long thin ones between them that
     turn very slowly — because a single ring of spikes is a compass rose and two rings at
     different rates is glare. */
  function rayRing(cx, cy, i0, o0, hw) {
    var out = "";
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI / 4) * i + Math.PI / 8;
      var c = Math.cos(a), s = Math.sin(a);
      /* a ray is a wedge, not a stick: wide at the disc, a point at the tip */
      out += '<path d="M ' + (cx + c * i0 - s * hw).toFixed(1) + " "
        + (cy + s * i0 + c * hw).toFixed(1)
        + " L " + (cx + c * o0).toFixed(1) + " " + (cy + s * o0).toFixed(1)
        + " L " + (cx + c * i0 + s * hw).toFixed(1) + " "
        + (cy + s * i0 - c * hw).toFixed(1) + ' Z"/>';
    }
    return out;
  }
  function sun(cx, cy, r) {
    /* ORDER IS THE WHOLE OF IT. The first layered sun drew both ray sets underneath the
       corona, which is a soft bright disc a third again the radius — so the rays were
       painted and then painted over, and the icon came out as a plain glowing ball. Air
       first, then the light travelling through it. */
    return '<circle class="wxi-halo" cx="' + cx + '" cy="' + cy + '" r="'
      + (r * 2).toFixed(1) + '" fill="url(#wxg-halo)"/>'
      + '<circle class="wxi-halo-in" cx="' + cx + '" cy="' + cy + '" r="'
      + (r * 1.5).toFixed(1) + '" fill="url(#wxg-corona)"/>'
      + '<g class="wxi-rays2" fill="var(--ic-ray)" opacity="0.42" transform="rotate(22.5 '
      + cx + " " + cy + ')">'
      + rayRing(cx, cy, r * 1.3, r * 1.95, r * 0.055) + "</g>"
      + '<g class="wxi-rays" fill="var(--ic-ray)">'
      + rayRing(cx, cy, r * 1.18, r * 1.72, r * 0.19) + "</g>"
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-sun)"/>'
      + '<ellipse cx="' + (cx - r * 0.26).toFixed(1) + '" cy="' + (cy - r * 0.3).toFixed(1)
      + '" rx="' + (r * 0.42).toFixed(1) + '" ry="' + (r * 0.36).toFixed(1)
      + '" fill="var(--ic-sun-lit)" opacity="0.5"/>';
  }

  /* The moon body, drawn in wx-icons-moon.js and shared with the Moon widget — see that
     file's header for why it is not in here. */
  var moon = WP.moonArt.body;

  /* A star is a garnish, not a subject. Four of them at sparkle size beside a thin crescent
     made the night glyph read as an emoji; two small ones beside a real disc read as sky. */
  function star(cx, cy, s) {
    return '<g opacity="0.72"><circle cx="' + cx + '" cy="' + cy + '" r="' + (s * 2.1).toFixed(1)
      + '" fill="url(#wxg-starglow)"/>'
      + '<path class="wxi-star" d="M ' + cx + " " + (cy - s)
      + " Q " + cx + " " + cy + " " + (cx + s) + " " + cy
      + " Q " + cx + " " + cy + " " + cx + " " + (cy + s)
      + " Q " + cx + " " + cy + " " + (cx - s) + " " + cy
      + " Q " + cx + " " + cy + " " + cx + " " + (cy - s)
      + ' Z" fill="var(--ic-star)"/></g>';
  }

  /* Falling water. ONE rake angle and ONE gap below the belly for every streak in the
     pack, so three streaks never read as three mistakes — but length, weight and alpha all
     vary a little, and every streak BOWS.

     The bow is the detail that costs nothing and does the most: a drop is pushed sideways
     harder the longer it has been falling, so its track is a shallow curve, and three
     ruled parallel lines of identical length is the single thing that makes rain read as
     a hatch pattern rather than as weather. */
  var RAKE = 0.26;                            /* horizontal drift per unit of fall */
  var RAIN_GAP = 3.2;                         /* every streak starts this far under the base */
  function streak(x, y, l, w, op) {
    var dx = l * RAKE;
    return '<path class="wxi-drop" fill="none" stroke-width="' + w + '"'
      + (op == null ? "" : ' opacity="' + op + '"')
      + ' d="M ' + x.toFixed(1) + " " + y.toFixed(1)
      + " Q " + (x - dx * 0.28).toFixed(1) + " " + (y + l * 0.6).toFixed(1)
      + " " + (x - dx).toFixed(1) + " " + (y + l).toFixed(1) + '"/>';
  }
  function rainGroup(inner) {
    return '<g class="wxi-rain" stroke="url(#wxg-rain)" stroke-linecap="round"'
      + ' fill="none">' + inner + "</g>";
  }
  function drops(n, len, base) {
    var xs = n === 2 ? [26, 39] : [20.5, 32, 43.5];
    var k = n === 2 ? [1, 0.78] : [0.82, 1.12, 0.9];
    var wt = n === 2 ? [2.9, 2.4] : [2.5, 3.1, 2.7];
    var op = n === 2 ? [1, 0.66] : [0.72, 1, 0.82];
    return rainGroup(xs.map(function (x, i) {
      return streak(x, base + RAIN_GAP, len * k[i], wt[i], op[i]);
    }).join(""));
  }

  /* A six-armed flake with branch ticks, not a plus sign with an X through it — and a soft
     bloom behind it, because at hero size a flake is a lit crystal with air glowing round
     it and a bare wire drawing is a diagram. */
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
    return '<g class="wxi-flake">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 1.9).toFixed(1)
      + '" fill="url(#wxg-bloom)"/>'
      + '<g stroke="var(--ic-snow)" stroke-width="' + (r > 5 ? 1.45 : 1.15).toFixed(2)
      + '" stroke-linecap="round">' + arms + "</g></g>";
  }

  /* Two sizes and two alphas, never three of the same: the near flake is the subject and
     the others are the fall it is part of. */
  function flakes(n, y) {
    var xs = n === 2 ? [25, 40] : [21, 32, 43];
    var rs = n === 2 ? [6.1, 4.3] : [4.5, 6.2, 4.1];
    var op = n === 2 ? [1, 0.62] : [0.66, 1, 0.55];
    var dy = n === 2 ? [0, -1.5] : [-1, 3.5, -2];
    return xs.map(function (x, i) {
      return '<g opacity="' + op[i] + '">' + flake(x, y + dy[i], rs[i]) + "</g>";
    }).join("");
  }

  /* Glow first, then the bolt, then a hot core down its spine — a flat yellow zigzag is a
     road sign, and the glow is what makes it light. It hangs from the cloud's centre of
     mass with its head tucked inside the belly and its tip clear of the frame's floor. */
  function bolt(cx) {
    var pts = [[3.4, -4], [-6.2, 11], [-0.6, 11], [-4.6, 24], [7.6, 7.5], [1.4, 7.5], [5.6, -4]];
    var d = pts.map(function (q, i) {
      return (i ? "L " : "M ") + (cx + q[0]).toFixed(1) + " " + (38 + q[1]).toFixed(1);
    }).join(" ") + " Z";
    return '<g class="wxi-bolt">'
      + '<ellipse cx="' + cx + '" cy="48" rx="13" ry="14" fill="url(#wxg-boltglow)"/>'
      + '<path d="' + d + '" fill="url(#wxg-bolt)"/>'
      + '<path d="M ' + (cx + 3.9) + ' 37 L ' + (cx - 2.4) + " 47 L " + (cx + 1.2)
      + " 47 L " + (cx - 1) + ' 55" fill="none"'
      + ' stroke="var(--ic-bolt-hi)" stroke-width="1.2" stroke-linecap="round"'
      + ' opacity="0.75"/></g>';
  }

  /* Fog is layers of air, so it is drawn as layers — and each layer is drawn TWICE: a wide
     soft under-band and a narrower, brighter core on top of it. Three hard rules under a
     cloud is a menu glyph or a legend; what makes a band read as air is that it has no
     edge anywhere, in either axis. The middle band carries the most weight because that is
     where the eye enters the shape. */
  function fog(y) {
    /* Three bands, no two the same length, weight, offset or density. Evenly spaced bands
       of equal length are a barcode — which is exactly what the first attempt drew. */
    var band = [[26, 3.4, 0, 0.72], [17.5, 4.6, 5.5, 1], [22, 3.0, -3.5, 0.6]];
    var rows = band.map(function (b, i) {
      var yy = y + i * 8;
      return '<g class="wxi-fogband" opacity="' + b[3] + '">'
        /* The soft band carries most of the weight and the core is a hint inside it — the
           other way round draws three capsules, which is a legend. */
        + '<line stroke-width="' + (b[1] * 3).toFixed(1) + '" opacity="0.42"'
        + ' x1="' + (32 + b[2] - b[0] * 1.14).toFixed(1) + '" y1="' + yy
        + '" x2="' + (32 + b[2] + b[0] * 1.14).toFixed(1) + '" y2="' + yy + '"/>'
        + '<line stroke-width="' + (b[1] * 0.62).toFixed(1) + '" opacity="0.8"'
        + ' x1="' + (32 + b[2] - b[0] * 0.82).toFixed(1) + '" y1="' + yy
        + '" x2="' + (32 + b[2] + b[0] * 0.82).toFixed(1) + '" y2="' + yy + '"/></g>';
    }).join("");
    return '<g stroke="url(#wxg-fog)" stroke-linecap="round">' + rows + "</g>";
  }

  function wrap(inner) {
    return '<svg class="wxi" viewBox="0 0 64 64" aria-hidden="true">' + inner + "</svg>";
  }

  /* ---------------- composites per WMO group ----------------
     One placement language across all 28: a bank's base sits where the precipitation
     starts, the light source (sun or moon) sits behind its top-left shoulder, and
     anything falling occupies the bottom third.

     OPTICAL MASS is the second rule, and it is the one a pack is judged on. Every hero
     subject carries roughly the same area of ink in the 64-unit space, not the same
     bounding box — the eye weighs an icon by how much of it is filled. The cumulus
     silhouette is 0.39*w^2 units of fill, so the w=45 rain cloud is ~790; the clear-day
     sun (disc + wedges + corona) is of that order at r=15.5, and the clear-night moon runs
     r=19 so that its LIT part alone is, since the unlit half is earthshine on a black
     panel and contributes almost nothing to what the eye weighs. Where a light source sits
     BEHIND a bank it is a supporting shape and runs at roughly half that.

     The composites are BUILT ON DEMAND, not once at load: the night ones need the phase of
     the moon, which changes. once() keeps the day set to a single build each. */

  function once(fn) { var v; return function () { return v || (v = fn()); }; }

  /* The live phase, from whoever owns the model — the Moon widget calls usePhase() with
     its own calc() so the icon and the Moon tile can never disagree. Clamped off the ends:
     a moon two days either side of new has a lit limb a fraction of a unit wide, and the
     icon would go to a dark disc for four nights a month. */
  var phaseSrc = null;
  function livePhase() {
    var p = phaseSrc ? phaseSrc(Date.now()) : 0.18;
    if (!(p >= 0 && p <= 1)) p = 0.18;
    return p < 0.06 ? 0.06 : p > 0.94 ? 0.94 : p;
  }

  var MOON_R = 19;
  var clearDay = once(function () { return sun(32, 31, 15.5); });
  function clearNight() {
    /* the halo is the night sky's version of the sun's corona: air, lit from behind */
    return '<circle class="wxi-halo" cx="30" cy="32" r="29.5"'
      + ' fill="url(#wxg-moonhalo)"/>'
      + moon(30, 32, MOON_R, livePhase()) + star(56, 14, 2) + star(53, 48, 1.4);
  }
  var partlyDay = once(function () { return sun(21, 20, 11) + cloud(36, 49, 43); });
  function partlyNight() {
    return moon(20, 19, 12, livePhase()) + star(54, 13, 1.7) + cloud(36, 49, 43);
  }
  /* ONE deck, not two stacked cumulus. The seam the old pair produced ran through the
     middle of the largest drawing in the product. */
  var overcast = once(function () { return deck(32, 45, 52); });
  var foggy = once(function () { return cloud(32, 34, 42) + fog(42); });
  var drizzle = once(function () { return cloud(32, 40, 45) + drops(2, 7, 40); });
  var rain = once(function () { return cloud(32, 40, 45) + drops(3, 12, 40); });
  /* one drop beside one flake: rain that freezes */
  var freezing = once(function () {
    return cloud(32, 40, 45) + rainGroup(streak(24, 43.2, 11, 2.8)) + flake(40, 51, 5.6);
  });
  var snow = once(function () { return cloud(32, 40, 45) + flakes(3, 51); });
  var showersDay = once(function () {
    return sun(19, 17, 9) + cloud(36, 42, 40) + drops(3, 11, 42);
  });
  function showersNight() {
    return moon(18, 17, 10.5, livePhase()) + cloud(36, 42, 40) + drops(3, 11, 42);
  }
  var storm = once(function () {
    return deck(32, 38, 50) + underglow(32, 38, 50) + bolt(32);
  });
  var stormRain = once(function () {
    return deck(32, 38, 50) + underglow(32, 38, 50) + bolt(32)
      + rainGroup(streak(15.5, 41.2, 11, 2.6, 0.8) + streak(48.5, 41.2, 13, 2.6));
  });
  var snowShowersDay = once(function () {
    return sun(19, 17, 9) + cloud(36, 42, 40) + flakes(2, 51);
  });
  function snowShowersNight() {
    return moon(18, 17, 10.5, livePhase()) + cloud(36, 42, 40) + flakes(2, 51);
  }

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
    return e ? wrap(e[night ? 1 : 0]()) : UNKNOWN;
  };
  /* Exposed for the Moon widget and for the tests. */
  WP.wxIcon.moonPath = WP.moonArt.path;
  WP.wxIcon.moonDisc = WP.moonArt.disc;
  WP.wxIcon.codes = Object.keys(ICONS).map(Number);
  WP.wxIcon.moonR = MOON_R;
  /* The Moon widget hands its model over here at load, so the night glyph and the Moon
     tile are the same moon. Anything that can answer "phase at this instant" will do. */
  WP.wxIcon.usePhase = function (fn) { phaseSrc = fn; };
  WP.icoMat.mount();
})();
