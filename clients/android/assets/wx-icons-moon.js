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

  /* THE SEAS COME BACK, and this is the correction to a round that took them out.

     An earlier pass replaced every dark feature on the face with a circular crater bowl,
     on the reasoning that a bowl is a lit depression and a flat grey patch is not. Both
     halves of that are true and the conclusion was still wrong: what a person actually
     recognises a moon by, at any size, is the MARIA — the big irregular basalt plains,
     Imbrium and Serenitatis and Tranquillitatis and the rest — and a disc carrying only
     round pits reads as a golf ball. Craters are the detail; the seas are the face.

     So both, in the 64-space of a full disc: seas first as large irregular shapes, then
     craters as small bowls over them. Placed roughly where the real ones are, north up,
     spread across the middle rather than clustered on one side — the terminator sweeps
     the face over a month, and a feature the shadow bisects is the single detail that
     says the disc is LIT rather than printed. */
  /* Three roughness rings, shared out so no two neighbouring seas wear the same coast.

     Built from three low harmonics rather than typed out as twelve numbers, because a
     hand-typed ring alternates high and low from one point to the next and an alternating
     ring is a STAR — the first version of these came out a row of pentagons. A coastline
     is low-frequency: one big lobe, a smaller one across it, a third smaller still. */
  function ringOf(p1, p2, p3) {
    var r = [], i, a;
    for (i = 0; i < 16; i++) {
      a = i / 16 * Math.PI * 2;
      r.push(1 + 0.17 * Math.sin(a + p1) + 0.14 * Math.sin(2 * a + p2)
        + 0.10 * Math.sin(3 * a + p3) + 0.05 * Math.sin(5 * a + p1 + p2));
    }
    return r;
  }
  var R1 = ringOf(0.4, 1.9, 3.3), R2 = ringOf(2.2, 0.6, 4.7), R3 = ringOf(4.1, 3.0, 1.2);
  /*  cx     cy    rx    ry   tilt   ring  opacity */
  var SEAS = [
    [21.5, 20.5, 9.4, 7.0, -0.35, R1, 0.40],   /* Imbrium — the big one, upper left */
    [33.5, 19.5, 5.2, 4.6,  0.20, R2, 0.34],   /* Serenitatis */
    [40.5, 27.5, 5.8, 6.4, -0.50, R3, 0.36],   /* Tranquillitatis, down into Nectaris */
    [48.5, 19.5, 3.0, 2.5,  0.40, R2, 0.30],   /* Crisium, on its own near the limb */
    [13.5, 32.0, 4.8, 8.6,  0.15, R3, 0.28],   /* Procellarum, hugging the western limb */
    [44.5, 36.5, 3.6, 4.4,  0.30, R1, 0.26],   /* Fecunditatis */
    [22.5, 41.5, 5.6, 3.8, -0.20, R2, 0.24]    /* Nubium and Humorum, low and soft */
  ];

  /* A closed blob through a ring of jittered radii, smoothed with Catmull-Rom, then
     squashed and tilted. A mare is a flooded impact basin with a ragged coast, so it
     cannot be a circle; and it cannot be random either, because the same seas have to be
     in the same places on every render and on every one of the twenty-odd discs a
     dashboard shows at once. A fixed radius ring gives an irregular shape that is
     nonetheless the SAME irregular shape every time, and sixteen points around it is the
     number where the outline stops reading as a rounded polygon. The jitter is held to
     about a fifth of the radius: a Catmull-Rom through widely-spread radii OVERSHOOTS at
     the peaks, and the first attempt at this came out a ring of star-shaped patches.

     Deliberately no arc commands: the icon tests read the first `A rx ry 0 0 f … Z` in the
     markup as the terminator, and a sea drawn with arcs would be found first. */
  function blob(cx, cy, rx, ry, rot, rr) {
    var n = rr.length, p = [], i, a, d = "";
    var co = Math.cos(rot), si = Math.sin(rot);
    for (i = 0; i < n; i++) {
      a = i / n * Math.PI * 2;
      var u = Math.cos(a) * rx * rr[i], v = Math.sin(a) * ry * rr[i];
      var px = cx + u * co - v * si, py = cy + u * si + v * co;
      /* HELD INSIDE THE LIMB. Procellarum sits on the western edge of the visible face and
         its coast, jittered outward, put a lump of sea outside the disc — a clipPath would
         fix it and would also put an id on an element the tile replaces every hour, which
         is the duplicate-reference trap the gradients were taken out of. Pulling the stray
         points back onto a circle just inside the limb costs two lines and looks right for
         the same reason it is needed: a mare near the edge IS foreshortened flat against
         the limb. */
      var dx = px - 32, dy = py - 32, dd = Math.sqrt(dx * dx + dy * dy);
      if (dd > 22.6) { px = 32 + dx * 22.6 / dd; py = 32 + dy * 22.6 / dd; }
      p.push([px, py]);
    }
    function f(v2) { return v2.toFixed(2); }
    for (i = 0; i < n; i++) {
      var p0 = p[(i + n - 1) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
      if (!i) d = "M " + f(p1[0]) + " " + f(p1[1]);
      d += " C " + f(p1[0] + (p2[0] - p0[0]) / 6) + " " + f(p1[1] + (p2[1] - p0[1]) / 6)
        + " " + f(p2[0] - (p3[0] - p1[0]) / 6) + " " + f(p2[1] - (p3[1] - p1[1]) / 6)
        + " " + f(p2[0]) + " " + f(p2[1]);
    }
    return d + " Z";
  }

  /* The seas, in the limb-turning tone rather than in the shadow tone: a mare is darker
     ground, not a hole, and on a photograph it is a blue-grey wash over the highlands
     with no edge you could put a pencil on. Hence one flat fill at a low alpha and no
     stroke anywhere — the softness has to come from the alpha, because a blur per sea is
     eight rasters on a disc the strip draws eleven of. */
  function seas() {
    return SEAS.map(function (m) {
      return '<path d="' + blob(m[0], m[1], m[2], m[3], m[4], m[5])
        + '" fill="var(--ic-moon-dim)" opacity="' + m[6] + '"/>';
    }).join("");
  }

  /* The craters: small, round, and now a garnish on the seas rather than the whole face.
     Fewer and smaller than the set they replaced, and placed in the bright highlands
     between the seas where the real conspicuous ones (Copernicus, Kepler, Tycho and its
     rays) actually are. x, y, radius, weight. */
  var CRATERS = [[27.5, 31.5, 2.4, 0.30], [20.5, 35.5, 1.7, 0.26], [30.5, 49.5, 2.2, 0.30],
               [41.5, 44.5, 1.5, 0.24], [17.5, 22.5, 1.6, 0.22], [36.5, 15.0, 1.4, 0.20],
               [46.5, 40.0, 1.5, 0.22]];

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
    return CRATERS.map(function (c) {
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
      + seas() + craters(lush, wane) + "</g>"
      + night
      /* Limb darkening, over everything — the sphere turning away, and it turns away on
         the night side too.

         AND NO HAIRLINE ROUND THE OUTSIDE ANY MORE. There used to be one, in the maria
         tone at a third of an alpha, on the argument that a new moon would otherwise
         vanish. It did two things instead: a new moon does not vanish (the whole disc is
         already painted as earthshine, several levels off black and perfectly legible),
         and the stroke ran the WHOLE circumference — including the dark limb, where a
         probe caught it forty levels brighter than the night side it edged. A rim light
         on the unlit limb is the one thing a moon cannot have: there is nothing out there
         to light it. The limb gradient below is the only edge treatment left, and it only
         ever darkens. */
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#wxg-limb)"/>'
      + "</g>";
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
