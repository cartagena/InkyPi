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
  /* The top-left arc of that same outline, offset inward — the edge the sky lights. It is
     drawn thin and bright rather than thick and pale: a wide soft rim is a haze that fills
     the lobe and flattens it, where a narrow one describes the edge it sits on. */
  var CL_RIM = "M 4.6 32.6 C 6.2 28.6 9.2 26.5 12.6 26"
    + " C 14.1 19.8 19.2 15.5 25.3 15.5 C 29.9 15.5 34 17.8 36.5 21.8";
  /* Where one lobe tucks behind the next. A single gradient over a single silhouette gives
     the eye one surface; these two soft creases are what say "four lobes", and they are the
     difference between a cloud and a grey bean at four metres. */
  var CL_FOLD = "M 12.4 26.4 C 14.2 32.5 14 38.6 13 43.8"
    + "M 38.2 24 C 40.5 29.5 41.4 36.6 41 43.8";

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
      + '<path d="' + CL_FOLD + '" fill="none" stroke="var(--ic-cloud-dk)"'
      + ' stroke-width="1.7" stroke-linecap="round" opacity="' + (dark ? 0.5 : 0.34) + '"/>'
      + '<path d="' + CL_RIM + '" fill="none" stroke="var(--ic-cloud-lit)"'
      + ' stroke-width="1.25" stroke-linecap="round" opacity="' + (dark ? 0.45 : 0.85) + '"/>'
      + "</g>";
  }

  /* Disc, hot spot, halo, and eight tapered rays. The rays are their own group because
     the stylesheet rocks that group a few degrees and leaves the disc still.

     The rays are SHORT and the disc is LARGE, which is the opposite of the first draft.
     A pack is judged on ink, not on bounding box: the old sun spanned 42 of 64 units but
     most of that span was empty air between eight thin spikes, so beside a cloud carrying
     ~790 units of solid fill it read as a small object. Ray length is a fixed fraction of
     the radius here, so scaling the sun scales its whole silhouette instead of leaving the
     spikes behind. */
  function sun(cx, cy, r) {
    var rays = "";
    var i1 = r + r * 0.20, o1 = r + r * 0.60, hw = r * 0.175;
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI / 4) * i + Math.PI / 8;
      var c = Math.cos(a), s = Math.sin(a);
      /* a ray is a wedge, not a stick: wide at the disc, a point at the tip */
      rays += '<path d="M ' + (cx + c * i1 - s * hw).toFixed(1) + " "
        + (cy + s * i1 + c * hw).toFixed(1)
        + " L " + (cx + c * o1).toFixed(1) + " " + (cy + s * o1).toFixed(1)
        + " L " + (cx + c * i1 + s * hw).toFixed(1) + " "
        + (cy + s * i1 - c * hw).toFixed(1) + ' Z"/>';
    }
    return '<circle class="wxi-halo" cx="' + cx + '" cy="' + cy + '" r="' + (r * 1.85).toFixed(1)
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

  /* The whole limb as a path, so "the disc minus the lit part" can be one evenodd fill.
     A function and not a constant because the icon draws the same moon at four radii. */
  function ring(cx, cy, r) {
    return "M " + (cx - r) + " " + cy + " A " + r + " " + r + " 0 1 0 " + (cx + r) + " " + cy
      + " A " + r + " " + r + " 0 1 0 " + (cx - r) + " " + cy + " Z";
  }

  /* Maria, in the 64-space of a full disc. Placed where the real ones are, roughly, so a
     full moon reads as a face rather than as a plate. */
  var CRATERS = '<circle cx="25" cy="21.5" r="4.4" opacity="0.3"/>'
    + '<circle cx="38.5" cy="26" r="2.6" opacity="0.26"/>'
    + '<circle cx="30" cy="37" r="5.6" opacity="0.22"/>'
    + '<circle cx="43" cy="40.5" r="3" opacity="0.26"/>'
    + '<circle cx="19.5" cy="33" r="2.3" opacity="0.24"/>'
    + '<circle cx="35" cy="46" r="2" opacity="0.2"/>';

  /* THE NIGHT ICON'S MOON, and it is the whole body — not the lit limb alone.

     It used to be a fixed pleasant crescent at p=0.18, on the reasoning that nobody reads a
     gibbous from a quarter at 2.9vh. Two things were wrong with that. The Moon tile sits
     three inches away on the same dashboard reporting the real phase, so a clear night
     showed a thin crescent in the Now card and a half-lit disc in the tile — one sky, two
     moons. And a crescent is ~8 units of ink where the cloud beside it is ~790, which is
     why the night glyph measured a third of the width of every other icon in the pack.

     Both fall out of drawing the disc the way the Moon panel draws it: the whole body,
     dark side present as earthshine, lit limb at the LIVE phase. The silhouette is then a
     constant pi*r^2 whatever the sky is doing, and the two moons on the dashboard agree
     because they are the same number through the same path. */
  function moon(cx, cy, r, p) {
    var s = r / 24;                            /* the maria are authored on a 24-unit disc */
    return '<g class="wxi-moon">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--ic-moon-dk)"/>'
      + '<path d="' + moonPath(cx, cy, r, p) + '" fill="url(#wxg-moon)"/>'
      + '<g fill="var(--ic-moon-dim)" transform="translate(' + (cx - 32 * s).toFixed(2)
      + " " + (cy - 32 * s).toFixed(2) + ") scale(" + s.toFixed(3) + ')">' + CRATERS + "</g>"
      + '<path fill-rule="evenodd" fill="var(--ic-moon-dk)" d="'
      + ring(cx, cy, r) + " " + moonPath(cx, cy, r, p) + '"/>'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"'
      + ' stroke="var(--ic-moon-dim)" stroke-width="0.6" opacity="0.35"/></g>';
  }

  /* The Moon widget's disc: the whole body, with the unlit part present as earthshine
     rather than absent, and the maria where the real ones are. Exported so the tile, the
     week strip, the phase strip and the panel hero are one drawing at four sizes.

     The craters are painted over the WHOLE disc and the dark side is then painted back
     over the top, as a single evenodd path of (outer circle + lit limb). That is the same
     picture a clipPath would give and it needs no id — and an id here would be the same
     duplicate-reference trap the gradients were just taken out of, on an element the tile
     replaces every hour. A crater in shadow is a crater you cannot see, which is the one
     detail that makes a phase disc look lit rather than printed. */
  function moonDisc(p, cls) {
    return '<svg class="' + (cls || "wxi") + '" viewBox="0 0 64 64" aria-hidden="true">'
      + moon(32, 32, 24, p) + "</svg>";
  }

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

  /* Falling water. ONE rake angle and ONE gap below the belly for every streak in the pack;
     only the length varies, and only a little.

     The first version varied length, weight and start height together, which is what a
     photograph of rain does and what a drawing of rain must not: at icon size three streaks
     starting at three heights read as three mistakes rather than as depth. The gradient
     fades each streak out at its top, which is what gives it a direction without drawing
     an arrow, and that is where the variety is allowed to live. */
  var RAKE = 0.26;                            /* horizontal drift per unit of fall */
  var RAIN_GAP = 3.2;                         /* every streak starts this far under the base */
  function streak(x, y, l, w) {
    return '<line class="wxi-drop" stroke-width="' + w
      + '" x1="' + x.toFixed(1) + '" y1="' + y.toFixed(1)
      + '" x2="' + (x - l * RAKE).toFixed(1) + '" y2="' + (y + l).toFixed(1) + '"/>';
  }
  function rainGroup(inner) {
    return '<g class="wxi-rain" stroke="url(#wxg-rain)" stroke-linecap="round"'
      + ' fill="none">' + inner + "</g>";
  }
  function drops(n, len, base) {
    var xs = n === 2 ? [26, 39] : [20.5, 32, 43.5];
    var k = n === 2 ? [1, 0.86] : [0.88, 1, 0.92];
    return rainGroup(xs.map(function (x, i) {
      return streak(x, base + RAIN_GAP, len * k[i], 2.8);
    }).join(""));
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
     road sign, and the glow is what makes it light.

     It hangs from the cloud's centre of mass with its head tucked inside the belly and its
     tip clear of the frame's bottom edge. The first one hung off the left shoulder and ran
     into the viewBox floor, so half the strike was outside the cloud it came from and the
     other half was clipped — a bolt has to look like it left the cloud it is under. */
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

  /* THE MATERIALS ARE MOUNTED ONCE, into a permanent hidden sprite in index.html, and
     every icon references them by id.

     They used to travel inside each icon, which put twenty-six identical copies of
     <linearGradient id="wxg-cloud"> in one document. A duplicate id resolves to whichever
     copy the browser saw first — and that copy is inside a card the app repaints. When a
     repaint removes it, every other icon on the screen loses its fill: a capture caught
     the Now glyph and all twenty-four hourly glyphs blank while the daily row was fine.
     One node that nothing ever removes cannot go stale, and each icon gets ~700 bytes
     shorter into the bargain. */
  function mountDefs() {
    var host = (typeof document !== "undefined" && document.getElementById)
      ? document.getElementById("wxdefs") : null;
    if (!host) return;                      /* the test DOM, and any page without the host */
    host.innerHTML = '<svg aria-hidden="true" focusable="false"><defs>'
      + Object.keys(GRAD).sort().map(function (k) { return GRAD[k]; }).join("")
      + "</defs></svg>";
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
     bounding box — the eye weighs an icon by how much of it is filled, so a sun of thin
     spikes and a cloud of solid fill at the same width look like two different sizes.
     The cumulus silhouette is 0.39*w^2 units of fill, so the w=45 rain cloud is ~790; the
     clear-day sun (disc + wedges) is ~800 at r=14.5, and the clear-night moon runs r=19 so
     that its LIT part alone is of that order at a typical phase — the unlit half is
     earthshine on a black panel and contributes almost nothing to what the eye weighs.
     Where a light source sits BEHIND a bank it is a supporting shape and
     runs at roughly half that, which is why the partly-cloudy sun is smaller than the
     clear-sky one rather than the same sun moved sideways.

     The composites are BUILT ON DEMAND, not once at load: the night ones need the phase of
     the moon, which changes. once() keeps the day set to a single build each, since a
     drawing with no live input cannot have changed since the last strip was painted. */

  function once(fn) { var v; return function () { return v || (v = fn()); }; }

  /* The live phase, from whoever owns the model — the Moon widget calls usePhase() with
     its own calc() so the icon and the Moon tile can never disagree. Until it does (the
     tests' bare icon module, a page without the widget) a waxing crescent stands in.

     Clamped off the ends: a moon two days either side of new has a lit limb a fraction of
     a unit wide, and the icon would go to a dark disc for four nights a month. Six per cent
     is the narrowest crescent that still reads as one at strip size. */
  var phaseSrc = null;
  function livePhase() {
    var p = phaseSrc ? phaseSrc(Date.now()) : 0.18;
    if (!(p >= 0 && p <= 1)) p = 0.18;
    return p < 0.06 ? 0.06 : p > 0.94 ? 0.94 : p;
  }

  /* The night hero's radius is a number the test can see, because it is half of what
     "the two moons agree" means and it moved once already: at 16.75 the disc matched the
     cloud on TOTAL ink, but the unlit half is earthshine on a black panel and registers as
     very little of it, so the glyph still measured optically narrow beside a cumulus. The
     radius is set from the LIT area at a typical phase instead. */
  var MOON_R = 19;
  var clearDay = once(function () { return sun(32, 31, 14.5); });
  function clearNight() {
    return moon(28, 32, MOON_R, livePhase()) + star(55, 15, 2) + star(52, 47, 1.4);
  }
  var partlyDay = once(function () { return sun(21, 20, 10.5) + cloud(36, 49, 43); });
  function partlyNight() {
    return moon(20, 19, 12, livePhase()) + star(54, 13, 1.7) + cloud(36, 49, 43);
  }
  var overcast = once(function () { return cloud(25, 36, 38, true) + cloud(35, 48, 45); });
  var foggy = once(function () { return cloud(32, 34, 42) + fog(42); });
  var drizzle = once(function () { return cloud(32, 40, 45) + drops(2, 7, 40); });
  var rain = once(function () { return cloud(32, 40, 45) + drops(3, 12, 40); });
  /* one drop beside one flake: rain that freezes */
  var freezing = once(function () {
    return cloud(32, 40, 45) + rainGroup(streak(24, 43.2, 11, 2.8)) + flake(40, 51, 5.6);
  });
  var snow = once(function () { return cloud(32, 40, 45) + flakes(3, 51); });
  var showersDay = once(function () {
    return sun(19, 17, 8.5) + cloud(36, 42, 40) + drops(3, 11, 42);
  });
  function showersNight() {
    return moon(18, 17, 10.5, livePhase()) + cloud(36, 42, 40) + drops(3, 11, 42);
  }
  var storm = once(function () { return cloud(32, 38, 46, true) + bolt(32); });
  var stormRain = once(function () {
    return cloud(32, 38, 46, true) + bolt(32)
      + rainGroup(streak(17.5, 41.2, 11, 2.6) + streak(47.5, 41.2, 11, 2.6));
  });
  var snowShowersDay = once(function () {
    return sun(19, 17, 8.5) + cloud(36, 42, 40) + flakes(2, 51);
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
  WP.wxIcon.moonPath = moonPath;
  WP.wxIcon.moonDisc = moonDisc;
  WP.wxIcon.codes = Object.keys(ICONS).map(Number);
  WP.wxIcon.moonR = MOON_R;
  /* The Moon widget hands its model over here at load, so the night glyph and the Moon
     tile are the same moon. Anything that can answer "phase at this instant" will do. */
  WP.wxIcon.usePhase = function (fn) { phaseSrc = fn; };
  mountDefs();
})();
