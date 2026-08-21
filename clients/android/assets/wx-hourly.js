/* Wall panel dashboard — HOURLY FORECAST.

   Home card is a horizontally scrollable 24-hour strip; every hour is tappable and opens
   the panel focused on that hour.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, tempTone = ui.tempTone;

  /* The forecast is fetched once and shared: this widget, the "now" card and the daily card
     all read the same payload rather than each hitting Open-Meteo. wx-weather.js is loaded
     before this file (index.html pins that order, and a test asserts it), so the plugin is
     already in the registry by the time this IIFE runs. */
  var weather = WP.registry.weather;

  var hourly = {
    name: "hourly",
    sel: 0,
    lastStripTouch: 0,
    lastNow: -1,
    REANCHOR_MS: 45000,

    init: function () {
      var self = this;
      weather.onData(function () { self.render(); });

      /* The strip was wired to the weather fetch and to nothing else, so both of the things
         that make its labels wrong went uncorrected for up to 15 minutes: a 12/24h flip
         (the status line followed immediately while the chips still read 15:00 16:00 …) and
         the hour rolling over (the chip badged NOW kept pointing at the previous hour, with
         that hour's temperature). Neither needs new data — the payload already covers 24 h
         — only a redraw, so it is driven off the setting and off a cheap tick that watches
         which hour we are inside. Skipped while a finger is down: rebuilding the strip
         mid-press moves the chip out from under the tap. */
      S.onChange(function (k) {
        if (k === "clockHours" || k === "units" || k === "*") self.render();
      });
      setInterval(function () {
        if (WP.touching()) return;
        if (weather.nowIndex() !== self.lastNow) self.render();
      }, 15000);

      WP.onAction("hourly", function (act, arg) {
        if (act === "pick") { self.sel = parseInt(arg, 10); self.paintPanel(); }
      });

      /* The strip is index 0 = now, so "scrolled to the end" means the panel is showing a
         window that has nothing to do with the present. Left alone it stayed there
         forever — a wall panel someone swiped past on Tuesday still showed 5P-11P on
         Thursday. Snap back to NOW once nobody has touched it for a while. */
      var box = $("hourly");
      if (box) {
        box.addEventListener("scroll", function () { self.lastStripTouch = Date.now(); }, false);
        setInterval(function () {
          if (!box.scrollLeft || WP.touching()) return;
          if (Date.now() - self.lastStripTouch < self.REANCHOR_MS) return;
          self.lastStripTouch = Date.now();      // don't fight the smooth scroll we start
          try { box.scrollTo({ left: 0, behavior: "smooth" }); }
          catch (e) { box.scrollLeft = 0; }
        }, 5000);
      }
    },

    /* the 24 indices starting at the current hour */
    window24: function () {
      var d = weather.data;
      if (!d || !d.hourly) return [];
      var start = Math.max(0, weather.nowIndex());
      var out = [];
      for (var i = start; i < Math.min(start + 24, d.hourly.time.length); i++) out.push(i);
      return out;
    },

    render: function () {
      var box = $("hourly");
      if (!box) return;
      var d = weather.data;
      if (!d || !d.hourly) { box.innerHTML = '<div class="muted">waiting for forecast…</div>'; return; }

      var h = d.hourly, now = weather.nowIndex();
      this.lastNow = now;                 // what the hour tick above compares against
      /* The rain column is suppressed when every hour in view reads 0%. It was seven
         identical zeros under the strip and seven more down the panel, and in El Cajon
         that column is zeros for months at a time: a column that says the same thing in
         every row is not data, it is texture. When any hour has a chance, the whole column
         comes back so the figures can be compared against each other. */
      var wet = this.anyRain(this.window24());
      box.innerHTML = this.window24().map(function (i) {
        var t = new Date(h.time[i]);
        var info = WP.wmo(h.weather_code[i], h.is_day && h.is_day[i] === 0);
        var pop = h.precipitation_probability ? Math.round(h.precipitation_probability[i]) : 0;
        var when = i === now ? "Now" : fmt.hourLabel(t);
        /* The chip is four stacked fragments — "3P", a glyph, "90°", "0%" — which a screen
           reader would read as four unrelated strings with a symbol in the middle. One
           spoken sentence instead, and the glyph is hidden because info.text already says
           what it means. */
        return '<button class="hr tappable' + (i === now ? " now" : "") + '"'
          + ' data-open="hourly" data-arg="' + i + '"'
          + ' aria-label="' + esc(when + ", " + info.text + ", "
              + fmt.deg(h.temperature_2m[i]) + ", " + pop + "% chance of rain") + '">'
          + '<div class="hr-t">' + esc(when) + "</div>"
          + '<div class="hr-i" aria-hidden="true">' + WP.wxIcon(h.weather_code[i], h.is_day && h.is_day[i] === 0) + "</div>"
          + '<div class="hr-d">' + fmt.deg(h.temperature_2m[i]) + "</div>"
          + (wet ? '<div class="hr-p' + (pop >= 30 ? " wet" : "") + '">' + pop + "%</div>" : "")
          + "</button>";
      }).join("");
    },

    /* Is there anything to say about rain across these indices? Used to decide whether the
       precipitation column is drawn at all — see the note in render(). */
    anyRain: function (list) {
      var h = weather.data && weather.data.hourly;
      if (!h || !h.precipitation_probability) return false;
      return list.some(function (k) {
        return Math.round(h.precipitation_probability[k] || 0) > 0;
      });
    },

    onOpen: function (panel, arg) {
      this.panel = panel;
      var n = parseInt(arg, 10);
      this.sel = isNaN(n) ? Math.max(0, weather.nowIndex()) : n;
      this.paintPanel();
    },
    onClose: function () { this.panel = null; },


    /* The InkyPi-style overview: one SVG, temperature as a line whose colour follows its
       height (a vertical gradient in user space — peaks literally read warm, valleys
       cool), rain probability as blue bars on the baseline. Decorative by contract
       (aria-hidden): every number in it is also in the pickable list below, which is the
       accessible surface.

       The hour ticks and the hi/lo callouts are HTML positioned over the chart, not SVG
       <text>: text in a scaling viewBox would need its own font-size, and the design
       system's one hard rule is that no size is authored outside the ramp. */
    /* Every FOURTH hour, so six labels across the axis rather than eight. The annotation
       tier moved to the acuity floor (28.5 CSS px), and that bill has to be paid in ticks:
       eight labels leave 83 px of pitch for a 52 px word, six leave 111. A chart is the one
       place where "it did not fit" is not an argument for shrinking the type — if the
       annotation will not fit, the chart has too many ticks, and that is the chart's
       problem. Six across a day still lands on 12A / 4A / 8A / 12P / 4P / 8P. */
    TICK_EVERY: 4,

    chart: function (h, list, sel) {
      var TICK_EVERY = this.TICK_EVERY;
      var W = 320, H = 104;
      var L = 8, R = 312, T = 14, B = 68;         // temp plot area
      var barBase = 100, barMax = 24;             // precip bars
      var temps = list.map(function (k) { return h.temperature_2m[k]; });
      var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
      var span = (hi - lo) || 1;
      var step = (R - L) / (list.length - 1);

      function xy(n) {
        var x = L + n * step;
        var y = B - ((temps[n] - lo) / span) * (B - T);
        return [x, y];
      }
      function pctX(x) { return (x / W * 100).toFixed(2) + "%"; }
      function pctY(y) { return (y / H * 100).toFixed(2) + "%"; }

      var pts = list.map(function (_, n) { return xy(n); });
      var line = pts.map(function (p2, n) {
        return (n ? "L " : "M ") + p2[0].toFixed(1) + " " + p2[1].toFixed(1);
      }).join(" ");
      var area = line + " L " + R + " " + (B + 2) + " L " + L + " " + (B + 2) + " Z";

      var bars = "", ticks = "", marks = "";
      var bw = step * 0.5;
      var now = weather.nowIndex();
      list.forEach(function (k, n) {
        var pop = h.precipitation_probability ? (h.precipitation_probability[k] || 0) : 0;
        if (pop > 0) {
          var bh = (pop / 100) * barMax;
          bars += '<rect x="' + (L + n * step - bw / 2).toFixed(1) + '" y="' + (barBase - bh).toFixed(1)
            + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="1"/>';
        }
        if (n % TICK_EVERY === 0) {
          var tt = new Date(h.time[k]);
          ticks += '<span style="left:' + pctX(L + n * step) + '">'
            + esc(k === now ? "Now" : fmt.hourLabel(tt)) + "</span>";
        }
      });

      /* Hairline on the selected hour so the chart and the list agree on focus. The dot on
         the curve is HTML (see dot below), for the same reason the ticks are: the plot is
         stretched to a declared box now rather than scaling with its own aspect ratio, so
         anything drawn round inside the viewBox would come out as an ellipse — badly so in
         landscape, where the box is more than twice as wide for its height. */
      var si = list.indexOf(sel), dot = "";
      if (si >= 0) {
        var sp = pts[si];
        marks = '<line x1="' + sp[0].toFixed(1) + '" y1="' + T + '" x2="' + sp[0].toFixed(1)
          + '" y2="' + barBase + '" stroke="var(--card-line2)" stroke-width="1"'
          + ' vector-effect="non-scaling-stroke"/>';
        dot = '<span class="hc-dot" style="left:' + pctX(sp[0]) + ";top:" + pctY(sp[1]) + '"></span>';
      }

      /* hi / lo callouts pinned to the curve's own extremes, not an axis */
      var hiN = temps.indexOf(hi), loN = temps.indexOf(lo);
      var labels = '<span class="hc-hi" style="left:' + pctX(pts[hiN][0])
        + ";top:" + pctY(pts[hiN][1] - 5) + '">' + Math.round(hi) + "&#176;</span>"
        + '<span class="hc-lo" style="left:' + pctX(pts[loN][0])
        + ";top:" + pctY(pts[loN][1] + 5) + '">' + Math.round(lo) + "&#176;</span>";

      /* preserveAspectRatio="none": the plot's HEIGHT is declared in the stylesheet (.hchart)
         and its width is the panel's. Left to scale with its own aspect ratio it took its
         height from whatever width it happened to have — 250 CSS px in portrait and 357 in
         a 711 px-tall landscape viewport, i.e. half the screen, which is what pushed the
         hero and the stat row off the top in landscape and left the curve running out of
         the plot. Stretching means the strokes need vector-effect, or the line would be
         2.25x thicker across than down on the same screen. */
      return '<div class="hchart-wrap" aria-hidden="true"><svg class="hchart" viewBox="0 0 '
        + W + " " + H + '" preserveAspectRatio="none">'
        + '<defs><linearGradient id="hc-t" x1="0" y1="' + T + '" x2="0" y2="' + B
        + '" gradientUnits="userSpaceOnUse">'
        /* THREE BANDS with short joins, not one smooth blend. The list under this chart
           tints each figure with one of three classes (WP.ui.tempTone), and against a
           continuous gradient there was no height at which the two agreed except by luck:
           72 degrees came out blue in the list and pale warm-cream on the curve 400 px
           above it. Banding the gradient at the same cut points the classes use makes the
           curve the legend's own key — most of any band is unambiguously its colour, and
           the 0.1-wide joins are where a bucket boundary honestly is. */
        + '<stop offset="0" stop-color="var(--temp-hot)"/>'
        + '<stop offset="0.22" stop-color="var(--temp-hot)"/>'
        + '<stop offset="0.28" stop-color="var(--temp-warm)"/>'
        + '<stop offset="0.72" stop-color="var(--temp-warm)"/>'
        + '<stop offset="0.78" stop-color="var(--temp-cold)"/>'
        + '<stop offset="1" stop-color="var(--temp-cold)"/></linearGradient>'
        + '<linearGradient id="hc-a" x1="0" y1="' + T + '" x2="0" y2="' + B
        + '" gradientUnits="userSpaceOnUse">'
        + '<stop offset="0" stop-color="var(--temp-warm)" stop-opacity="0.18"/>'
        + '<stop offset="1" stop-color="var(--temp-cold)" stop-opacity="0.02"/></linearGradient></defs>'
        + marks
        + '<g class="hc-bars">' + bars + "</g>"
        + '<path d="' + area + '" fill="url(#hc-a)"/>'
        + '<path d="' + line + '" fill="none" stroke="url(#hc-t)" stroke-width="2.5"'
        + ' vector-effect="non-scaling-stroke"'
        + ' stroke-linecap="round" stroke-linejoin="round"/>'
        + "</svg>"
        + labels + dot
        + '<div class="hc-ticks">' + ticks + "</div></div>";
    },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("hourly");
      if (!panel) return;
      var body = WP.qs("[data-body]", panel);
      var d = weather.data;
      if (!d || !d.hourly) {
        body.innerHTML = '<div class="muted">No forecast loaded yet.</div>';
        return;
      }
      var h = d.hourly, i = this.sel, list = this.window24();
      var t = new Date(h.time[i]);
      var info = WP.wmo(h.weather_code[i], h.is_day && h.is_day[i] === 0);

      WP.qs("[data-sub]", panel).textContent =
        t.toLocaleDateString(undefined, { weekday: "long" }) + " · " + fmt.clock(t, false);

      /* NO HERO. This panel's subject is the next 24 hours, so it opens on the chart.

         It used to open on `72° / Clear · feels 77°` over a glyph — which is the identical
         block Conditions opens with, which is itself the third printing of the home Now
         card. Two adjacent screens in the carousel were roughly half the same screen, and
         the half they shared was the half neither of them is about. The selected hour's own
         reading is not lost: it is the row highlighted in the list below, the dot on the
         curve, and the panel subtitle. What the hero was really buying was 150 CSS px in
         portrait and 127 in landscape, and both are spent here — on an axis whose numbers
         can be read from the sofa, and on rows tall enough to hold their own figures.

         THREE fields, down from eight. Eight was two and a half grid rows of a screen that
         has to hold a chart and a list as well, and it was the reason this panel opened
         scrolled — which in turn is why the top row used to render as three naked numbers
         (63° / 5 mph / 0.8) with their labels above the fold. The four that went are all
         one tap away on Conditions, which is the screen for exactly this; rain per hour is
         the list's own right-hand column. `Feels` takes the slot the hero used to say it
         in, so nothing that was on this screen has left it.

         The stat trio is also no longer Conditions' stat trio: that panel answers
         HUMIDITY / PRESSURE / UV, and this one now answers FEELS / WIND / UV — the three
         that change hour to hour. */
      var uv = fmt.uv(h.uv_index[i]);
      var readout = statGrid([
            /* The qualifier is the humidity alone. "Overcast · 83% humidity" is 21
               characters in a 212 px cell and wrapped, orphaning "humidity" on its own
               line — and the condition word is printed against every hour in the list
               forty pixels below, so it was the half that was already on the screen. */
            ["Feels", fmt.deg(h.apparent_temperature[i]),
              Math.round(h.relative_humidity_2m[i]) + "% humidity"],
            ["Wind", Math.round(h.wind_speed_10m[i]) + " " + fmt.speedUnit(),
              fmt.compass(h.wind_direction_10m[i])],
            ["UV index", String(uv.n), uv.label]
          ], 3);

      /* The day's range, and it is the CHART's range: `list` is all 24 hours, not the
         eight in view. Each row's temperature figure is tinted from it with the same three
         stops the curve above uses, so the list reads as the chart's legend — 66 deg is
         the same blue in the row as it is at the bottom of the curve. */
      var temps = list.map(function (k) { return h.temperature_2m[k]; });
      var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
      var span = (hi - lo) || 1;

      /* The list shows ROWS_SHOWN hours, not all 24, and the panel does not scroll.
         All 24 used to be emitted into a scrollport that could show four of them, so the
         panel's last visible row was always a row sliced in half — the loudest "this is
         unfinished" signal a wall panel has. The 24-hour shape is not lost: it is the chart
         directly above, which is a better way to read a day than 24 rows are. The window
         starts at whatever hour was tapped, so opening the panel on 9p still shows 9p and
         what follows it, and it slides back from the end so the last hours of the forecast
         are reachable rather than being a one-row list. */
      /* FOUR in landscape, and the count came down because the last one was being sliced.
         The number of rows a fixed canvas can show is a property of the canvas: a 711 px
         screen has ~350 px under the chart where a 1138 px one has ~600, and a row has to
         be tall enough to hold a value at the value tier — 74 CSS px in landscape (see the
         min-height in style-widgets.css, which is derived from the type rather than typed).
         Five rows of 74 do not fit in 350 with a heading above them, so the fifth painted
         out of its own box and its temperature was cut by the bezel. Emitting four is the
         honest form of that arithmetic; squeezing five was the dishonest one. */
      /* Five in portrait, down from eight and then six, and every step of that is the same
         arithmetic: a row cannot be shorter than the value it holds (91 CSS px in portrait
         once the temperature is at the value tier), and the panel has ~490 px under the
         chart once the axis is annotated at a size that can be read from 3 m. 490 / 91 is
         five. A row that is half drawn is worse than a row that is not there.
         The 24-hour shape is not lost — it is the chart directly above, which is a better
         way to read a day than a list is.

         THREE in landscape, and the row that went bought the chart back. A 711 px-tall
         screen has ~330 px under the chart; a row is 74 px there; four of them plus a
         heading did not fit, which is how the last one came to be sliced by the bezel. The
         74 px is not lost either: it went into the curve, which had been squashed to ~105 px
         and rendered a 29-degree day as almost flat. On a screen this shape the chart is the
         better half of the panel, so it is the half that gets the pixels. */
      var ROWS_SHOWN = (window.innerWidth > window.innerHeight) ? 3 : 5;
      var from = Math.max(0, Math.min(list.indexOf(i), list.length - ROWS_SHOWN));
      var visible = list.slice(from, from + ROWS_SHOWN);
      var wet = this.anyRain(visible);

      var rows = visible.map(function (k) {
        var tk = new Date(h.time[k]);
        var ik = WP.wmo(h.weather_code[k], h.is_day && h.is_day[k] === 0);
        var pop = h.precipitation_probability ? Math.round(h.precipitation_probability[k]) : 0;
        var tone = tempTone(h.temperature_2m[k], lo, span);
        return '<button class="hrow tappable' + (k === i ? " sel" : "") + '"'
          + ' aria-current="' + (k === i ? "true" : "false") + '"'
          + ' aria-label="' + esc(fmt.hourLabel(tk) + ", " + ik.text + ", "
              + fmt.deg(h.temperature_2m[k]) + ", " + pop + "% chance of rain") + '"'
          + ' data-ns="hourly" data-act="pick" data-arg="' + k + '">'
          + '<span class="hrow-t">' + esc(fmt.hourLabel(tk)) + "</span>"
          + '<span class="hrow-i" aria-hidden="true">' + WP.wxIcon(h.weather_code[k], h.is_day && h.is_day[k] === 0) + "</span>"
          + '<span class="hrow-w">' + esc(ik.text) + "</span>"
          + '<span class="hrow-d ' + tone + '">' + fmt.deg(h.temperature_2m[k]) + "</span>"
          + (wet ? '<span class="hrow-p' + (pop >= 30 ? " wet" : "") + '">' + pop + "%</span>" : "")
          + "</button>";
      }).join("");

      /* The heading names the window the list is actually showing. "Next 24 hours" over a
         list of eight would be a caption that disagrees with the thing under it — and the
         24-hour claim belongs to the chart above, which does cover the whole day. */
      var headFirst = new Date(h.time[visible[0]]);
      WP.repaint(body, readout
        + this.chart(h, list, i)
        + section(visible[0] === Math.max(0, weather.nowIndex())
            ? "Next " + visible.length + " hours"
            : "From " + fmt.hourLabel(headFirst),
        '<div class="hrows">' + rows + "</div>"));
    }
  };

  WP.register(hourly);
})();
