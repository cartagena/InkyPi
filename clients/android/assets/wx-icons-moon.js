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

  /* An arc of a circle, by angle — the lit rim on the far side of a crater, and nothing
     else now. It used to strike the near wall too, in a dark tone, and that pair rendered
     as an open horseshoe: the "lit" arc was drawn in a colour the face was already
     wearing, so only the shadow ever registered and every crater came out a dark C. */
  function arc(cx, cy, r, a0, a1) {
    function pt(a) {
      return (cx + Math.cos(a) * r).toFixed(2) + " " + (cy + Math.sin(a) * r).toFixed(2);
    }
    return "M " + pt(a0) + " A " + r.toFixed(2) + " " + r.toFixed(2) + " 0 0 1 " + pt(a1);
  }

  /* A CRATER IS A CLOSED BOWL. One filled disc carrying wxg-crater — a ramp running from
     the sunward wall in its own shadow, through the floor, to the far wall square-on to
     the light — so the depression is a shape rather than an outline, and there is no gap
     in it for the face to show through.

     `deep` adds the one detail the fill cannot carry: the raised rim on the far side,
     struck just OUTSIDE the bowl, which is the ground the ejecta piled up on and the
     brightest thing on a lunar photograph. Off for the small phase discs — eleven of them
     on the Moon panel at 30-odd pixels each, where an extra stroke per crater is nodes
     nobody can resolve. */
  function craters(deep, wane) {
    /* the far wall is opposite the sun, and the sun swaps sides at full moon */
    var a0 = wane ? -0.53 : 1.05, a1 = wane ? 2.09 : 3.67;
    return MARIA.map(function (c) {
      var x = c[0], y = c[1], r = c[2], o = c[3];
      var s = '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="url(#wxg-crater'
        + (wane ? "w" : "") + ')" opacity="' + (o * 2.15).toFixed(2) + '"/>';
      if (!deep) return s;
      return s + '<path d="' + arc(x, y, r * 1.06, a0, a1) + '" fill="none"'
        + ' stroke="var(--ic-moon-lit)" stroke-width="' + (r * 0.26).toFixed(2)
        + '" stroke-linecap="round" opacity="' + (o * 1.5).toFixed(2) + '"/>';
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

     WHAT MAKES IT A SPHERE rather than two flat shapes butted together is three things:
     a terminator that is a soft band and not a cut, a face whose dimmest lit ground is
     the ground NEAREST that band (which is where the sun is grazing it), and craters that
     are closed bowls. None of them is a highlight — a specular hotspot on a moon is a
     pearl button, because regolith back-scatters and does not shine. */
  function moon(cx, cy, r, p, deep) {
    var s = r / 24;                            /* the maria are authored on a 24-unit disc */
    /* HERO-SIZED DISCS ONLY get the soft terminator and the deep craters. The Moon panel
       draws eleven thumbnails in a strip at 30-odd pixels; a blur raster each, for a band
       two pixels wide, is the same trade the cloud texture already refuses. */
    var lush = deep !== false && r >= 14;
    var wane = p >= 0.5;                       /* after full, the sun lights the left limb */
    /* The night side, as the disc minus a lit limb.

       ONE shadow, softened by one small static blur. It used to be the same path painted
       four times at four phases a few thousandths apart, on the theory that stepping the
       geometry would lay the band down for free — and it does lay something down, but what
       it lays down is four countable steps with a lighter ribbon between the shadow and
       the face. A review read that ribbon as backwards, and it is: the ground nearest the
       terminator is the ground the sun is grazing, so it should be the DIMMEST lit tone on
       the disc, which is what the body gradient now makes it. The shadow's job is only to
       stop being a knife edge, and a blur of under a unit does that in one raster on a
       shape that changes once an hour.

       TWO of them, though, and the second is why. A blur softens every edge it is given,
       including the shadow's outer one — which is the LIMB, where the dark side should
       simply stop. Softened there it let the lit sphere underneath show through as a pale
       crescent hugging the outside of the shadow, a rim of light on the night side. So a
       hard copy goes down too, stepped a hair toward full so its own terminator sits
       INSIDE the soft one: it holds the limb opaque and the blurred pass lays the band
       across the only edge that wants one. Both are the same opaque fill, so which of the
       two is painted first makes no difference to the picture — the soft one leads only so
       that the first phase in the markup is the REAL one, which is what the tests read. */
    function disc(pp) {
      return '<path fill-rule="evenodd" fill="var(--ic-moon-dk)"'
        + ' d="' + ring(cx, cy, r) + " " + moonPath(cx, cy, r, pp) + '"/>';
    }
    /* A HAIR toward full, clamped short of it. 0.028 of a synodic month is two or three
       units of terminator at hero size — comfortably more than the blur's own reach, so
       the hard copy's edge lands where the soft one is already solid and never shows. The
       clamp matters at the two ends: step across 0.5 and the lit limb changes sides, and
       the hard copy would mirror itself onto the wrong half of the disc. */
    var hard = p < 0.5 ? Math.min(p + 0.028, 0.499) : Math.max(p - 0.028, 0.501);
    /* THE BLUR IS ATTACHED BY THE STYLESHEET, not here — the same rule the cloud texture
       lives by. A clear night puts this moon in the Now card AND in twenty-four hourly
       glyphs AND in seven daily ones, all at the same authored radius; a filter written
       into the markup would rasterise thirty-one blurs for a band two pixels wide on
       thirty of them. style-icons.css turns it on for the hero sizes only, and without it
       the pair simply collapses to the hard terminator the small discs already had. */
    var night = lush
      ? '<g class="wxi-term">' + disc(p) + "</g>" + disc(hard)
      : disc(p);
    return '<g class="wxi-moon">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--ic-moon-dk)"/>'
      /* THE WHOLE DISC takes the sphere gradient, not the lit limb alone. Filling the
         crescent painted an object-bounding-box gradient into whatever shape the phase
         happened to be, so its bright stop was squeezed into a narrow vertical band that
         slid across the face over the month — which is the "bright rim line down the
         terminator" that made the disc read as two flat shapes butted together. A sphere's
         shading belongs to the sphere; the phase is a shadow cast ON it, and it goes on
         afterwards. */
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-moon'
      + (wane ? "w" : "") + ')"/>'
      + '<g transform="translate(' + (cx - 32 * s).toFixed(2)
      + " " + (cy - 32 * s).toFixed(2) + ") scale(" + s.toFixed(3) + ')">'
      + craters(lush, wane) + "</g>"
      + night
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
  function moonDisc(p, cls, opt) {
    opt = opt || {};
    /* `small` and `halo` are the two things the disc cannot work out for itself. Every
       copy is authored at r=24 and shrunk by the stylesheet, so the body has no way to
       know whether it is the panel hero or one of eleven thumbnails in a strip — and the
       crater rim strokes that make a depression read at 300 px are 200 nodes nobody can
       resolve at 30. The halo is the same call from the other side: the panel's own hero
       hangs on a black field at night and wants air around it; a thumbnail in a row does
       not, because the glow of eleven of them is a smear. */
    return '<svg class="' + (cls || "wxi") + '" viewBox="0 0 64 64" aria-hidden="true">'
      + (opt.halo ? '<circle cx="32" cy="32" r="31.5" fill="url(#wxg-moonhalo)"/>' : "")
      + moon(32, 32, 24, p, !opt.small) + "</svg>";
  }
  /* The pack builds its night icons from `body`; the Moon widget takes `path` and `disc`
     through WP.wxIcon, which re-exports them, so there is one moon in the build and every
     surface that shows one is showing that one. */
  WP.moonArt = { path: moonPath, ring: ring, body: moon, disc: moonDisc };
})();
