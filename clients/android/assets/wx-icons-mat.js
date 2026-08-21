/* Wall panel dashboard — THE ICON PACK'S MATERIALS.

   Every gradient and every filter the weather icons paint with, in one place, plus the
   one node they are mounted into. The shapes live in wx-icons.js and the moon's body in
   wx-icons-moon.js; this file is what those shapes are MADE of.

   It is split out for the same reason the moon was: wx-icons.js had reached the 500-line
   ceiling, and the next honest improvement to a shape would have had to be paid for by
   deleting a comment somewhere else. The seam is a real one — a material is retuned when
   the panel's light changes, a silhouette when the drawing is wrong, and those are
   different jobs on different days.

   TWO RULES GOVERN EVERYTHING BELOW.

   Colour is never written here. Every stop is stop-color="var(--ic-*)" against a token in
   style-theme.css, so the palette has exactly one home and the mood tints (the panel
   warms its highlights at golden hour and cools them at night by swapping those tokens on
   :root) reach the icons without a line of JavaScript touching a paint server. A literal
   hex in this file is a test failure — icons.test.js reads every wx-icons* file.

   Filters are EXPENSIVE and are therefore not attached here. feTurbulence into
   feDisplacementMap is what stops a cumulus reading as vector clip-art, and it is also the
   most expensive thing the panel draws; style-icons.css attaches it to the two hero-sized
   icons only, so the twenty-four glyphs in the hourly strip — where the texture would be
   invisible anyway — never rasterise one. The filter's own input is STATIC: the bob lives
   on the group above it, so the filtered raster is produced once and then composited,
   which is the difference between a transform and a repaint.

   One flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  function stop(off, tok, op) {
    return '<stop offset="' + off + '" stop-color="var(--ic-' + tok + ')"'
      + (op == null ? "" : ' stop-opacity="' + op + '"') + "/>";
  }
  function lin(id, y1, y2, stops) {
    return '<linearGradient id="' + id + '" x1="0" y1="' + y1 + '" x2="0" y2="' + y2 + '">'
      + stops + "</linearGradient>";
  }
  /* A volume gradient is RADIAL and off-centre, which is the whole of the difference
     between a lit mass and a painted shape. The centre sits up and to the left because
     that is where the pack's light comes from in every day icon; the far side runs all
     the way down to the belly colour, so one fill carries the whole turn of the form. */
  function vol(id, cx, cy, r, stops) {
    return '<radialGradient id="' + id + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '">'
      + stops + "</radialGradient>";
  }

  var GRAD = {
    /* Cumulus, lit from over the left shoulder: hot on the upper-left lobe, through the
       body colour, into its own shadow at the lower right. It was a top-to-bottom linear
       ramp, which is a cylinder — every point at the same height the same value — and a
       cylinder is exactly what "flat clip-art" means at hero size. */
    "wxg-cloud": vol("wxg-cloud", 0.30, 0.14, 0.95,
      stop(0, "cloud-hi") + stop(0.16, "cloud-lit") + stop(0.42, "cloud")
      + stop(0.74, "cloud-dk") + stop(1, "cloud-dkr")),
    /* The same mass with the light taken out of it — overcast decks and the storm anvil.
       Still radial, because even a grey sky has a brighter side. */
    "wxg-cloudd": vol("wxg-cloudd", 0.32, 0.16, 0.98,
      stop(0, "cloud-lit") + stop(0.22, "cloud") + stop(0.55, "cloud-dk")
      + stop(1, "cloud-dkr")),
    /* the soft dark under the belly of a bank, so the base is not a straight cut */
    "wxg-belly": '<radialGradient id="wxg-belly">'
      + stop(0, "cloud-dkr", 0.55) + stop(1, "cloud-dkr", 0) + "</radialGradient>",
    /* What a bolt does to the cloud it just left. Warm, short-range and under the belly —
       the one thing that separates a storm anvil from a dark cumulus in a still frame. */
    "wxg-underglow": '<radialGradient id="wxg-underglow">'
      + stop(0, "bolt-hi", 0.5) + stop(0.45, "bolt", 0.24) + stop(1, "bolt", 0)
      + "</radialGradient>",
    /* THE RIM LIGHT'S TAPER, and it is a fade rather than a colour: a lit edge that stops
       square is a detached bright hook. Object-bounding-box units, so the same one def
       tapers any arc along its own length. */
    "wxg-rim": '<linearGradient id="wxg-rim">'
      + stop(0, "cloud-hi", 0) + stop(0.3, "cloud-hi", 1)
      + stop(0.72, "cloud-hi", 1) + stop(1, "cloud-hi", 0) + "</linearGradient>",
    /* the disc: hot centre up and left, cooling to the rim */
    "wxg-sun": vol("wxg-sun", 0.38, 0.33, 0.75,
      stop(0, "sun-lit") + stop(0.5, "sun") + stop(1, "ray")),
    /* the air around it — this is what a sun looks like through an atmosphere */
    "wxg-halo": '<radialGradient id="wxg-halo">'
      + stop(0, "sun-lit", 0.38) + stop(0.45, "sun", 0.2) + stop(1, "sun", 0)
      + "</radialGradient>",
    /* The corona is the halo's inner, hotter half: a sun seen through air has a bright
       collar right off the limb and a long faint reach beyond it, and one gradient cannot
       be both without going flat in the middle. */
    "wxg-corona": '<radialGradient id="wxg-corona">'
      + stop(0, "sun-lit", 0) + stop(0.52, "sun-lit", 0.55)
      + stop(0.72, "sun", 0.3) + stop(1, "sun", 0) + "</radialGradient>",
    "wxg-moon": vol("wxg-moon", 0.6, 0.34, 0.8,
      stop(0, "moon-lit") + stop(0.55, "moon") + stop(1, "moon-dim")),
    /* Limb darkening. A sphere does not end at a bright line; it turns away, and the last
       few per cent of the disc is the part turning fastest. Transparent until 0.72 of the
       radius so it costs the face nothing and only bites at the edge. */
    "wxg-limb": '<radialGradient id="wxg-limb">'
      + stop(0, "moon-dk", 0) + stop(0.72, "moon-dk", 0)
      + stop(0.92, "moon-dk", 0.3) + stop(1, "moon-dk", 0.62) + "</radialGradient>",
    /* the air around a moon on a clear night */
    "wxg-moonhalo": '<radialGradient id="wxg-moonhalo">'
      + stop(0, "moon", 0.3) + stop(0.42, "moon", 0.12) + stop(1, "moon", 0)
      + "</radialGradient>",
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
    /* a flake is not a wire drawing at hero size — it has air lit around it */
    "wxg-bloom": '<radialGradient id="wxg-bloom">'
      + stop(0, "snow", 0.34) + stop(0.5, "snow", 0.12) + stop(1, "snow", 0)
      + "</radialGradient>",
    "wxg-bolt": lin("wxg-bolt", 0, 1, stop(0, "bolt-hi") + stop(1, "bolt")),
    "wxg-boltglow": '<radialGradient id="wxg-boltglow">'
      + stop(0, "bolt", 0.42) + stop(1, "bolt", 0) + "</radialGradient>"
  };

  /* ---------------- the texture ----------------

     A cloud drawn as a filled outline has one property no real cloud has: a perfectly
     smooth edge and a perfectly smooth interior. At strip size nobody can tell. At hero
     size it is the single tell that the drawing is vector art, and no amount of gradient
     fixes it, because the flatness is in the EDGE as much as in the fill.

     Two passes, both static:
       1. a low-frequency fractal noise pushed through feDisplacementMap at under two
          units of amplitude, which roughens the silhouette without changing its shape —
          the lobes still read as lobes, they just stop being drawn with a compass;
       2. a higher-frequency noise flattened to a dark, low-alpha veil and composited
          INSIDE the displaced mass, which is the mottle a real cumulus has where one
          part of it shadows another.

     The numbers are in the icon's own 64-unit space (primitiveUnits defaults to user
     space, and the filter hangs on a child of the scaled group), so one filter serves
     every size the pack draws a cloud at. seed is fixed: a re-randomising cloud would
     shimmer on every repaint. */
  var FILT = {
    "wxf-cloud": '<filter id="wxf-cloud" x="-14%" y="-16%" width="128%" height="134%"'
      + ' color-interpolation-filters="sRGB">'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.055 0.085" numOctaves="3"'
      + ' seed="11" result="warpnoise"/>'
      + '<feDisplacementMap in="SourceGraphic" in2="warpnoise" scale="1.9"'
      + ' xChannelSelector="R" yChannelSelector="G" result="mass"/>'
      + '<feTurbulence type="fractalNoise" baseFrequency="0.19" numOctaves="4"'
      + ' seed="5" result="grain"/>'
      /* the noise's own alpha, scaled down and biased so most of it is nothing and the
         darkest patches reach about a tenth — mottle, not dirt */
      + '<feColorMatrix in="grain" type="matrix" result="veil"'
      + ' values="0 0 0 0 0.10  0 0 0 0 0.12  0 0 0 0 0.16  0 0 0 0.46 -0.17"/>'
      + '<feComposite in="veil" in2="mass" operator="in" result="mottle"/>'
      + "<feMerge><feMergeNode in=\"mass\"/><feMergeNode in=\"mottle\"/></feMerge>"
      + "</filter>"
  };

  /* THE MATERIALS ARE MOUNTED ONCE, into a permanent hidden sprite in index.html, and
     every icon references them by id.

     They used to travel inside each icon, which put twenty-six identical copies of
     <linearGradient id="wxg-cloud"> in one document. A duplicate id resolves to whichever
     copy the browser saw first — and that copy is inside a card the app repaints. When a
     repaint removes it, every other icon on the screen loses its fill: a capture caught
     the Now glyph and all twenty-four hourly glyphs blank while the daily row was fine.
     One node that nothing ever removes cannot go stale. */
  function mount() {
    var host = (typeof document !== "undefined" && document.getElementById)
      ? document.getElementById("wxdefs") : null;
    if (!host) return;                      /* the test DOM, and any page without the host */
    function all(o) {
      return Object.keys(o).sort().map(function (k) { return o[k]; }).join("");
    }
    host.innerHTML = '<svg aria-hidden="true" focusable="false"><defs>'
      + all(GRAD) + all(FILT) + "</defs></svg>";
  }

  WP.icoMat = { grad: GRAD, filt: FILT, mount: mount, stop: stop };
})();
