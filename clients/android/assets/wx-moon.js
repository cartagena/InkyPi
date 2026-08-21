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
    /* The tile is 102 CSS px wide and its sub-line holds about eleven characters, so
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

  /* The real phase, drawn: dark disc, lit region from the shared crescent path. */
  function disc(p, cls) {
    return '<svg class="' + cls + '" viewBox="0 0 64 64" aria-hidden="true">'
      + '<circle cx="32" cy="32" r="24" fill="var(--ic-moon-dk)"/>'
      + '<path d="' + WP.wxIcon.moonPath(32, 32, 24, p) + '" fill="var(--ic-moon)"/>'
      + "</svg>";
  }

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
        + disc(m.p, "mw-i")
        + '<div class="mw-v">' + Math.round(m.frac * 100) + "%</div></div>";
    }
    return '<div class="moon-week">' + out + "</div>";
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
      big.innerHTML = disc(m.p, "moon-mini")
        + "<span>" + Math.round(m.frac * 100) + "%</span>";
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
        '<div class="moon-hero">' + disc(m.p, "moon-disc")
        + '<div class="moon-hero-t"><div class="big-time">' + Math.round(m.frac * 100) + "%</div>"
        + '<div class="big-sub">illuminated</div></div></div>'
        + section("Next 7 nights", week(Date.now()))
        + section("Cycle", statGrid([
            ["Moon age", (Math.round(m.age * 10) / 10) + " days",
              "of " + Math.round(SYNODIC * 10) / 10],
            /* "Next full moon" — fourteen tracked capitals — wrapped to two lines in a
               third of a 711 px panel once the field label was sized for a 3 m read. The
               section is headed CYCLE and the line under each cell says when, so "next" was
               the word carrying the least. */
            ["Full moon", shortDate(m.nextFull), inDays(m.nextFull)],
            ["New moon", shortDate(m.nextNew), inDays(m.nextNew)]
          ], 3));
    }
  };

  moon.calc = calc;
  WP.register(moon);
})();
