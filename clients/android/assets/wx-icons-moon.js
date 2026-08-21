/* Wall panel dashboard — THE MOON, as a body.

   The one drawing in the pack that is not weather, and the one with a model behind it: a
   phase disc is geometry (a circular limb, an elliptical terminator, maria that go dark
   as the shadow reaches them) where a cumulus is a shape somebody drew. It is also the
   only primitive with two consumers — the weather pack's night icons and the Moon widget's
   tile, week strip and hero — and the whole point of it living in one place is that those
   can never drift into being two moons on one dashboard.

   It is split out of wx-icons.js because that file had reached the 500-line ceiling and
   the next honest improvement to any shape would have had to be paid for by deleting a
   comment somewhere else. The seam is the natural one: bodies here, weather there.

   Loaded BEFORE wx-icons.js (index.html pins the order and a test asserts it), and it
   publishes WP.moonArt for the pack to build its night icons from. The gradients it fills
   with (wxg-moon) are mounted by wx-icons.js into the document's one sprite; ids are
   global, so the order of the two files does not matter to the paint server, only to the
   JavaScript.

   One flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

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
    /* Spread across the middle of the disc rather than clustered right of it: the
       terminator sweeps the face over a month, and a face with a bare mid-left has
       nothing for it to cut across for half of that. A crater the shadow bisects is the
       single detail that says the disc is LIT rather than printed. */
    + '<circle cx="16.5" cy="27" r="2.7" opacity="0.22"/>'
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
    /* The night side, as the disc minus a lit limb. Drawn THREE TIMES at three phases a
       few thousandths apart, because a terminator is not a cut.

       The single evenodd path gave a hard edge — mathematically exact and, at hero size,
       the tell of a mask rather than a lit sphere: the real line is a band a couple of
       degrees wide where the sun is grazing the surface. Stepping the same path back
       toward new twice and painting each at a fraction of the ink lays that band down for
       free, in the geometry that already exists, with no filter and no second id. Toward
       NEW is the direction that grows the shadow, so the feather falls on the lit side
       where the light is failing rather than eating into the dark. */
    function night(pp, op) {
      return '<path fill-rule="evenodd" fill="var(--ic-moon-dk)"'
        + (op ? ' opacity="' + op + '"' : "")
        + ' d="' + ring(cx, cy, r) + " " + moonPath(cx, cy, r, pp) + '"/>';
    }
    var back = p < 0.5 ? -1 : 1;               /* whichever way is toward a new moon */
    return '<g class="wxi-moon">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--ic-moon-dk)"/>'
      + '<path d="' + moonPath(cx, cy, r, p) + '" fill="url(#wxg-moon)"/>'
      + '<g fill="var(--ic-moon-dim)" transform="translate(' + (cx - 32 * s).toFixed(2)
      + " " + (cy - 32 * s).toFixed(2) + ") scale(" + s.toFixed(3) + ')">' + CRATERS + "</g>"
      + night(p + back * 0.022, 0.34) + night(p + back * 0.010, 0.45) + night(p, 0)
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
  /* The pack builds its night icons from `body`; the Moon widget takes `path` and `disc`
     through WP.wxIcon, which re-exports them, so there is one moon in the build and every
     surface that shows one is showing that one. */
  WP.moonArt = { path: moonPath, ring: ring, body: moon, disc: moonDisc };
})();
