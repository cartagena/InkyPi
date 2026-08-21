/* Wall panel dashboard — DAILY FORECAST.

   Seven days across the home card, and a per-day panel with hour-by-hour bars taken from
   the same hourly array the strip uses.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc, fmt = WP.fmt;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero,
      tempTone = ui.tempTone;

  /* The forecast is fetched once and shared: this widget, the "now" card and the daily card
     all read the same payload rather than each hitting Open-Meteo. wx-weather.js is loaded
     before this file (index.html pins that order, and a test asserts it), so the plugin is
     already in the registry by the time this IIFE runs. */
  var weather = WP.registry.weather;

  /* One sentence, in place of two grid cells that printed 0% and 0 in on every dry day.
     Same shape as the Conditions panel's RAIN section, deliberately: one question, one
     idiom, wherever on the wall it is asked. */
  function rainLine(day, i) {
    var pop = Math.round(day.precipitation_probability_max[i] || 0);
    var amt = Math.round((day.precipitation_sum[i] || 0) * 100) / 100;
    if (!pop && !amt) return "None forecast.";
    if (!amt) return pop + "% chance, none expected to fall.";
    return amt + " " + WP.fmt.precipUnit() + " expected, " + pop + "% chance.";
  }

  /* A UV index carries its own band and the band is the part somebody acts on, so the
     figure wears the band's colour — the same treatment AQI already gets on the Air panel.
     Before this, the one coloured value in the app was 70/Moderate (harmless) while
     UV MAX 8.3 "Very high" and OZONE 98 were plain white. Colour marked the safe number. */
  function uvBand(v) {
    var u = WP.fmt.uv(v);
    return '<span class="' + u.tone + '">' + u.n + "</span>";
  }

  var daily = {
    name: "daily",
    sel: 0,

    init: function () {
      var self = this;
      weather.onData(function () { self.render(); });
      WP.onAction("daily", function (act, arg) {
        if (act === "pick") { self.sel = parseInt(arg, 10); self.paintPanel(); }
      });
    },

    render: function () {
      var fc = $("forecast");
      if (!fc) return;
      var d = weather.data;
      if (!d || !d.daily) { fc.innerHTML = '<div class="muted">waiting for forecast…</div>'; return; }

      var day = d.daily;
      /* All 7 days the API returns: the card used to stop at 6 while its own detail panel
         offered 7, so the last day was unreachable from the home view. */
      var n = Math.min(day.time.length, 7);
      var html = "";
      for (var i = 0; i < n; i++) {
        var dt = new Date(day.time[i] + "T12:00:00");
        var info = WP.wmo(day.weather_code[i], false);
        var name = i === 0 ? "Today" : dt.toLocaleDateString(undefined, { weekday: "short" });
        html += '<button class="fc-day tappable" data-open="daily" data-arg="' + i + '"'
          + ' aria-label="' + esc(name + ", " + info.text + ", high "
              + fmt.deg(day.temperature_2m_max[i]) + ", low "
              + fmt.deg(day.temperature_2m_min[i])) + '">'
          + '<div class="fc-name">' + esc(name) + "</div>"
          + '<div class="fc-icon" aria-hidden="true">' + WP.wxIcon(day.weather_code[i], false) + "</div>"
          + '<div class="fc-hi">' + fmt.deg(day.temperature_2m_max[i]) + "</div>"
          + '<div class="fc-lo">' + fmt.deg(day.temperature_2m_min[i]) + "</div>"
          + "</button>";
      }
      fc.innerHTML = html;
    },

    onOpen: function (panel, arg) {
      this.panel = panel;
      var n = parseInt(arg, 10);
      this.sel = isNaN(n) ? 0 : n;
      this.paintPanel();
    },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("daily");
      if (!panel) return;
      var body = WP.qs("[data-body]", panel);
      var d = weather.data;
      if (!d || !d.daily) { body.innerHTML = '<div class="muted">No forecast loaded yet.</div>'; return; }

      var day = d.daily, i = Math.min(this.sel, day.time.length - 1);
      var dt = new Date(day.time[i] + "T12:00:00");
      var info = WP.wmo(day.weather_code[i], false);
      WP.qs("[data-sub]", panel).textContent =
        dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

      /* day switcher across the top of the panel */
      /* cols7, not a wrapping flex row: seven intrinsically-sized chips stopped 200 device
         px short of the right rail, so the strip that selects the day looked like a row
         that had run out rather than a control spanning the panel. Seven is the count and
         the grid is told so. */
      var tabs = '<div class="chip-row cols7" role="radiogroup" aria-label="Day">'
        + day.time.map(function (iso, k) {
          var dk = new Date(iso + "T12:00:00");
          return '<button class="chip tappable' + (k === i ? " on" : "") + '"'
            + ' role="radio" aria-checked="' + (k === i ? "true" : "false") + '"'
            + ' data-ns="daily" data-act="pick" data-arg="' + k + '">'
            + esc(k === 0 ? "Today" : dk.toLocaleDateString(undefined, { weekday: "short" }))
            + "</button>";
        }).join("") + "</div>";

      var sunrise = new Date(day.sunrise[i]), sunset = new Date(day.sunset[i]);

      /* hour-by-hour temperature bars for the selected day, straight from hourly[].

         Rebuilt, because the old version was the worst-reading element in the app:

           * It labelled a TIME axis with TEMPERATURES, one every three bars. Two adjacent
             ticks both read 90° while the bar between them was visibly taller than either
             — the labels were describing the bars they sat above, but they were positioned
             like axis ticks, so they read as a scale that contradicted the chart.
           * It had no time axis at all. There was markup for one, but the chart sat flush
             against the panel footer and the hour row was clipped away underneath it.
           * The bars were a solid accent fill covering ~6% of the screen — 54x the home
             view, and the largest bright area in an app whose own stylesheet says to avoid
             large bright fills on an OLED panel.

         Now: the axis along the bottom is TIME, every three hours, and it is the only
         repeating label. Temperature appears exactly twice, on the warmest and coldest
         bars, where a number is an annotation of that bar rather than a scale. The fill is
         dim with a bright cap (see .daybar-c in style.css), so the shape still reads from
         across a room at a fraction of the lit area. */
      var barsHtml = '<div class="muted">no hourly detail for this day</div>';
      if (d.hourly && d.hourly.time) {
        var iso = day.time[i];
        var idx = [];
        for (var k = 0; k < d.hourly.time.length; k++) {
          if (d.hourly.time[k].indexOf(iso) === 0) idx.push(k);
        }
        if (idx.length) {
          var temps = idx.map(function (k) { return d.hourly.temperature_2m[k]; });
          var lo = Math.min.apply(null, temps), hi = Math.max.apply(null, temps);
          var span = (hi - lo) || 1;
          var iHot = temps.indexOf(hi), iCold = temps.indexOf(lo);
          barsHtml = '<div class="daybars" role="img" aria-label="'
            + esc("hourly temperature through the day, " + fmt.deg(lo) + " to " + fmt.deg(hi))
            + '">'
            + idx.map(function (k, n) {
            var h = 14 + ((d.hourly.temperature_2m[k] - lo) / span) * 86;
            /* EVERY bar's cap wears its own temperature, off the same three stops the
               hourly curve is drawn from and the hourly list is tinted with. The two
               previous versions each half-applied the ramp: an identical amber cap on all
               24 (so amber, which means hot, sat on the coldest hours), then no colour at
               all except a min and a max drawn in the two lowest-contrast colours on the
               screen. Height carried everything and colour marked two extremes nobody could
               resolve at 3 m. A ramp is the chart's language or it is not in the chart.

               .peak still marks the two hours that carry a NUMBER — the bars are already
               the right colour, so nothing is said twice. */
            var peak = (n === iHot || n === iCold);
            return '<div class="daybar ' + tempTone(d.hourly.temperature_2m[k], lo, span)
              + (peak ? " peak" : "") + '">'
              + '<div class="daybar-v">'
                + (peak ? fmt.deg(d.hourly.temperature_2m[k]) : "") + "</div>"
              + '<div class="daybar-c"><div style="height:' + h.toFixed(1) + '%"></div></div>'
              /* Every FOURTH hour, not every third: the annotation tier moved to the acuity
                 floor, and six labels leave 111 CSS px of pitch for a 52 px word where
                 eight left 83. 12A / 4A / 8A / 12P / 4P / 8P still reads as a day. */
              + '<div class="daybar-t">' + (n % 4 === 0
                  ? esc(fmt.hourLabel(new Date(d.hourly.time[k]))) : "") + "</div></div>";
          }).join("") + "</div>";
        }
      }

      WP.repaint(body, tabs
        + hero(WP.wxIcon(day.weather_code[i], false),
               /* The low wears the COLD colour, the same as every other low in the app —
                  the home strip's .fc-lo and the hourly chart's valley callout. It was
                  --dim here, so the identical datum was blue on the dashboard and grey on
                  the screen the dashboard opens into. */
               fmt.deg(day.temperature_2m_max[i])
                 + ' <span class="lo">/ ' + fmt.deg(day.temperature_2m_min[i]) + "</span>",
               /* The two ends of the day belong on the day's own line. As a pair of grid
                  cells they cost a whole stat row at the re-scaled value size, to say two
                  clock times that nobody reads as a measurement. */
               esc(info.text) + " · " + esc(fmt.clock(sunrise, false))
                 + " – " + esc(fmt.clock(sunset, false)))

        /* SIX cells, two rows, and the count is fixed whatever the weather does.

           It was nine. Two of them were the zeros this panel never got the zero-suppression
           the others did — a dry day printed RAIN CHANCE 0% beside PRECIP TOTAL 0 in, which
           is two cells to say nothing — and DAYLIGHT was sunset minus sunrise printed
           between sunset and sunrise. When the value tier was re-scaled for 3 m each stat
           row grew by ~2vh and three rows put this panel 19 px off the bottom of the frame
           (measured on the device). Cutting the row that carried the least is the trade the
           re-scale is paid for with; shrinking the type back is not.

           Rain moved OUT of the grid and into one sentence below it, which is the idiom
           Conditions already answers the same question with. */
        /* THREE cells, one row. It was nine, then six, and the arithmetic is the same
           each time: a stat row costs ~2vh more now that its value is sized for a 3 m read,
           and this panel is a fixed canvas. What went, and why:
             RAIN CHANCE + PRECIP TOTAL  two cells printing 0% and 0 in on a dry day, the
                                         zero suppression the other panels got. Now one
                                         sentence under the grid.
             DAYLIGHT                    sunset minus sunrise, printed between sunset and
                                         sunrise.
             SUNRISE + SUNSET            two clock times, now on the hero's own line where
                                         they read as the shape of the day rather than as
                                         two measurements.
             FEELS HIGH + FEELS LOW      one cell. They are one fact with two ends, exactly
                                         like the 93° / 65° in the hero above them. */
        + section("Day", statGrid([
            ["Feels", fmt.deg(day.apparent_temperature_max[i])
              + ' <span class="lo">/ ' + fmt.deg(day.apparent_temperature_min[i]) + "</span>",
              "high / low"],
            /* The unit is on the value line, so the qualifier does not print it again —
               "WNW · gusts 11 mph" wrapped and left `mph` orphaned on a line of its own,
               to restate the unit standing 30 px above it. */
            ["Max wind", Math.round(day.wind_speed_10m_max[i]) + " " + fmt.speedUnit(),
              fmt.compass(day.wind_direction_10m_dominant[i]) + " · gusts "
                + Math.round(day.wind_gusts_10m_max[i])],
            ["UV max", uvBand(day.uv_index_max[i]), fmt.uv(day.uv_index_max[i]).label]
          ], 3))
        + section("Rain", '<div class="muted">' + rainLine(day, i) + "</div>")
        + section("Hour by hour", barsHtml));
    }
  };

  WP.register(daily);
})();
