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
    /* The same mass with the light taken out of it — the overcast deck.
       Still radial, because even a grey sky has a brighter side. */
    "wxg-cloudd": vol("wxg-cloudd", 0.32, 0.16, 0.98,
      stop(0, "cloud-lit") + stop(0.22, "cloud") + stop(0.55, "cloud-dk")
      + stop(1, "cloud-dkr")),
    /* AND THE THUNDER ANVIL, which is not the overcast deck turned down — it is a
       different weight of grey. A still frame of a storm and a still frame of overcast
       used to differ by one bolt; the mass itself has to be the heavier of the two, so
       this one starts where the other one is already halfway to its shadow and never
       reaches the lit face at all. The crown is low and grey rather than a white turret,
       which is what a bank with rain falling out of it actually looks like. */
    "wxg-clouds": vol("wxg-clouds", 0.34, 0.20, 1.02,
      stop(0, "cloud") + stop(0.2, "cloud-dk") + stop(0.62, "cloud-dkr")
      + stop(1, "cloud-dkr")),
    /* the soft dark under the belly of a bank, so the base is not a straight cut */
    "wxg-belly": '<radialGradient id="wxg-belly">'
      + stop(0, "cloud-dkr", 0.55) + stop(1, "cloud-dkr", 0) + "</radialGradient>",
    /* What a bolt does to the cloud it just left. Warm, short-range and under the belly —
       the one thing that separates a storm anvil from a dark cumulus in a still frame. */
    "wxg-underglow": '<radialGradient id="wxg-underglow">'
      + stop(0, "bolt-hi", 0.62) + stop(0.42, "bolt", 0.3) + stop(1, "bolt", 0)
      + "</radialGradient>",
    /* THE RIM LIGHT'S TAPER, and it is a fade rather than a colour: a lit edge that stops
       square is a detached bright hook. Object-bounding-box units, so the same one def
       tapers any arc along its own length. */
    "wxg-rim": '<linearGradient id="wxg-rim">'
      + stop(0, "cloud-hi", 0) + stop(0.3, "cloud-hi", 1)
      + stop(0.72, "cloud-hi", 1) + stop(1, "cloud-hi", 0) + "</linearGradient>",
    /* THE DISC, and the one stop that was doing the damage. It used to finish on --ic-ray
       (#ffb347), an amber two shades under the collar of light outside it — so the far
       rim of the sun was DARKER than the air around it, and the eye read a dark annulus
       ringing a flat ball. A star's limb is dimmer than its centre by a few per cent, not
       by a shade, and whatever is left of that is buried under the corona. So the ramp
       runs hot centre to body and stays there; the turn of the form is carried by the
       off-centre placement, and the edge is finished by the collar, from outside. */
    "wxg-sun": vol("wxg-sun", 0.37, 0.32, 0.80,
      stop(0, "sun-lit") + stop(0.34, "sun-lit") + stop(0.72, "sun") + stop(1, "sun")),
    /* The air around it. Held DOWN and pulled IN: a wide field of amber at a fifth of an
       alpha over true black is not a glow, it is a brown disc the size of the icon — which
       is what a capture review called it. Glow is a steep falloff, so most of the reach is
       spent in the first third and what is left beyond that is a rumour. */
    "wxg-halo": '<radialGradient id="wxg-halo">'
      + stop(0, "sun-lit", 0.30) + stop(0.34, "sun", 0.15) + stop(0.66, "sun", 0.05)
      + stop(1, "sun", 0) + "</radialGradient>",
    /* THE COLLAR, and it is now painted ON TOP of the disc rather than under it.

       Under the disc it could only ever start outside the limb, which left a band of bare
       halo — a fifth of an alpha of amber over black — between the sun's edge and the
       first bright thing outside it. That band is the dark annulus a review found ringing
       the sun, and no amount of tuning the ring's own stops closes it, because the gap is
       between two layers rather than inside one.

       Over the disc it can begin INSIDE the limb and carry the edge outward, which is
       what a bright source seen through air actually does: the glare eats its own outline.
       It is drawn on a circle 1.5 radii wide, so 0.667 here is the limb exactly — the ramp
       starts at 0.5 (three quarters of the way out on solid sun) and is still going when
       it crosses. Nothing is painted at full strength anywhere, so the disc keeps its
       colour and only its rim is lifted. */
    "wxg-corona": '<radialGradient id="wxg-corona">'
      + stop(0, "sun-lit", 0) + stop(0.48, "sun-lit", 0) + stop(0.63, "sun-lit", 0.5)
      + stop(0.7, "sun-lit", 0.52) + stop(0.82, "sun", 0.26) + stop(0.92, "sun", 0.1)
      + stop(1, "sun", 0) + "</radialGradient>",
    /* THE LIT FACE. Flatter than a billiard ball on purpose: the moon's regolith
       back-scatters, which is why a full moon reads as a disc rather than as a sphere, and
       a hot little highlight on the sunward shoulder turned the hero into a pearl button.
       So the bright stop is small and the middle of the ramp holds one value for most of
       the face; all the modelling that is left is the fall toward the terminator, which is
       the side the light is failing on and therefore the side that should be dimmest.
       Flat is not the same as FEATURELESS, though: the plateau ends at 0.56 rather than
       0.72, so nearly half the ramp is spent walking down toward the terminator instead of
       holding one value and then stepping off a cliff at the end. */
    "wxg-moon": vol("wxg-moon", 0.62, 0.42, 1.02,
      stop(0, "moon-lit") + stop(0.28, "moon") + stop(0.56, "moon")
      + stop(1, "moon-dim")),
    /* A CRATER IS A BOWL, and a bowl is one fill with the light running across it. Drawn
       as an arc pair it came out an open dark horseshoe — the lit inner wall was struck in
       a tone the face already wore, so only the shadow ever registered. This is the same
       depression as one closed shape: the wall facing the sun (upper right) in its own
       shadow, the floor in half-light, the far wall square-on to the light. */
    "wxg-crater": '<linearGradient id="wxg-crater" x1="0.86" y1="0.14" x2="0.2" y2="0.86">'
      + stop(0, "moon-dk", 0.55) + stop(0.45, "moon-dim", 0.5)
      + stop(1, "moon-lit", 0.5) + "</linearGradient>",
    /* AND BOTH OF THEM MIRRORED, because the sun changes sides. A waxing moon is lit from
       the right and a waning one from the left, and a face shaded from the right for the
       whole month has its dimmest ground on the LIT limb for two weeks out of four —
       which is the same "backwards" the stepped terminator was failed for, just slower to
       notice. Two extra defs and a branch is the whole cost of getting it right. */
    "wxg-moonw": vol("wxg-moonw", 0.38, 0.42, 1.02,
      stop(0, "moon-lit") + stop(0.28, "moon") + stop(0.56, "moon")
      + stop(1, "moon-dim")),
    "wxg-craterw": '<linearGradient id="wxg-craterw" x1="0.14" y1="0.14" x2="0.8" y2="0.86">'
      + stop(0, "moon-dk", 0.55) + stop(0.45, "moon-dim", 0.5)
      + stop(1, "moon-lit", 0.5) + "</linearGradient>",
    /* Limb darkening, and it reaches FURTHER IN than it did. Held off until 0.72 of the
       radius it bit only in the outermost eight per cent, which at hero size is a few
       pixels of edge on an otherwise dead plateau — a probe across the lit face came back
       240..246 the whole way over, which is a paper disc, not a sphere. It starts turning
       at half the radius now and most of the fall is still in the last tenth, which is
       what limb darkening actually looks like. */
    "wxg-limb": '<radialGradient id="wxg-limb">'
      + stop(0, "moon-dk", 0) + stop(0.52, "moon-dk", 0) + stop(0.74, "moon-dk", 0.08)
      + stop(0.90, "moon-dk", 0.24) + stop(1, "moon-dk", 0.58) + "</radialGradient>",
    /* the air around a moon on a clear night */
    "wxg-moonhalo": '<radialGradient id="wxg-moonhalo">'
      + stop(0, "moon", 0.3) + stop(0.42, "moon", 0.12) + stop(1, "moon", 0)
      + "</radialGradient>",
    "wxg-starglow": '<radialGradient id="wxg-starglow">'
      + stop(0, "star", 0.5) + stop(1, "star", 0) + "</radialGradient>",
    /* Rain and fog take userSpaceOnUse: a drop's bounding box is a hair wide, so an
       object-box gradient on its stroke degenerates. Every icon shares one 64x64 space,
       so one definition in that space serves all of them. */
    /* A STREAK IS A HEAD AND A TRAIL, and the ramp between them has to be steep enough to
       see. At 0.12 to 0.85 over the top half it was a stroke that got slightly brighter —
       the sky canvas had already learned that what makes a drop read as FALLING is a
       leading end clearly brighter than what is behind it, and the icon's drops were the
       last flat strokes in the pack. Now the trail is nearly gone and the last third is
       the near-white --ic-rain-lit, which is also what takes the accent blue off them. */
    "wxg-rain": '<linearGradient id="wxg-rain" gradientUnits="userSpaceOnUse"'
      + ' x1="0" y1="34" x2="0" y2="64">'
      + stop(0, "rain", 0.05) + stop(0.34, "rain", 0.42) + stop(0.72, "rain-lit", 0.9)
      + stop(1, "rain-lit", 1) + "</linearGradient>",
    /* FOG, AS A LENS RATHER THAN A LINE. The bands used to be stroked lines with round
       caps under a gradient that ran across the whole 64-space: a band whose ends did not
       reach the gradient's own fade kept full opacity right up to its cap, and a thick
       round-capped stroke at 0.8 is a capsule. Three of those over a cloud read as UI
       pills, which is what a review called them.

       An ELLIPSE has a bounding box in both axes, so it can carry an object-box radial —
       one def that fades every band to nothing at its own ends and its own edges, whatever
       length and thickness it is drawn at. No cap, no rule, no edge anywhere. */
    "wxg-fogband": '<radialGradient id="wxg-fogband">'
      + stop(0, "fog", 1) + stop(0.42, "fog", 0.92) + stop(0.75, "fog", 0.45)
      + stop(1, "fog", 0) + "</radialGradient>",
    /* a flake is not a wire drawing at hero size — it has air lit around it */
    "wxg-bloom": '<radialGradient id="wxg-bloom">'
      + stop(0, "snow", 0.34) + stop(0.5, "snow", 0.12) + stop(1, "snow", 0)
      + "</radialGradient>",
    /* Three stops down the bolt's length, not two: white-hot where it leaves the cloud,
       through the body colour, into amber at the tip. A channel that is the same yellow
       from top to bottom is a road sign. */
    "wxg-bolt": lin("wxg-bolt", 0, 1,
      stop(0, "bolt-hi") + stop(0.4, "bolt") + stop(1, "ray")),
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
      + "</filter>",

    /* THE TERMINATOR, softened by the only honest means there is.

       The line between lunar day and night is not a cut — it is a band a couple of degrees
       wide where the sun is grazing the surface. That band used to be faked by painting
       the shadow four times at four phases a few thousandths apart, which lays down four
       countable steps: a review read them as hard bands with a light stripe sitting
       between the shadow and the disc, which is backwards, because the dimmest lit ground
       on a moon is the ground nearest the terminator.

       One small static blur is what four stacked paths were approximating, and it costs
       one raster on a shape that changes once an hour. It is attached to the HERO discs
       only — the Moon panel draws eleven thumbnails in a strip, and a filter each for a
       band nobody can resolve at 30 px is the trade the icon texture already refuses. */
    "wxf-term": '<filter id="wxf-term" x="-6%" y="-6%" width="112%" height="112%"'
      + ' color-interpolation-filters="sRGB">'
      + '<feGaussianBlur stdDeviation="0.9"/></filter>'
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
