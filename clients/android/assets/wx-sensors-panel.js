/* Wall panel dashboard — HOME ASSISTANT DETAIL PANEL.

   The full-screen panel for the sensors widget: the entity picker, the reading hero,
   the two-hour trace and the per-entity stats. Split from wx-sensors.js purely for the
   500-line file budget — it attaches paintPanel onto the widget wx-sensors.js registered
   (this file loads after it), and everything renders through the same WP.ui builders.

   One file, one job (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero, btn = ui.btn,
      bar = ui.bar, switchRow = ui.switchRow, plot = ui.plot;

  var sensors = WP.registry.sensors;

  /* ---------------- the y-domain floor ----------------
     THE defect this panel had: the trace autoscaled to whatever it happened to contain, so
     a living room that drifted from 74.5 °F to 75.5 °F over two hours was drawn as a range
     of mountains filling a ~500 px plot. The stats underneath said 74.5 / 75.5 and nobody
     reads stats to correct a picture. From 3 m that screen shouted "something is happening
     in your house" every single day, for ever, about one degree — and it is the only screen
     that reports on the reader's own home, so it is the one that has to be trustworthy.

     The fix is the same one every real thermostat app uses: a MINIMUM SPAN per unit, below
     which the line simply goes flat because nothing happened. The numbers are the smallest
     change of each quantity a person would actually notice in a room:

       °F    4 degrees      you feel a 4 °F change; you do not feel 1
       °C    2 degrees      the same interval in the other scale
       %     10 points      relative humidity, battery, anything on a 0-100 scale
       ppm   200            CO2: 600 vs 800 is a real difference, 610 vs 620 is drift
       W     50             a light bulb

     Unknown units fall back to a tenth of the reading's own magnitude, which is scale-free
     and always beats "the range of the last two hours". */
  var MIN_SPAN = { "°F": 4, "°C": 2, "%": 10, ppm: 200, ppb: 200, W: 50, kW: 0.5, V: 1 };

  function domain(vals, unit) {
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var mid = (lo + hi) / 2;
    var floor = MIN_SPAN[unit];
    if (floor == null) floor = Math.max(Math.abs(mid) * 0.1, 1e-6);
    if (hi - lo >= floor) {
      /* a real swing: keep it, with a little headroom so the peak is not on the frame */
      var pad = (hi - lo) * 0.12;
      return { min: lo - pad, max: hi + pad, flat: false, floor: floor };
    }
    return { min: mid - floor / 2, max: mid + floor / 2, flat: true, floor: floor };
  }

  /* ---------------- drawing a flat series flat ----------------
     The panel says "Steady" at the value tier and then drew a line climbing a visible step
     with visible high-frequency jitter, so the screen argued with its own headline — and
     between a sentence and a picture, the picture is the half people believe. Two things
     were doing it, and both are handled here rather than in the stylesheet, because both
     are about the DATA rather than about the box it is drawn in.

     Jitter: a room sensor reporting to 0.1 °F produces sample-to-sample noise far below the
     4 °F a person can feel, and drawing every sample turns that noise into shape. When the
     series is inside the domain floor the trace is decimated to ~24 points — one per five
     minutes of a two-hour window — which is the resolution at which the drawing says what
     the sentence says: nothing happened.

     (The plot's HEIGHT comes down at the same time; that half is `.plot.is-flat` in
     style-widgets.css, since it is a property of the box.) */
  var FLAT_POINTS = 24;

  function decimate(vals, n) {
    if (vals.length <= n) return vals;
    /* Average within each bucket rather than sampling one point from it: picking one sample
       keeps whichever noise spike it lands on and simply redraws the jitter with fewer
       vertices. The mean is the value the sentence above the chart is describing. */
    var out = [], per = vals.length / n;
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * per), b = Math.max(a + 1, Math.floor((i + 1) * per));
      var sum = 0, cnt = 0;
      for (var j = a; j < b && j < vals.length; j++) {
        if (typeof vals[j] === "number") { sum += vals[j]; cnt++; }
      }
      out.push(cnt ? sum / cnt : vals[Math.min(a, vals.length - 1)]);
    }
    return out;
  }

  /* The trace's own axis — see WP.ui.plot for why the labels are HTML over the SVG.
     These two figures are the top and bottom of the Y-DOMAIN, which after the floor above
     is not the same thing as the top and bottom of the data, and the panel used to print
     both: plot corners 76.4 / 72.4 °F sixty pixels above LOWEST 73.9 / HIGHEST 74.9 °F,
     each pair labelled °F and neither labelled as which. One screen, one series, two
     different ranges, and the pair drawn on the chart was the one that is not the data.
     The corners are the scale, so the stat row below is no longer allowed to be a second
     one — it says mean, spread and net movement instead (see the grid at the end). */
  function axis(dom, unit, dp, binary) {
    return function (v) {
      return binary ? (v > 0.5 ? "On" : "Off") : Number(v).toFixed(dp || 0) + " " + unit;
    };
  }

  sensors.paintPanel = function () {
      var panel = this.panel || WP.panels.el("sensors");
      if (!panel || !WP.panels.isOpen("sensors") || WP.touching()) return;
      var body = WP.qs("[data-body]", panel);
      var e = this.find(this.sel) || this.ents[0];
      if (!e) { body.innerHTML = '<div class="muted">No entities.</div>'; return; }

      WP.qs("[data-sub]", panel).textContent = this.panelSub(e);

      /* cols3: nine entities on a wrapping row broke 4 + 4 + 1, leaving one chip alone
         under a row of four. Three rows of three. */
      var chips = '<div class="chip-row cols3" role="radiogroup" aria-label="Reading">'
        + this.ents.map(function (x) {
          var on = x.id === e.id;
          return '<button class="chip tappable' + (on ? " on" : "") + '"'
            + ' role="radio" aria-checked="' + (on ? "true" : "false") + '"'
            + ' data-ns="sensors" data-act="pick" data-arg="' + esc(x.id) + '">'
            + '<span aria-hidden="true">' + sensors.glyph(x) + "</span> "
            + esc(x.label) + "</button>";
        }).join("") + "</div>";
      /* scroll position is preserved: this panel repaints on every tick as values move */

      var vals = e.hist.map(function (p) { return sensors.out(e, p.v); });
      var last = vals.length ? vals[vals.length - 1] : null;
      var first = vals.length ? vals[0] : null;
      var unit = sensors.outUnit(e);
      var nums = vals.filter(function (v) { return typeof v === "number"; });
      var min = nums.length ? Math.min.apply(null, nums) : null;
      var max = nums.length ? Math.max.apply(null, nums) : null;
      var avg = nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null;
      var r = function (v) { return v == null ? "--" : Number(v).toFixed(e.dp || 0); };

      /* on/off entities get a fixed 0..1 domain (with headroom) so the trace reads as a
         square wave, and duty-cycle stats instead of a meaningless min/max/mean */
      var binary = (e.kind === "toggle" || e.kind === "binary");
      var dom = binary ? { min: -0.15, max: 1.15, flat: false }
                       : domain(nums.length ? nums : [0], unit);
      var spark = { w: 300, h: 70, min: dom.min, max: dom.max };
      var duty = binary ? this.duty(e.hist) : null;
      var changed = binary ? this.lastChange(e.hist) : null;

      var control = "";
      if (e.kind === "toggle") {
        control = '<div class="btn-row">'
          + btn("toggle", e.on ? "Turn off" : "Turn on", "", e.id, "sensors")
          + "</div>";
      }

      /* The warm-bordered block is an ALERT, and only an alert: this feed is real and it
         has stopped answering. It used to carry a permanent demo notice as well, which
         both trained the eye to ignore the colour and argued with the subtitle (see
         panelSub). In demo mode there is now nothing here. */
      var note = "";
      if (e.err) {
        note = '<div class="demo-note">' + esc(this.entityNote(e))
          + (e.okAt ? ". It last answered " + esc(fmt.ago(e.okAt)) : "") + ".</div>";
      }

      var ed = axis(dom, unit, e.dp, binary);
      var freshAt = e.hist.length ? e.hist[e.hist.length - 1].t : 0;

      /* The panel, not the plot, carries the flat state — because capping the trace is only
         half of it. Left to itself the height the trace gives up pools as one 455 device px
         band of black between the line and the axis label under it, which is the exact
         defect the shorter chart was supposed to fix, moved down the screen. Marked here,
         the body distributes that height through its blocks instead. */
      panel.classList.toggle("flat", !!(dom.flat && !binary));

      WP.repaint(body, chips + note
        /* The line under the number used to be "Living room · sensor.living_room_temperature"
           — the entity id, printed on a wall, and printed a second time in an ENTITY grid
           below it where `overflow-wrap: anywhere` snapped it mid-word as
           "sensor.living_room_te / mperature". An id is how the app finds the reading, not
           anything the reader can use. It says how fresh the number is instead. */
        + hero(this.glyph(e),
               esc(this.display(e)) + ' <span class="dim">' + esc(unit) + "</span>",
               esc(e.label)
                 + (freshAt ? " · updated " + esc(fmt.clock(new Date(freshAt), false)) : ""),
               this.isOffish(e) ? "dim" : "")
        + control
        /* "Samples 241" went with the ENTITY grid: it is the length of an internal array,
           and it moves when the poll interval is reconfigured without anything in the room
           having changed. Min / max / mean is the whole of what two hours of a number has
           to say. */
        /* When the drift is under the floor the chart is a flat line, and a flat line
           drawn 250 px wide is still a chart implying an event. The VERDICT goes first, in
           words, at the value tier — which is the tier somebody 3 m away can actually read
           — and the trace behind it becomes the evidence rather than the claim. */
        + section("Last 2 hours",
            /* NO readings is not the same fact as readings that did not move, and the
               panel used to print "Steady — less than 4 °F either way in two hours" over
               an empty chart while every stat beside it read "--". Found by pointing the
               simulator at a Home Assistant that refuses the token: the one screen whose
               job is to tell you whether these numbers are true was, in that state, making
               a confident claim about numbers it did not have. */
            (nums.length < 2
              ? '<div class="stat-v dim">No readings yet</div><div class="stat-x">'
                + (e.err ? "Nothing has arrived since the feed stopped answering."
                         : "The first readings arrive within a few minutes.") + "</div>"
              : dom.flat && !binary
              ? '<div class="stat-v">Steady</div><div class="stat-x">less than '
                + dom.floor + " " + esc(unit) + " either way in two hours</div>"
              : "")
            + (nums.length < 2 ? ""       /* an empty frame labelled 2.0 / -2.0 with
                   "collecting…" printed across both is three pieces of text arguing over
                   the same 40 px; nothing is the honest drawing of nothing */
                : plot(WP.sparkline(dom.flat && !binary ? decimate(vals, FLAT_POINTS) : vals,
                                spark),
                   ed(dom.max), ed(dom.min), "2h ago", "now",
                   dom.flat && !binary ? "is-flat" : ""))
            + (binary
                ? statGrid([["State now", esc(this.display(e))],
                    ["On", duty == null ? "--" : Math.round(duty * 100) + "% of window"],
                    ["Off", duty == null ? "--" : Math.round((1 - duty) * 100) + "% of window"],
                    ["Last change", changed ? esc(fmt.ago(changed)) : "over 2 h ago"]])
                /* Mean, spread, net movement — three facts, none of which is a y-value the
                   axis above already states. It was Lowest / Highest / Average, i.e. a
                   second pair of bounds for a series whose bounds are printed in the
                   corners of the chart directly above them, in the same unit, disagreeing
                   with them by the width of the domain floor. */
                /* `max - min` of an empty series is NaN -> "--", but of a SINGLE reading
                   it is a confident 0.0 sitting between two cells that admit they have
                   nothing. One sample is not a measured range of zero. */
                : statGrid([["Average", r(avg) + " " + esc(unit)],
                    ["Range", (nums.length > 1 ? r(max - min) : "--") + " " + esc(unit)],
                    ["Change", (last != null && first != null && last - first >= 0 ? "+" : "")
                      + r(last == null || first == null ? null : last - first)
                      + " " + esc(unit)]], 3))));
    }
})();
