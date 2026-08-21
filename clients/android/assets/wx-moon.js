/* Wall panel dashboard — MOON PHASE.

   Computed locally, no network: the synodic month is regular enough that a fixed epoch
   (the new moon of 2000-01-06 18:14 UTC) plus the mean period lands within a few hours of
   the true phase — more than enough for a wall panel, and it works with the wifi down.

   calc() is pure and exported for the tests; the disc drawing shares moonPath() with the
   icon set so the tile and the panel show literally the same crescent geometry.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section;

  var SYNODIC = 29.530588853;                       // days
  var EPOCH = 947182440000;                         // 2000-01-06 18:14 UTC, a new moon

  function calc(ms) {
    var days = (ms - EPOCH) / 86400000;
    var age = days % SYNODIC;
    if (age < 0) age += SYNODIC;
    var p = age / SYNODIC;
    var frac = (1 - Math.cos(2 * Math.PI * p)) / 2;
    var name =
      (p < 0.02 || p > 0.98) ? "New moon" :
      p < 0.23 ? "Waxing crescent" :
      p < 0.27 ? "First quarter" :
      p < 0.48 ? "Waxing gibbous" :
      p < 0.52 ? "Full moon" :
      p < 0.73 ? "Waning gibbous" :
      p < 0.77 ? "Last quarter" : "Waning crescent";
    /* The tile is 89 CSS px wide and its sub-line holds about ten characters, so
       "Waxing crescent" rendered there as "Waxing cr…". Half of a phase name is worse than
       the half that fits: waxing/waning is the half that says which way the moon is going,
       and crescent-or-gibbous is already answered by the percentage printed beside it. The
       panel keeps the full name. */
    var shortName =
      (p < 0.02 || p > 0.98) ? "New moon" :
      p < 0.48 ? "Waxing" :
      p < 0.52 ? "Full moon" : "Waning";
    var toFull = ((p < 0.5 ? 0.5 : 1.5) - p) * SYNODIC;
    var toNew = (1 - p) * SYNODIC;
    return {
      age: age, p: p, frac: frac, name: name, shortName: shortName,
      nextFull: ms + toFull * 86400000,
      nextNew: ms + toNew * 86400000
    };
  }

  /* The real phase, drawn — by the icon set, not here. The disc, its gradient and its
     craters are one drawing shared by the tile, the week strip and the panel hero, so the
     three can never look like three different moons. */
  var disc = WP.wxIcon.moonDisc;

  /* …and the clear-night WEATHER glyph makes four. It used to draw a fixed crescent, so a
     clear night showed a sliver in the Now card and whatever the sky was actually doing in
     the Moon tile beside it. The model lives here; the icon set only needs to be told
     where to ask. */
  WP.wxIcon.usePhase(function (ms) { return calc(ms).p; });

  function shortDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function inDays(ms) {
    var d = Math.round((ms - Date.now()) / 86400000);
    return d <= 0 ? "tonight" : d === 1 ? "tomorrow" : "in " + d + " days";
  }

  /* The next seven nights, drawn. The panel was a hero in its left third and three bands of
     black totalling ~900 device px, holding four cells two of which repeated the hero (24%
     and "Waxing crescent", both printed twice on one screen). What a moon panel is actually
     for is "what will it look like when I go out this week", and that is a picture, not a
     grid — so the room goes to seven small discs from the same moonPath() the hero uses,
     which means the strip and the hero are literally the same geometry at two sizes. */
  function week(ms) {
    var out = "";
    for (var i = 1; i <= 7; i++) {
      var t = ms + i * 86400000, m = calc(t);
      out += '<div class="mw"><div class="mw-d">'
        + esc(new Date(t).toLocaleDateString(undefined, { weekday: "short" })) + "</div>"
        + disc(m.p, "mw-i", { small: true })
        + '<div class="mw-v">' + Math.round(m.frac * 100) + "%</div></div>";
    }
    return '<div class="moon-week">' + out + "</div>";
  }

  /* The next four principal phases, with the date each lands on.

     The panel's CYCLE row named two of them — full and new — as two cells of a stat grid,
     which left the two quarters unnamed and the bottom third of the screen black. The
     synodic model already knows all four: a phase is a crossing of p = 0, 0.25, 0.5, 0.75,
     so "when next" is one subtraction each and no extra arithmetic. Drawn as discs from
     the same moonPath() the hero uses, so this strip is the hero at a quarter size four
     times over rather than a second way of saying the same thing. */
  var PRINCIPAL = [[0, "New"], [0.25, "First qtr"], [0.5, "Full"], [0.75, "Last qtr"]];

  function nextPhases(ms) {
    var p = calc(ms).p;
    return PRINCIPAL.map(function (q) {
      var ahead = q[0] - p;
      if (ahead <= 0.004) ahead += 1;          /* just passed it: that one is a month away */
      return { p: q[0], name: q[1], at: ms + ahead * SYNODIC * 86400000 };
    }).sort(function (a, b) { return a.at - b.at; });
  }

  function phaseStrip(ms) {
    return '<div class="moon-week four">' + nextPhases(ms).map(function (q) {
      return '<div class="mw"><div class="mw-d">' + esc(q.name) + "</div>"
        + disc(q.p, "mw-i", { small: true })
        + '<div class="mw-v">' + esc(shortDate(q.at)) + "</div>"
        + '<div class="mw-x">' + esc(inDays(q.at)) + "</div></div>";
    }).join("") + "</div>";
  }

  var moon = {
    name: "moon",
    panel: null,

    init: function () {
      this.renderCard();
      /* The phase moves ~1.2%/day; a repaint per hour keeps the tile honest for free. */
      setInterval(this.renderCard.bind(this), 3600 * 1000);
    },

    renderCard: function () {
      var big = $("moon-big"), sub = $("moon-sub");
      if (!big) return;
      var m = calc(Date.now());
      /* The per-cent sign takes the shared small-unit treatment rather than the value's:
         disc plus "62%" at full size measured 86 px inside a 78 px box, and the sign is
         the glyph in it carrying the least. */
      big.innerHTML = disc(m.p, "moon-mini", { small: true })
        + "<span>" + Math.round(m.frac * 100) + '<span class="unit">%</span></span>';
      sub.textContent = m.shortName;
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("moon");
      if (!panel) return;
      var m = calc(Date.now());
      WP.qs("[data-sub]", panel).textContent = m.name;
      /* The hero says the phase once. "Illuminated 24%" was the hero's own number
         repeated as a grid cell, and the panel subtitle already carries the phase name, so
         between them "24%" appeared twice and "Waxing crescent" twice on one screen. The
         three cells that are left are three facts the hero does not have, and each carries
         the answer people actually want under it: how long until. */
      WP.qs("[data-body]", panel).innerHTML =
        '<div class="moon-hero">' + disc(m.p, "moon-disc", { halo: true })
        + '<div class="moon-hero-t"><div class="big-time">' + Math.round(m.frac * 100) + "%</div>"
        + '<div class="big-sub">illuminated</div></div></div>'
        + section("Next 7 nights", week(Date.now()))
        /* Four cells that were two. "Full moon" and "New moon" as stat cells left the two
           quarters unnamed and ~300 device px of black under them; the same four facts as
           discs are a picture of the month ahead. */
        + section("Next phases", phaseStrip(Date.now()))
        /* Two cells, and they are the two facts nothing else on this screen carries. It
           held "Full moon" and "New moon" as dates, which the phase strip above now draws;
           a first rewrite put "Lit 62% · Waxing gibbous" here, which is the hero's own
           number and the panel's own subtitle printed a third and second time. Where this
           cycle STARTED is genuinely new — everything else on the screen looks forward. */
        + section("Cycle", statGrid([
            ["Moon age", (Math.round(m.age * 10) / 10) + '<span class="unit"> days</span>',
              "of " + Math.round(SYNODIC * 10) / 10 + " · " + Math.round(m.p * 100) + "% through"],
            ["Cycle began", shortDate(m.nextNew - SYNODIC * 86400000),
              Math.round(m.age) + " days ago"]
          ], 2));
    }
  };

  moon.calc = calc;
  WP.register(moon);
})();
