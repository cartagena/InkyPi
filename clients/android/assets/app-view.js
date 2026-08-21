/* Wall panel dashboard — VIEW LAYER (formatting, home layout, drift).

   Second of the three app files (see app.js). Owns everything about how the dashboard
   LOOKS as opposed to what it knows: the shared formatting helpers, the sparkline, the
   home column's measurement and growth caps, show/hide, and the burn-in drift. Extends
   the WP object app.js created; app-touch.js (gestures, boot) loads after it.
*/

(function () {
  "use strict";

  var C = WP.C, $ = WP.$, qs = WP.qs, qsa = WP.qsa, esc = WP.esc, pad2 = WP.pad2;
  var settings = WP.settings, store = WP.store, bridge = WP.bridge;

  /* Show/hide home cards to match settings.show. Cards keep their DOM and their refresh
     loops — hiding is purely visual, so re-enabling one is instant.
     If the user hides everything the home view would be a black rectangle, which on a wall
     panel is indistinguishable from a crashed app — so an empty state takes over and points
     back at Settings. */
  function applyVisibility() {
    var visible = 0;
    qsa("[data-widget]").forEach(function (node) {
      var w = node.getAttribute("data-widget");
      if (!w || !(w in settings.data.show)) return;
      var on = settings.data.show[w];
      node.style.display = on ? "" : "none";
      if (on) visible++;
    });
    /* A wrapper whose every widget is hidden has to go too. `.row3` is not itself a
       [data-widget] — it is the flex row that holds the Device / Timer / Settings tiles —
       so with all three switched off it stayed in the column as an empty row that still
       carried flex-grow:1, and swallowed every pixel the hidden cards gave back. That, not
       the `margin: auto 0`, is why the all-hidden empty state rendered bottom-anchored with
       ~1700 device px of black above it. */
    qsa("#home > .row3").forEach(function (row) {
      var any = qsa("[data-widget]", row).some(function (n) {
        return n.style.display !== "none";
      });
      row.style.display = any ? "" : "none";
    });
    var empty = $("empty");
    if (empty) empty.hidden = (visible > 0);

    /* A widget switched off while its own panel is open used to leave that panel on the
       screen: the card vanished from the dashboard behind it, the carousel could no
       longer find it (so swipes did nothing), and the only way out was the close button.
       Turning a widget off means its screen goes away too. */
    if (WP.panels) {
      WP.panels.stack.slice().forEach(function (name) {
        if (name in settings.data.show && !settings.data.show[name]) WP.panels.closePanel(name);
      });
    }
    relayoutHome();
  }

  /* ---------------- home column layout ----------------
     Both numbers below need the cards at their *intrinsic* height, and flex-grow hides
     that, so one pass neutralises grow, measures, and puts it back:

       slack     headroom left below the last card. Logged at boot; a downward burn-in
                 nudge eats into it, and overflow has to stay 0 or the bottom tile row is
                 being clipped off a wall panel nobody is standing in front of.
       grow cap  how far a surviving card may stretch when a widget is switched off.

     Uncapped flex-grow handed the hidden widgets' whole height to whatever was left: at
     three hidden the Weather card came out ~800 device px tall with ~250 px of dead black
     above its content and ~250 below, and the HOME card ~900. At 2-4 m that does not read
     as breathing room, it reads as a card that failed to load. Each card may now grow to
     at most GROW_CAP x its own intrinsic height; because every card is capped, the
     remainder is left over once, as a single margin below the last card (#home is
     flex-start). One or two hidden still fills the column exactly as before — the cap only
     binds when there is more space to hand out than the cards can plausibly use.

     The cap is recomputed whenever visibility changes, whenever the weather payload
     changes a card's size, and on a slow heartbeat — a cap measured while the cards were
     still empty would otherwise clip them once the data landed. */
  var GROW_CAP = 1.3;

  function homeMetrics() {
    var hv = $("home");
    if (!hv) return null;
    var kids = qsa("#home > *").filter(function (n) {
      return n.id !== "empty" && n.offsetHeight > 0;
    });
    if (!kids.length) return null;
    /* Neutralising flex-grow is not enough any more, and for five rounds it quietly was
       not: portrait became a WRAPPED row (the two tile rows share one line), and in a
       wrapped container the leftover space is handed to the LINES by align-content, not
       to the items. So the lines stretched to the bottom whatever the items did, the last
       card's bottom sat on the container's edge, and slack measured ~2 px no matter how
       much room the content actually needed. The boot log has been printing "slack=2px"
       as a constant, and anything reading it — the growth cap, and now the drift clamp —
       was reading a number that could not move. Pin align-content for the measurement
       too, and the figure means something again. */
    var priorAlign = hv.style.alignContent;
    hv.style.alignContent = "flex-start";
    kids.forEach(function (n) { n.style.maxHeight = "none"; n.style.flexGrow = "0"; });
    var nat = kids.map(function (n) { return n.offsetHeight; });
    var slack = Math.round(hv.clientHeight
      - (kids[kids.length - 1].getBoundingClientRect().bottom
         - hv.getBoundingClientRect().top));
    kids.forEach(function (n) { n.style.flexGrow = ""; });
    hv.style.alignContent = priorAlign;
    /* Both axes. The vertical one was measured from the first round because the column is
       a height budget; the horizontal one went unchecked for five, and in 24-hour mode the
       hourly strip was clipping an eighth chip through the middle of a glyph at the card's
       right edge — "20:00" rendered as a sheared "2". Anything that leaves the frame
       sideways is as broken as anything that leaves it downwards, and #home never scrolls
       horizontally (the strip has its own scroller), so this must be 0. */
    return { el: hv, kids: kids, nat: nat, slack: slack,
             overflow: hv.scrollHeight - hv.clientHeight,
             overflowX: hv.scrollWidth - hv.clientWidth };
  }

  /* Until the cards have their content, their intrinsic height is not their real one, and a
     cap measured against an empty card would clip it the moment the payload landed. So no
     cap is applied before the first widget signals that it has filled in (weather.publish),
     which is also the first moment the measurement means anything. */
  var layoutReady = false;

  function relayoutHome() {
    if (WP.touching && WP.touching()) return;   // never reflow the column under a finger
    var m = homeMetrics();
    if (!m) return;
    if (!layoutReady) {
      m.kids.forEach(function (n) { n.style.maxHeight = ""; });
      return;
    }
    /* Nothing to hand out (all eight widgets on: ~34 device px) means the cap can only be
       a liability, so drop it and let flex-grow do what it already did correctly. */
    if (m.slack <= 0) {
      m.kids.forEach(function (n) { n.style.maxHeight = ""; });
      return;
    }
    m.kids.forEach(function (n, i) {
      n.style.maxHeight = Math.round(m.nat[i] * GROW_CAP) + "px";
    });
  }

  /* The "there is more this way" fade only belongs on a strip that HAS more this way.
     It was unconditional, so in landscape — where the hourly card is nearly twice as wide
     and all eight chips fit with room to spare — the last column was rendered at reduced
     opacity inside a card that was not scrolling: its hour, its glyph and its temperature
     all dimmed, on the most-looked-at card in the product, reading as a rendering fault.
     A mask cannot ask whether its own content overflows, so the question is answered here,
     where the geometry is already being measured. */
  function markScrollers() {
    qsa(".hstrip").forEach(function (n) {
      n.classList.toggle("scrolls", n.scrollWidth - n.clientWidth > 1);
    });
  }

  /* ---------------- panel fit ----------------
     The home column has been measured since the first round. The twelve PANELS were not,
     and a round that restated the landscape type ramp at 1.45x shipped an hourly screen
     whose bottom temperature was sliced by the bezel — ink to device row 1592 of 1600.

     The obvious probe does not catch it, and that is worth writing down so nobody rebuilds
     it: `body.scrollHeight - body.clientHeight` was 0 on that exact frame, in both
     orientations, on all twelve panels. A flex row sized to `1 1 0` gets a box shorter
     than its own line box, the figure paints out of the row, and the ink lands in the
     scrollport's PADDING — which scrollHeight counts as part of the box. The panel is not
     scrolling. It is spilling.

     So the property is the one a reader actually sees. The body's padding is the only
     thing between the last row and the edge of the glass, so nothing a panel draws may
     enter it: every painted box in the panel is measured against the body's content edge
     downward and against its padding edge sideways (the pinned .stick block cancels the
     side padding deliberately, and lands exactly ON that edge). Both numbers must be 0 in
     both orientations — panels.open() reports them, so the check runs on the wall, in the
     orientation the wall is actually in, on every screen a person opens. */
  function panelMetrics(name) {
    var el = qs('[data-panel="' + name + '"]');
    var body = el && qs("[data-body]", el);
    if (!body) return null;
    var box = body.getBoundingClientRect();
    var pad = 0;
    if (typeof window.getComputedStyle === "function") {
      pad = parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
    }
    var floorY = box.bottom - pad;
    var over = 0, overX = 0;
    qsa("*", body).forEach(function (n) {
      var r = n.getBoundingClientRect();
      if (!r.width && !r.height) return;          // nothing painted: no opinion
      if (r.bottom - floorY > over) over = r.bottom - floorY;
      if (r.right - box.right > overX) overX = r.right - box.right;
      if (box.left - r.left > overX) overX = box.left - r.left;
    });
    return {
      name: name,
      orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
      overflow: Math.max(0, Math.round(over)),
      overflowX: Math.max(0, Math.round(overX))
    };
  }

  /* Deduped on name + orientation + result, because the carousel opens twelve screens
     every thirty seconds for ever: a clean measurement is worth logging once — it is the
     evidence the wall is fitting — and worth logging twelve times a minute never. */
  var fitSeen = {};

  function reportPanelFit(name) {
    setTimeout(function () {        // after the 200ms open transition has settled
      var m = panelMetrics(name);
      if (!m) return;
      var line = "[inky] layout: panel " + m.name + " " + m.orientation
        + " overflow=" + m.overflow + " overflowX=" + m.overflowX;
      if (fitSeen[line]) return;
      fitSeen[line] = true;
      if (m.overflow > 0) console.warn(line + " — OVERFLOW, the last row is into the frame");
      else if (m.overflowX > 0) console.warn(line + " — OVERFLOW, content runs off the side");
      else console.log(line);
    }, 300);
  }

  /* ---------------- burn-in drift ----------------
     This panel is AMOLED: a dashboard that never moves ghosts permanently, and on a wall
     panel "never moves" is the normal case — nobody is watching it at 3am.

     Every layer that can be on screen for hours drifts together on the same slow cycle:
     the home wrapper, the full-screen panel layer, and the countdown alarm overlay. The
     panel layer used to be excluded *and* drift was paused outright while a panel was
     open, so a detail panel left up overnight was ~8 hours of perfectly static pixels
     with protection silently disabled. Moving every layer by the identical offset keeps
     them registered with each other, so there is no visible seam.

     The reason drift used to pause — never move a control out from under a finger — is
     handled instead by skipping any nudge while a pointer is down. The shift is at most
     12 CSS px eased over 4 s, against touch targets of 88+ device px. */
  var DRIFT_LAYERS = ["drift", "panels", "alarm"];

  var drift = {
    timer: null,
    paused: false,

    start: function () {
      drift.stop();
      if (!settings.get("burnIn")) { drift.reset(); return; }
      var b = C.burnInProtection || {};
      var every = (b.intervalSeconds || 120) * 1000;
      drift.nudge();
      drift.timer = setInterval(drift.nudge, every);
    },

    stop: function () { if (drift.timer) { clearInterval(drift.timer); drift.timer = null; } },

    apply: function (css) {
      DRIFT_LAYERS.forEach(function (id) {
        var el = $(id);
        if (el) el.style.transform = css;
      });
    },

    nudge: function () {
      /* A finger is down: skip this cycle rather than sliding the target. The next one is
         120 s away, which is nothing against the hours that cause ghosting. */
      if (drift.paused || (WP.touching && WP.touching()) || !settings.get("burnIn")) return;
      var b = C.burnInProtection || {};
      var max = b.maxShiftPx || 12;
      var x = (Math.random() * 2 - 1) * max;
      var y = (Math.random() * 2 - 1) * drift.downRoom(max);
      drift.apply("translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)");
    },

    /* How far the layout may travel DOWNWARD before the bottom card leaves the screen.

       This is a real defect the simulator caught, not a theoretical one: the home column
       converges on ~2 px of slack with every widget switched on (the boot log prints it),
       and a nudge is up to 12 px. So for the eight minutes an hour that the random walk
       happened to land downward, the bottom of the news ticker was simply off the bottom
       of the wall panel — measured at 40 px clipped at full deflection. Burn-in protection
       that clips content is a worse defect than the ghosting it prevents.

       The vertical range is therefore whatever the column actually has spare, and the
       horizontal range is untouched (the column has side padding to give). A negative
       slack (already overflowing) yields 0: hold still and let the layout log complain,
       rather than making it worse. */
    downRoom: function (max) {
      var m = WP._layout && WP._layout.metrics && WP._layout.metrics();
      if (!m || typeof m.slack !== "number") return max;
      return Math.max(0, Math.min(max, m.slack));
    },

    reset: function () { drift.apply("translate(0,0)"); },

    /* Kept for callers that genuinely need stillness (nothing does today — opening a panel
       no longer pauses drift, which was the bug). */
    pause: function () { drift.paused = true; },
    resume: function () { drift.paused = false; }
  };

  /* ---------------- shared formatting ---------------- */
  var fmt = {
    deg: function (n) { return (n == null || isNaN(n)) ? "--°" : Math.round(n) + "°"; },
    deg1: function (n) { return (n == null || isNaN(n)) ? "--" : (Math.round(n * 10) / 10) + "°"; },

    /* Open-Meteo is asked for mph/inch or km/h/mm to match the unit setting, so speed and
       precipitation just need a label. Pressure always arrives in hPa. */
    speedUnit: function () { return settings.isMetric() ? "km/h" : "mph"; },
    precipUnit: function () { return settings.isMetric() ? "mm" : "in"; },
    pressure: function (hPa) {
      if (hPa == null) return "--";
      return settings.isMetric()
        ? Math.round(hPa) + " hPa"
        : (Math.round(hPa * 0.02953 * 100) / 100) + " inHg";
    },
    distance: function (metres) {
      if (metres == null) return "--";
      return settings.isMetric()
        ? (Math.round(metres / 100) / 10) + " km"
        : (Math.round(metres / 160.934) / 10) + " mi";
    },
    compass: function (deg) {
      if (deg == null) return "--";
      var pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                 "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
      return pts[Math.round(deg / 22.5) % 16];
    },
    /* UV bands are the WHO ones; the label is what actually matters at a glance.
       `tone` puts the figure on the app's one severity ramp — the same six steps AQI and
       the pollutants use. It was missing, so the wall printed UV MAX 8.3 "Very high" in
       plain white next to an amber 70 / Moderate: the only value wearing a warning colour
       was the only harmless one. */
    uv: function (v) {
      if (v == null) return { n: "--", label: "", tone: "band-na" };
      var n = Math.round(v * 10) / 10;
      var i = v < 3 ? 1 : v < 6 ? 2 : v < 8 ? 3 : v < 11 ? 4 : 5;
      var label = ["Low", "Moderate", "High", "Very high", "Extreme"][i - 1];
      return { n: n, label: label, tone: "band-" + i };
    },
    clock: function (d, withSeconds) {
      var h = d.getHours(), m = d.getMinutes(), suffix = "";
      if (settings.get("clockHours") === 12) {
        suffix = h >= 12 ? " PM" : " AM";
        h = h % 12; if (h === 0) h = 12;
      } else {
        h = pad2(h);
      }
      return h + ":" + pad2(m) + (withSeconds ? ":" + pad2(d.getSeconds()) : "") + suffix;
    },
    /* ONE casing for one datum. The meridiem letter came out of here lowercase, and two
       of the three places that print an hour sit inside the small-caps label recipe, which
       upper-cases whatever it is given — so the same hour was "9P" on the home strip, "9p"
       in the hourly list and "12A" on the daily axis, on three screens one swipe apart.
       Upper is the one that survives being inside the recipe, and it is the more legible of
       the two at 3 m: "9P" has no descender to lose. */
    /* 1st / 2nd / 3rd / 4th — for naming a day of the month in a sentence ("page of
       the 3rd"). English's teens are the whole trick: 11th, 12th, 13th. */
    ordinal: function (n) {
      var t = n % 10, h = n % 100;
      var suf = (t === 1 && h !== 11) ? "st" : (t === 2 && h !== 12) ? "nd"
        : (t === 3 && h !== 13) ? "rd" : "th";
      return n + suf;
    },

    hourLabel: function (d) {
      if (settings.get("clockHours") === 24) return pad2(d.getHours()) + ":00";
      var h = d.getHours() % 12; if (h === 0) h = 12;
      return h + (d.getHours() >= 12 ? "P" : "A");
    },
    bytes: function (b) {
      if (b == null || isNaN(b)) return "--";
      var u = ["B", "KB", "MB", "GB", "TB"], i = 0, n = Number(b);
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + " " + u[i];
    },
    duration: function (ms) {
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400); s -= d * 86400;
      var h = Math.floor(s / 3600);  s -= h * 3600;
      var m = Math.floor(s / 60);    s -= m * 60;
      if (d) return d + "d " + h + "h " + m + "m";
      if (h) return h + "h " + m + "m";
      return m + "m " + s + "s";
    },
    /* Single largest unit only — for the narrow tiles where the long form ellipsises. */
    durationShort: function (ms) {
      var s = Math.floor(ms / 1000);
      if (s >= 86400) return Math.floor(s / 86400) + "d";
      if (s >= 3600) return Math.floor(s / 3600) + "h";
      if (s >= 60) return Math.floor(s / 60) + "m";
      return s + "s";
    },
    /* mm:ss.t / h:mm:ss.t — elapsed time, truncated (a stopwatch reading 00:05 means five
       whole seconds have passed). */
    stopwatch: function (ms, tenths) {
      if (ms < 0) ms = 0;
      var t = Math.floor(ms / 100) % 10;
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600); s -= h * 3600;
      var m = Math.floor(s / 60);   s -= m * 60;
      var core = (h ? h + ":" + pad2(m) : pad2(m)) + ":" + pad2(s);
      return tenths ? core + "." + t : core;
    },
    /* Time *remaining* rounds the other way. Truncating made a 1-minute countdown show
       60 -> 58 within a blink and then sit on 00:00 for a whole second before the alarm;
       ceiling gives the 01:00 -> 00:59 -> ... -> 00:01 -> alarm that a countdown owes you.
       The quantisation is done in ms so the shared formatter still does the layout. */
    countdown: function (ms) {
      return fmt.stopwatch(Math.ceil(Math.max(0, ms) / 1000) * 1000, false);
    },
    /* The exact ms the stopwatch display is showing. Lap splits are derived from this, not
       from raw elapsed times: truncating both columns independently let consecutive totals
       differ by 0.5 s while the split between them insisted it was 0.4 s. */
    swQuantise: function (ms) { return Math.floor(Math.max(0, ms) / 100) * 100; },
    ago: function (ms) {
      var s = Math.round((Date.now() - ms) / 1000);
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.round(s / 60) + "m ago";
      return Math.round(s / 3600) + "h ago";
    },

    /* Calendar arithmetic for the clock panel. It lives here, beside the other formatters,
       rather than inline in the panel's render closure, because it is exactly the kind of
       thing that goes quietly wrong: measuring from "now" to Jan 0 spans the spring-forward
       hour, so the difference came to 228 d 23 h and floored to 228 on day 229 — wrong every
       day between DST start and DST end. Comparing midnight to midnight and rounding is what
       makes it DST-safe, and being a named function is what makes it checkable. */
    dayOfYear: function (d) {
      var soy = new Date(d.getFullYear(), 0, 1);
      var today0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return Math.round((today0 - soy) / 86400000) + 1;
    },
    /* Only ever used to give dayOfYear a denominator — "161 of 365" is a fact, "161" on
       its own is a number nobody can place. Same calendar-not-clock arithmetic as above:
       counted in whole days, never in milliseconds, so a DST boundary cannot move it. */
    daysInYear: function (d) {
      var y = d.getFullYear();
      return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 366 : 365;
    },
    /* ISO-8601 week: Thursday of this week decides which year's week 1 we are counting from. */
    isoWeek: function (d) {
      var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
      var week1 = new Date(t.getFullYear(), 0, 4);
      return 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    }
  };

  /* ---------------- sparkline ----------------
     A dependency-free SVG polyline. Used by the HA history view and the device panel;
     returns markup rather than a node so callers can drop it into a template string.
     opts.min / opts.max pin the vertical domain — on/off series want a fixed 0..1 scale
     so a switch that has not moved still reads as "held high", not as noise. */
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.w || 100, h = opts.h || 30;
    var vals = (values || []).filter(function (v) { return typeof v === "number" && !isNaN(v); });
    if (vals.length < 2) return '<div class="spark-empty">collecting&hellip;</div>';

    var min = (opts.min != null) ? opts.min : Math.min.apply(null, vals);
    var max = (opts.max != null) ? opts.max : Math.max.apply(null, vals);
    /* A perfectly flat series has no range to scale against. Spread the domain around
       the value so the line lands mid-box instead of pinned to the bottom edge. */
    if (max - min < 1e-6) { var mid = min; min = mid - 1; max = mid + 1; }
    var pad = (opts.min != null && opts.max != null) ? 0 : (max - min) * 0.12;
    min -= pad; max += pad;

    var pts = vals.map(function (v, i) {
      var x = (i / (vals.length - 1)) * w;
      var y = h - ((v - min) / (max - min)) * h;
      return (Math.round(x * 10) / 10) + "," + (Math.round(y * 10) / 10);
    });
    /* A LINE, and nothing under it. The filled area was here to make the trace readable
       from across a room, and it did that by lighting a large translucent slab of an OLED
       panel permanently — on a screen whose stated rule is that lit pixels are data, to
       carry information the line already carries. The stroke does the job instead: it is
       non-scaling, so 3 CSS px is 3 CSS px whatever the viewBox is stretched to, and a
       bright 3 px line on true black is legible at 3 m where a 1.4 px one was not. */
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">'
      + '<polyline class="spark-line" points="' + pts.join(" ") + '"></polyline>'
      + "</svg>";
  }

  WP.fmt = fmt;
  WP.sparkline = sparkline;
  WP.drift = drift;
  WP.applyVisibility = applyVisibility;
  /* A widget calling this is telling us its content has landed, which is exactly the
     condition the growth cap needs before it may bind. */
  WP.relayoutHome = function () { layoutReady = true; relayoutHome(); markScrollers(); };
  /* boot (app-touch.js) logs the measured budget and re-measures on settings changes;
     panel() is the same question asked of one of the twelve screens, and app-touch.js
     asks it every time one is opened. */
  WP._layout = { metrics: homeMetrics, relayout: relayoutHome,
                 panel: panelMetrics, reportPanel: reportPanelFit };
})();
