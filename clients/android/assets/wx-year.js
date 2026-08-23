/* Wall panel dashboard — YEAR PROGRESS (+ countdowns).

   Two InkyPi plugins on glass, in one tile because they are the same question asked two
   ways — "how far through are we?": `year_progress` (the percentage of the year gone and
   the days left, as a bar) and `countdown` (named dates and the days until each). Both
   are computed locally from the device clock; no network, no key, works with the wifi
   down. Countdowns come from CONFIG.countdowns — [{ title, date: "YYYY-MM-DD" }], the
   same two fields the server plugin asks for — and the nearest one rides the tile's
   sub-line so a date that matters is visible without opening anything.

   The Clock panel already says "Day 229 of 365" and the ISO week; this panel does not
   repeat either. It is about what is LEFT: the year, the month, the quarter, the dates.

   calc() and countdowns() are pure and exported for the tests. All arithmetic is
   midnight-to-midnight in local time (see fmt.dayOfYear for why milliseconds-from-now
   is wrong across a DST change).

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc, fmt = WP.fmt;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero, bar = ui.bar;

  var DAY = 86400000;

  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysBetween(a, b) { return Math.round((midnight(b) - midnight(a)) / DAY); }

  /* Everything the tile and the panel print, from one instant. Percentages are of whole
     days elapsed at the START of today — the server plugin rounds the same way, so the
     wall and the Pi agree on the number. */
  function calc(ms) {
    var now = new Date(ms);
    var y = now.getFullYear(), m = now.getMonth();
    var soy = new Date(y, 0, 1), eoy = new Date(y + 1, 0, 1);
    var som = new Date(y, m, 1), eom = new Date(y, m + 1, 1);
    var q = Math.floor(m / 3);
    var soq = new Date(y, q * 3, 1), eoq = new Date(y, q * 3 + 3, 1);

    var yearDays = daysBetween(soy, eoy), yearGone = daysBetween(soy, now);
    var monthDays = daysBetween(som, eom), monthGone = daysBetween(som, now);
    var quarterDays = daysBetween(soq, eoq), quarterGone = daysBetween(soq, now);

    return {
      year: y,
      pct: Math.round(yearGone / yearDays * 100),
      daysLeft: yearDays - yearGone,
      monthPct: Math.round(monthGone / monthDays * 100),
      monthDaysLeft: monthDays - monthGone,
      monthEnd: new Date(eom - DAY),
      quarter: q + 1,
      quarterPct: Math.round(quarterGone / quarterDays * 100),
      quarterDaysLeft: quarterDays - quarterGone
    };
  }

  /* CONFIG.countdowns, cleaned and sorted: soonest first, past dates last. A row with no
     usable date is dropped rather than shown as a wrong number; a missing title gets the
     server plugin's fallback. Dates are "YYYY-MM-DD" and are read as LOCAL midnight —
     Date.parse would make them UTC and shift every countdown a day on this side of the
     Atlantic. */
  function countdowns(list, ms) {
    var now = new Date(ms);
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || typeof c.date !== "string") return;
      var mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.date.trim());
      if (!mm) return;
      var d = new Date(+mm[1], +mm[2] - 1, +mm[3]);
      if (isNaN(d.getTime()) || d.getMonth() !== +mm[2] - 1) return;   // 2026-02-30
      var days = daysBetween(now, d);
      out.push({
        title: (typeof c.title === "string" && c.title.trim()) || "Countdown",
        date: d, days: days,
        label: days >= 0 ? "left" : "ago"
      });
    });
    out.sort(function (a, b) {
      if ((a.days < 0) !== (b.days < 0)) return a.days < 0 ? 1 : -1;
      return Math.abs(a.days) - Math.abs(b.days);
    });
    return out;
  }

  /* "in 12 days" / "tomorrow" / "today" / "3 days ago" — the tile's words. */
  function when(days) {
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days === -1) return "yesterday";
    return days > 0 ? "in " + days + " days" : (-days) + " days ago";
  }

  function shortDate(d) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function weekdayDate(d) {
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  /* THE YEAR AT A GLANCE. Two bars said "64% of the year and 65% of the month", which is
     the same sentence twice and neither of them says WHICH part is gone. Twelve cells do:
     the months behind are lit, the month you are in is lit as far as today, and the rest
     are the empty track. It is the InkyPi year_progress plugin's own picture, and it is
     what the bottom third of this panel was black for.

     Initials rather than "Jan": twelve three-letter labels do not fit 668 px at any tier
     the ramp will admit, and the row is read as a shape — the label is there to find your
     place in it, not to be read left to right. Taken from the runtime locale, because a
     month grid that spells the months in English on a French tablet is worse than none. */
  function monthGrid(now) {
    var y = now.getFullYear(), m = now.getMonth();
    var som = new Date(y, m, 1), eom = new Date(y, m + 1, 1);
    var through = daysBetween(som, now) / daysBetween(som, eom) * 100;
    var out = "";
    for (var i = 0; i < 12; i++) {
      var pct = i < m ? 100 : (i === m ? through : 0);
      var name = new Date(y, i, 1).toLocaleDateString(undefined, { month: "narrow" });
      out += '<div class="mgc' + (i === m ? " now" : "") + '">'
        + '<div class="mgc-b"><div style="height:' + pct.toFixed(1) + '%"></div></div>'
        + '<div class="mgc-l">' + esc(name) + "</div></div>";
    }
    return '<div class="mgrid" role="img" aria-label="months of the year, '
      + (m + 1) + ' of 12 under way">' + out + "</div>";
  }

  function countdownRows(list) {
    if (!list.length) {
      /* An honest empty state, not an empty box, and one that says what the owner would
         SEE rather than how the thing is plumbed. "They are set up when the panel is
         built, the same way as the location" answered a question nobody standing in a
         kitchen is asking; the example is the answer to the one they are. */
      return '<div class="muted">No countdowns yet. A birthday or a trip added here shows '
        + "up as its own line: the name, and how many days until it.</div>";
    }
    return statGrid(list.slice(0, 8).map(function (c) {
      return [c.title, String(Math.abs(c.days)) + '<span class="unit"> days</span>',
              c.label + " · " + weekdayDate(c.date)];
    }), 2);
  }

  var year = {
    name: "year",
    panel: null,

    init: function () {
      this.renderCard();
      /* The number moves once a day; a repaint an hour keeps the midnight rollover
         honest at no cost, and the tile never shows yesterday's percentage. */
      setInterval(this.renderCard.bind(this), 3600 * 1000);
    },

    cfgCountdowns: function () {
      return countdowns(WP.C && WP.C.countdowns, Date.now());
    },

    renderCard: function () {
      var big = $("year-big"), sub = $("year-sub");
      if (!big) return;
      var y = calc(Date.now());
      big.textContent = y.pct + "%";
      /* The sub-line is the one place a date that matters can be seen without a tap, so
         the nearest upcoming countdown takes it; otherwise the year's own remainder. */
      var next = this.cfgCountdowns().filter(function (c) { return c.days >= 0; })[0];
      sub.textContent = next ? next.title + " " + when(next.days)
                             : y.daysLeft + " days left";
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("year");
      if (!panel) return;
      var y = calc(Date.now());
      var cds = this.cfgCountdowns();
      /* Formatted HERE, on open, not in calc(): the app's budget for toLocaleDateString is
         once a day (see polling.test.js), and the tile's hourly repaint must not spend it. */
      var monthName = new Date().toLocaleDateString(undefined, { month: "long" });
      WP.qs("[data-sub]", panel).textContent = y.daysLeft + " days left in " + y.year;
      WP.qs("[data-body]", panel).innerHTML =
        /* The hero and the bar under it are one datum printed twice, so they are one
           colour: --accent is this build's mark for a measured line, and the year bar is
           named in style.css as one of the three things it is for. */
        hero("", '<span class="accent-v">' + y.pct + "%</span>", "of " + y.year + " gone")
        + section("Year · " + y.year,
            bar(y.pct, "accent", "year gone") + statGrid([
              ["Left", String(y.daysLeft) + '<span class="unit"> days</span>'],
              ["Quarter", "Q" + y.quarter, y.quarterPct + "% gone · " + y.quarterDaysLeft + " days left"]
            ], 2))
        /* The month bar is the same measurement one zoom level in, so it takes the same
           accent at half strength rather than a fourth grey: two bars in two greys said
           "one of these is data and one is chrome", which was not true. */
        + section("Month · " + monthName,
            bar(y.monthPct, "accent soft", "month gone") + statGrid([
              ["Left", String(y.monthDaysLeft) + '<span class="unit"> days</span>'],
              ["Ends", shortDate(y.monthEnd), when(y.monthDaysLeft - 1)]
            ], 2))
        + section("Months", monthGrid(new Date()))
        + section("Countdowns", countdownRows(cds));
    }
  };

  year.calc = calc;
  year.countdowns = countdowns;
  year.when = when;
  WP.register(year);
})();
