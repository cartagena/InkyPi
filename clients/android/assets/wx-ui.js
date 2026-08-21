/* Wall panel dashboard — SHARED WIDGET PLUMBING.

   Each widget is a self-contained plugin object registered with WP.register():

     name      matches the card's data-widget / data-open and the panel's data-panel
     init()    called once at boot; owns its own refresh cadence
     onOpen()  fills its full-screen detail panel (panel element, optional argument)
     onClose() tears down anything the panel started (per-second tickers, mostly)

   Nothing in one widget touches another widget's DOM. The only cross-widget wiring is the
   weather fetch: one request feeds the "now", "hourly" and "daily" cards, so those three
   read WP.registry.weather rather than each hitting Open-Meteo separately.

   This file is the vocabulary they are all written in. It ships before every wx-*.js in
   index.html and hangs the builders off WP.ui — one namespace rather than eight copies, so
   a change to how a stat grid or a switch row is drawn lands in all eight panels at once.
   That is not tidiness: it is the mechanism by which the panels stay one design system.
*/

(function () {
  "use strict";

  var esc = WP.esc;

  /* ---------------- shared panel building blocks ----------------

     Every panel is assembled from these five, which is what keeps eight screens looking
     like one app. Two rules they enforce on their callers:

       * no font-size is authored anywhere in this file. Sizes come off the ramp in
         style.css (--fs-caption … --fs-display-xl) and a widget picks a CLASS, not a size.
       * a glyph that repeats information the words beside it already carry is decorative,
         so it is emitted with aria-hidden. The accessible name comes from the text, or from
         an explicit aria-label where the control is icon-only. */

  /* A grid of labelled values — the backbone of most detail panels.
     items: [label, valueHTML, extraText?]
     cols:  2 (default) or 3. Three is for panels whose values are short — a percentage, a
            temperature, a wind speed. Conditions was 111vh of a 100vh screen on two. */
  function statGrid(items, cols) {
    var n = cols === 3 ? 3 : 2;
    /* Cells on the LAST ROW carry no rule under them. Every grid in the app ended with a
       hairline drawn under its final row with nothing following it, which is the classic
       unfinished-table tell — and on five panels it was the last thing on the screen. The
       row is worked out here rather than in CSS because :nth-last-child cannot know how
       many cells the caller passed, and a grid of four in three columns has a last row of
       one. */
    var firstOfLastRow = Math.floor((items.length - 1) / n) * n;
    return '<div class="stat-grid' + (n === 3 ? " cols3" : "") + '">' + items.map(function (it, i) {
      return '<div class="stat' + (i >= firstOfLastRow ? " last-row" : "") + '">'
        + '<div class="stat-k">' + esc(it[0]) + "</div>"
        + '<div class="stat-v">' + it[1] + "</div>"
        + (it[2] ? '<div class="stat-x">' + esc(it[2]) + "</div>" : "")
        + "</div>";
    }).join("") + "</div>";
  }

  /* Which of the three temperature stops a reading falls on, against a stated [lo, hi].
     Three widgets ask this now — the hourly list tints its figures with it, the daily
     chart caps its 24 bars with it, and the hourly curve is drawn from the same three
     stops — so it lives here with the rest of the shared vocabulary rather than inside
     one of them.

     The BOUNDARIES are the arithmetic that makes the list a legend for the curve instead
     of a second opinion about it. The curve is a vertical gradient with hot at the top,
     warm at the middle and cold at the bottom, so a reading at fraction f of the range
     sits at gradient position 1 - f, and the stop it is NEAREST is hot above 0.75, cold
     below 0.25 and warm between. The previous cuts were 0.66 / 0.33 against a gradient
     whose middle stop was at 0.55, and the disagreement was visible on one screen: 72°
     rendered blue in the NEXT HOURS list and pale warm-cream on the curve 400 px above it.
     Same datum, same screen, two answers.

     Three buckets, not an interpolation: the app has exactly three temperature tokens and
     a widget picks a CLASS, never a colour — the same rule the type ramp works by. */
  function tempTone(t, lo, span) {
    var f = (t - lo) / (span || 1);
    return f > 0.75 ? "t-hot" : f > 0.25 ? "t-warm" : "t-cold";
  }

  function section(title, inner, cls) {
    return '<section class="psec' + (cls ? " " + cls + '"' : '"')
      + '><h2 class="psec-t">' + esc(title) + "</h2>" + inner + "</section>";
  }

  /* The one hero block a panel opens with: glyph, the single number the screen is about,
     and a line of context. Laid out as a row (see .big-readout.hero) — stacking the glyph
     spent ~8vh on a line that says nothing the words underneath do not, and it is the home
     Now card's layout, so the panel reads as a magnification of the card that opened it. */
  /* An empty icon emits no icon box. It used to emit an empty one, which on a flex row with
     a gap is a visible indent with nothing in it — and the Air panel now opens without a
     glyph, because the two things it kept trying to draw there (a hollow ring, then a 43 px
     arc) were decoration standing in for a scale that is drawn properly underneath. */
  function hero(icon, valueHtml, subHtml, iconCls) {
    return '<div class="big-readout hero' + (icon ? "" : " no-icon") + '">'
      + (icon ? '<div class="big-icon' + (iconCls ? " " + iconCls : "") + '" aria-hidden="true">'
                  + icon + "</div>" : "")
      + '<div class="hero-text">'
      + '<div class="big-time">' + valueHtml + "</div>"
      + '<div class="big-sub">' + subHtml + "</div></div></div>";
  }

  /* A chart, with the four labels that are the difference between a picture and a chart:
     the top and bottom of the y-domain down the left edge, and the two ends of the x-domain
     under it. Without them a line's height means nothing and the shape is unopposed —
     whatever it does reads as what happened.

     It lives here rather than in the panel that first needed it because a second panel now
     draws a trace (Air Quality's next 24 hours was a bare squiggle with no scale, no ticks
     and no annotation, one screen away from an hourly chart that had all three), and two
     charts annotated two ways is two design systems.

     The labels are HTML over the SVG, not SVG <text>: a size inside a scaling viewBox is a
     size authored outside the ramp, and these sit at the annotation tier (--fs-body-lg).
     They cost the chart no height.

     The y labels are inside their own .plot-y box, which is exactly the picture. They used
     to be positioned against the whole .plot — including the time row — with .plot-lo held
     off the bottom by a hand-tuned 2.2vh, and the moment the annotation tier grew that gap
     stopped being enough: reading down the left edge of the Sensors panel gave `75.5 °F`,
     the chart, `2h ago`, and THEN `71.5 °F`, so the bottom of the y-scale read as a pair
     with the start of the x-scale. A box that ends where the picture ends cannot be
     mis-tuned; nothing here is a magic number any more. */
  function plot(svg, hi, lo, from, to, cls) {
    return '<div class="plot' + (cls ? " " + cls : "") + '">'
      + '<div class="plot-y">' + svg
      + '<span class="plot-hi">' + esc(hi) + "</span>"
      + '<span class="plot-lo">' + esc(lo) + "</span></div>"
      + '<div class="plot-x"><span>' + esc(from) + "</span><span>"
      + esc(to) + "</span></div></div>";
  }

  /* Horizontal fill bar with a percentage. Used for storage, memory and battery. */
  function bar(pct, tone, label) {
    var p = Math.max(0, Math.min(100, pct || 0));
    return '<div class="bar" role="img" aria-label="'
      + esc((label || "") + " " + Math.round(p) + " percent").trim()
      + '"><div class="bar-fill ' + (tone || "")
      + '" style="width:' + p.toFixed(1) + '%"></div></div>';
  }

  function btn(act, label, cls, arg, ns, aria) {
    return '<button class="btn tappable ' + (cls || "") + '" data-act="' + act + '"'
      + (arg != null ? ' data-arg="' + esc(arg) + '"' : "")
      + (ns ? ' data-ns="' + ns + '"' : "")
      + (aria ? ' aria-label="' + esc(aria) + '"' : "")
      + ">" + label + "</button>";
  }

  /* Segmented choice — the ONLY paired-button idiom in the app, and it is reserved for a
     genuine either/or with two named values (°F/°C, 12-hour/24-hour). Anything that is
     merely on or off is a switchRow. Settings used to carry both idioms 20 cm apart on one
     screen: "Hide seconds | Show seconds" as a pair of buttons, then "Clock / Weather now /
     Hourly forecast" as switches, all of them the same boolean.

     A single-choice group of buttons is a radiogroup, not a row of independent buttons —
     without that a reader is told "Show seconds, button" with nothing to say which of the
     pair is currently in force. */
  function segmented(ns, act, options, current, groupLabel) {
    return '<div class="seg" role="radiogroup"'
      + (groupLabel ? ' aria-label="' + esc(groupLabel) + '"' : "") + ">"
      + options.map(function (o) {
        var on = String(o[0]) === String(current);
        return '<button class="seg-b tappable' + (on ? " on" : "")
          + '" role="radio" aria-checked="' + (on ? "true" : "false")
          + '" data-ns="' + ns + '" data-act="' + act + '" data-arg="' + esc(o[0]) + '">'
          + esc(o[1]) + "</button>";
      }).join("") + "</div>";
  }

  /* The one on/off idiom. Full-width row so the target is the whole line (>= 88 device px
     tall), label left, knob right, and the knob slides rather than snapping.
     role=switch + aria-checked is what makes it announce as a switch and say which way it
     is set; the pill itself carries no information the state does not, so it is hidden from
     the accessibility tree rather than being read a second time. */
  function switchRow(ns, act, label, on, arg, note) {
    return '<button class="srow tappable" role="switch" aria-checked="' + (on ? "true" : "false")
      + '" data-ns="' + ns + '" data-act="' + act + '"'
      + (arg != null ? ' data-arg="' + esc(arg) + '"' : "") + ">"
      + '<span class="srow-t"><span class="srow-k">' + esc(label) + "</span>"
      + (note ? '<span class="srow-x">' + esc(note) + "</span>" : "") + "</span>"
      + '<span class="switch' + (on ? " on" : "") + '" aria-hidden="true"><span></span></span>'
      + "</button>";
  }

  WP.ui = {
    statGrid: statGrid,
    section: section,
    tempTone: tempTone,
    hero: hero,
    plot: plot,
    bar: bar,
    btn: btn,
    segmented: segmented,
    switchRow: switchRow
  };
})();
