/* Wall panel dashboard — AIR QUALITY.

   Open-Meteo's air-quality endpoint: same provider, same no-key deal, same CORS posture
   as the weather fetch, and it reuses the location already in config.js. The tile is the
   most colour-coded thing on the panel because AQI is the one number whose colour IS the
   standard: the EPA bands are green/yellow/orange/red/purple/maroon by definition, so the
   palette here follows the convention people already know from every AQI map.

   band() and ratioBand() are pure and exported for the tests — the boundaries are the EPA
   breakpoints and the WHO guideline ratios, and an off-by-one at 50/51, 100/101 or exactly
   1.0x the guideline puts the wrong colour on a health scale. The 1.0 case is not
   hypothetical: a strict `n > guideline` shipped, and PM2.5 sitting exactly ON the WHO
   figure rendered as unremarkable white.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section;

  var CACHE = "inky.aqi.v1";

  function band(aqi) {
    if (aqi == null || isNaN(aqi)) return { label: "Unknown", cls: "band-na" };
    if (aqi <= 50) return { label: "Good", cls: "band-1" };
    if (aqi <= 100) return { label: "Moderate", cls: "band-2" };
    if (aqi <= 150) return { label: "Unhealthy for sensitive groups", cls: "band-3" };
    if (aqi <= 200) return { label: "Unhealthy", cls: "band-4" };
    if (aqi <= 300) return { label: "Very unhealthy", cls: "band-5" };
    return { label: "Hazardous", cls: "band-6" };
  }

  /* WHO 2021 air-quality guideline levels, in the ug/m3 the feed already reports (CO is the
     24-hour level). The panel used to print six pollutant figures with no scale of any kind
     beside them, so 98 and 6 looked like the same sort of fact and nothing said which of
     them was near its limit. */
  var GUIDE = { pm2_5: 15, pm10: 45, ozone: 100, nitrogen_dioxide: 25,
                sulphur_dioxide: 40, carbon_monoxide: 4000 };

  /* A RATIO, not a threshold. The first attempt at this was `n > guideline` — one strict
     comparison, two states — and on a normal day it produced six plain white numbers,
     including `PM2.5 15` against a WHO guideline of 15, which is a reading sitting exactly
     ON the limit rendered as unremarkable. A value at 5x the guideline looked identical to
     one at 1.01x, and one at 99% of it looked identical to one at 3%. The only coloured
     figure on the Air panel was the benign 61 at the top.

     Four steps against the ratio, mapped onto the same --band-1..6 ramp AQI and UV already
     use: comfortably under, approaching, over, and well over. Four is what the ratio can
     honestly distinguish — the WHO publishes one number per pollutant, so a six-step ramp
     here would be inventing bands nobody published, and two steps cannot tell "at the
     limit" from "nowhere near it", which is the whole question. */
  function ratioBand(ratio) {
    if (ratio < 0.5) return "band-1";
    if (ratio <= 1) return "band-2";
    if (ratio <= 2) return "band-3";
    return "band-4";
  }

  function pollutant(label, key, cur) {
    var v = cur[key];
    if (v == null || isNaN(v)) return [label, "--"];
    var n = Math.round(v), g = GUIDE[key];
    /* The unit is back on the VALUE line, where it belongs: it migrated to the guideline
       line, which left the measurement as a bare `15` sitting directly above an
       identical-looking reference `15` with no way to tell which was which. The reference
       line says what it is in words instead. */
    return [label,
            '<span class="' + ratioBand(n / g) + '">' + n + "</span> "
              + '<span class="unit">µg/m³</span>',
            "guideline " + g];
  }

  /* Which pollutant is closest to (or furthest past) its own guideline. One sentence at the
     top of the panel is worth more at 3 m than the gauge and the squiggle put together: it
     is the only line on this screen that says WHY the number is what it is, rather than
     restating it. Stated as "nearest its limit" rather than "driving the AQI" because the
     ratio to a WHO guideline is what we can actually compute — the feed does not publish
     the sub-indices the US AQI is the maximum of. */
  function nearestLimit(cur) {
    var best = null;
    Object.keys(GUIDE).forEach(function (k) {
      var v = cur[k];
      if (v == null || isNaN(v)) return;
      var r = v / GUIDE[k];
      if (!best || r > best.r) best = { k: k, r: r };
    });
    if (!best) return "";
    var name = { pm2_5: "PM2.5", pm10: "PM10", ozone: "ozone",
                 nitrogen_dioxide: "NO₂", sulphur_dioxide: "SO₂",
                 carbon_monoxide: "CO" }[best.k];
    /* Precision where it matters. This line said "at 97%" when nothing was wrong and
       "is over its guideline" — the same six words — whether the driver was 1.1x its
       limit or 4.3x it. Forced to a hazardous reading in the simulator, the panel got
       VAGUER exactly as the situation got worse. Above the guideline it now says by how
       much, to one decimal below 10x because 1.9x and 4.3x are different days. */
    if (best.r <= 1) {
      return name + " is nearest its guideline, at " + Math.round(best.r * 100) + "%";
    }
    var mult = best.r < 10 ? (Math.round(best.r * 10) / 10) : Math.round(best.r);
    return name + " is " + mult + "× its guideline";
  }

  var air = {
    name: "air",
    data: null,
    fetchedAt: 0,
    stale: false,
    panel: null,

    init: function () {
      var loc = C.location || {};
      if (loc.latitude == null || loc.longitude == null) {
        var sub = $("air-sub");
        if (sub) sub.textContent = "no location set";
        return;
      }
      var cached = WP.store.readJSON(CACHE, null);
      if (cached && cached.d) {
        this.data = cached.d; this.fetchedAt = cached.t || 0; this.stale = true;
        this.render();
      }
      this.fetch();
      setInterval(this.fetch.bind(this), 30 * 60 * 1000);
    },

    url: function () {
      var loc = C.location;
      return "https://air-quality-api.open-meteo.com/v1/air-quality"
        + "?latitude=" + encodeURIComponent(loc.latitude)
        + "&longitude=" + encodeURIComponent(loc.longitude)
        + "&current=us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide"
        + "&hourly=us_aqi&forecast_days=2&timezone=auto";
    },

    fetch: function () {
      var self = this;
      fetch(this.url())
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (d) {
          self.data = d; self.fetchedAt = Date.now(); self.stale = false;
          WP.store.writeJSON(CACHE, { d: d, t: self.fetchedAt });
          self.render();
          if (self.panel) self.paintPanel();
        })
        .catch(function () {
          /* keep showing the cached reading; the tile marks itself stale */
          self.stale = true;
          self.render();
        });
    },

    render: function () {
      var big = $("air-big"), sub = $("air-sub");
      if (!big) return;
      var cur = this.data && this.data.current;
      if (!cur) { sub.textContent = "waiting for data…"; return; }
      var b = band(cur.us_aqi);
      big.innerHTML = '<span class="' + b.cls + '">' + Math.round(cur.us_aqi) + "</span>";
      /* The band alone. "Moderate · PM2.5 15" needed 146 px of the tile's 80 and printed
         "Moderate…", which is the ellipsis telling you the tile was designed for a width it
         does not have. The pollutant driving the index belongs on the panel, where there is
         room to say which one it is. */
      sub.textContent = (this.stale ? "stale · " : "") + b.label;
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("air");
      if (!panel) return;
      var body = WP.qs("[data-body]", panel);
      var d = this.data;
      if (!d || !d.current) {
        WP.qs("[data-sub]", panel).textContent = "Air quality";
        body.innerHTML = '<div class="muted">No reading yet.</div>';
        return;
      }
      var cur = d.current;
      var b = band(cur.us_aqi);
      /* The band word lives on the SCALE, once. It used to be here AND in the hero caption
         400 px below, which is one screen printing "Moderate" twice about the same number. */
      WP.qs("[data-sub]", panel).textContent = "US AQI"
        + (this.stale ? " · stale" : "");

      /* next 24 h of forecast AQI, from now */
      var chart = "";
      if (d.hourly && d.hourly.us_aqi && d.hourly.time) {
        var now = Date.now(), start = 0;
        for (var i = 0; i < d.hourly.time.length; i++) {
          if (new Date(d.hourly.time[i]).getTime() >= now) { start = Math.max(0, i - 1); break; }
        }
        var vals = d.hourly.us_aqi.slice(start, start + 24);
        /* The same four labels the sensor trace and the hourly curve carry. This was a bare
           squiggle: no y-scale, no ticks, no annotation, one swipe away from a chart that
           had all three, so the only thing it said was "something goes up and down". */
        var lo = Math.round(Math.min.apply(null, vals));
        var hi = Math.round(Math.max.apply(null, vals));
        chart = section("Next 24 hours",
          ui.plot('<div class="aqi-spark ' + b.cls + '">'
                  + WP.sparkline(vals, { w: 200, h: 36 }) + "</div>",
                  String(hi), String(lo), "now", "+24 h"));
      }

      /* NO GAUGE. Two rounds of one, and the second was worse than the first.

         It began as a small hollow ring with no arc, no track and no relation to 61-of-300,
         sitting where a gauge would sit. It was then rebuilt as a "real" 240° arc, which
         measured 55.6 x 43.1 CSS px with a ~14 px amber stub on a track that vanishes at
         3 m and no band ticks at all — at that size it read as a loading spinner caught
         mid-animation, and it still did not say 61 of what.

         The problem was never the drawing. It is that the US AQI is a 0-500 scale on which
         every reading anyone ever sees lives in the first fifth, so a linear gauge of it
         spends 80% of its ink on values that would mean evacuate. What a person wants from
         this screen is which of the six NAMED bands today is in, and that is a categorical
         question, so it gets a categorical picture: six equal segments in the EPA's own
         colours, today's lit and the rest at a quarter strength. Full width, so it is a
         mark you can resolve from the sofa rather than a 43 px curiosity, and the range it
         covers is printed under it — which is the "61 of what" the gauge never answered. */
      var BANDS = [["Good", "0–50"], ["Moderate", "51–100"],
                   ["Sensitive", "101–150"], ["Unhealthy", "151–200"],
                   ["Very unhealthy", "201–300"], ["Hazardous", "301+"]];
      var at = parseInt(b.cls.slice(5), 10) - 1;     // band-2 -> index 1; NaN when unknown
      var scale = '<div class="aqi-scale" role="img" aria-label="'
        + esc(b.label + ", band " + (at + 1) + " of 6 on the US AQI scale") + '">'
        + BANDS.map(function (x, i) {
          return '<span class="aqi-seg band-' + (i + 1) + (i === at ? " on" : "") + '"></span>';
        }).join("")
        + "</div>"
        + '<div class="aqi-range">' + esc(isNaN(at) ? "US AQI 0–500"
            : BANDS[at][0] + " is " + BANDS[at][1] + " of 500") + "</div>";

      body.innerHTML =
        ui.hero("",
          '<span class="' + b.cls + '">' + Math.round(cur.us_aqi) + "</span>",
          esc(nearestLimit(cur)))
        + scale
        + chart
        /* The unit rides on the VALUE line, inline and one shade down (.unit) — not on its
           own line, which is where it started (three-line cells, eighteen lines for six
           fields), and not on the guideline line, which is where it went next and which left
           the measurement as a bare `15` above an identical-looking reference `15`.

           It is deliberately not in the section heading, which is where it went first: the
           label recipe upper-cases every heading, and "µg/m³" upper-cased is "MG/M³" — the
           panel printed milligrams, a thousand-fold error in a health figure, because of a
           text-transform. */
        + section("Pollutants", statGrid([
            pollutant("PM2.5", "pm2_5", cur),
            pollutant("PM10", "pm10", cur),
            pollutant("Ozone", "ozone", cur),
            pollutant("NO₂", "nitrogen_dioxide", cur),
            pollutant("SO₂", "sulphur_dioxide", cur),
            pollutant("CO", "carbon_monoxide", cur)
          ], 3));
    }
  };

  air.band = band;
  air.ratioBand = ratioBand;
  air.nearestLimit = nearestLimit;
  WP.register(air);
})();
