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

  /* Maria and craters, in the 64-space of a full disc. Placed where the real ones are,
     roughly, so a full moon reads as a face rather than as a plate: x, y, radius, weight.

     Spread across the middle of the disc rather than clustered right of it — the
     terminator sweeps the face over a month, and a face with a bare mid-left has nothing
     for it to cut across for half of that. A crater the shadow bisects is the single
     detail that says the disc is LIT rather than printed. */
  var MARIA = [[25, 21.5, 4.4, 0.30], [38.5, 26, 2.6, 0.26], [30, 37, 5.6, 0.22],
               [43, 40.5, 3, 0.26], [19.5, 33, 2.3, 0.24], [16.5, 27, 2.7, 0.22],
               [35, 46, 2, 0.20]];

  /* An arc of a circle, by angle. Craters are drawn from these rather than as offset
     discs because what makes a depression read as a depression is that its two inner
     walls disagree: the wall facing the sun is in its own shadow and the wall opposite is
     square-on to the light. Two arcs, no clip path, no id. */
  function arc(cx, cy, r, a0, a1) {
    function pt(a) {
      return (cx + Math.cos(a) * r).toFixed(2) + " " + (cy + Math.sin(a) * r).toFixed(2);
    }
    return "M " + pt(a0) + " A " + r.toFixed(2) + " " + r.toFixed(2) + " 0 0 1 " + pt(a1);
  }

  /* The moon's gradient lights it from the upper right, so that is where every crater's
     shadow goes. `deep` is off for the small phase discs — eleven of them on the Moon
     panel at 30-odd pixels each, where three extra strokes per crater is 200 nodes
     nobody can resolve. */
  function craters(deep) {
    return MARIA.map(function (c) {
      var x = c[0], y = c[1], r = c[2], o = c[3];
      var s = '<circle cx="' + x + '" cy="' + y + '" r="' + r
        + '" fill="var(--ic-moon-dim)" opacity="' + o + '"/>';
      if (!deep) return s;
      var ir = r * 0.82, w = (r * 0.3).toFixed(2);
      return s
        + '<path d="' + arc(x, y, ir, -2.36, 0.79) + '" fill="none"'
        + ' stroke="var(--ic-moon-dk)" stroke-width="' + w + '" stroke-linecap="round"'
        + ' opacity="' + (o * 1.5).toFixed(2) + '"/>'
        + '<path d="' + arc(x, y, ir, 0.79, 3.93) + '" fill="none"'
        + ' stroke="var(--ic-moon-lit)" stroke-width="' + w + '" stroke-linecap="round"'
        + ' opacity="' + (o * 0.85).toFixed(2) + '"/>';
    }).join("");
  }

  /* THE NIGHT ICON'S MOON, and it is the whole body — not the lit limb alone.

     It used to be a fixed pleasant crescent at p=0.18, on the reasoning that nobody reads
     a gibbous from a quarter at 2.9vh. Two things were wrong with that. The Moon tile sits
     three inches away on the same dashboard reporting the real phase, so a clear night
     showed a thin crescent in the Now card and a half-lit disc in the tile — one sky, two
     moons. And a crescent is ~8 units of ink where the cloud beside it is ~790, which is
     why the night glyph measured a third of the width of every other icon in the pack.

     Both fall out of drawing the disc the way the Moon panel draws it: the whole body,
     dark side present as earthshine, lit limb at the LIVE phase.

     WHAT MAKES IT A SPHERE rather than two flat shapes butted together is three things,
     none of them a filter: a terminator FEATHERED over four steps instead of cut, limb
     darkening on the outer eighth of the radius (a sphere does not end at a bright line,
     it turns away), and craters with two disagreeing inner walls. */
  function moon(cx, cy, r, p) {
    var s = r / 24;                            /* the maria are authored on a 24-unit disc */
    /* The night side, as the disc minus a lit limb. Drawn FOUR TIMES at four phases a few
       thousandths apart, because a terminator is not a cut.

       The single evenodd path gave a hard edge — mathematically exact and, at hero size,
       the tell of a mask rather than a lit sphere: the real line is a band a couple of
       degrees wide where the sun is grazing the surface. Stepping the same path back
       toward new and painting each at a fraction of the ink lays that band down for free,
       in the geometry that already exists, with no filter and no second id. Toward NEW is
       the direction that grows the shadow, so the feather falls on the lit side where the
       light is failing rather than eating into the dark. */
    function night(pp, op) {
      return '<path fill-rule="evenodd" fill="var(--ic-moon-dk)"'
        + (op ? ' opacity="' + op + '"' : "")
        + ' d="' + ring(cx, cy, r) + " " + moonPath(cx, cy, r, pp) + '"/>';
    }
    var back = p < 0.5 ? -1 : 1;               /* whichever way is toward a new moon */
    return '<g class="wxi-moon">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--ic-moon-dk)"/>'
      /* THE WHOLE DISC takes the sphere gradient, not the lit limb alone. Filling the
         crescent painted an object-bounding-box gradient into whatever shape the phase
         happened to be, so its bright stop was squeezed into a narrow vertical band that
         slid across the face over the month — which is the "bright rim line down the
         terminator" that made the disc read as two flat shapes butted together. A sphere's
         shading belongs to the sphere; the phase is a shadow cast ON it, and it goes on
         afterwards. */
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-moon)"/>'
      + '<g transform="translate(' + (cx - 32 * s).toFixed(2)
      + " " + (cy - 32 * s).toFixed(2) + ") scale(" + s.toFixed(3) + ')">'
      + craters(r >= 14) + "</g>"
      + night(p, 0) + night(p + back * 0.009, 0.40)
      + night(p + back * 0.019, 0.30) + night(p + back * 0.030, 0.24)
      /* the limb, and then the hairline that keeps a new moon from vanishing entirely */
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-limb)"/>'
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
