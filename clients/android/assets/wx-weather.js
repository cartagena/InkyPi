/* Wall panel dashboard — WEATHER (now).

   Real Open-Meteo, no API key. ONE fetch feeds this card, the hourly strip and the daily
   row; the other two subscribe with onData(). The last good payload is cached in
   localStorage so a failed refresh shows the previous reading with a "stale" badge
   instead of an empty card.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero;

  var WX_CACHE = "inky.wx.v2";

  /* ---------------- the rain section ----------------
     On a dry week this section printed "0 in", "0%", "0 in / 0% chance" — nine zeros in
     three cells, under a heading, on a panel read from across a room. In El Cajon that is
     the state of the screen for months at a time. Three cells of zero are not three facts;
     they are one fact, and the fact is "no". So when there is nothing falling and nothing
     forecast, the section says the one thing worth saying and gives its height back — and
     when there IS something, it says WHEN, which is what the zeros never did.

     The grid comes back the moment rain is real (falling now, likely within the hour, or
     any measured total today), because then the three figures genuinely differ. */
  function rainSection(cur, h, day, i) {
    var nextHour = (h && h.precipitation_probability && i >= 0)
      ? Math.round(h.precipitation_probability[i]) : 0;
    var todaySum = (day && day.precipitation_sum) ? (day.precipitation_sum[0] || 0) : 0;
    var wet = (cur.precipitation || 0) > 0 || nextHour >= 30 || todaySum > 0;

    if (!wet) {
      var pops = (day && day.precipitation_probability_max) || [];
      for (var k = 1; k < pops.length; k++) {
        if (Math.round(pops[k] || 0) >= 30) {
          /* "T12:00:00", like every other reader of daily.time in this app: the API sends
             a bare date ("2025-06-13"), which JavaScript parses as UTC midnight and then
             renders in local time — one day EARLIER anywhere west of Greenwich. The rain
             day would have been named Thursday for a Friday, on a panel in California. */
          var when = new Date(day.time[k] + "T12:00:00");
          return section("Rain", '<div class="muted">Next rain: '
            + esc(when.toLocaleDateString(undefined, { weekday: "long" }))
            + ", " + Math.round(pops[k]) + "% chance.</div>");
        }
      }
      return section("Rain", '<div class="muted">None forecast in the next '
        + Math.max(1, pops.length) + " days.</div>");
    }

    /* Three cells, not four. Four in a three-across grid left one cell alone on a second
       row with a hairline stopping at a third of the width, which reads as a section that
       failed to finish. The two "today" facts are one thought, so they are one cell: the
       total on the value line, the chance on the line under it. */
    return section("Rain", statGrid([
      ["Right now", (cur.precipitation || 0) + " " + fmt.precipUnit()],
      ["Next hour", nextHour + "%"],
      ["Today", (Math.round(todaySum * 100) / 100) + " " + fmt.precipUnit(),
        (day && day.precipitation_probability_max)
          ? Math.round(day.precipitation_probability_max[0]) + "% chance" : ""]
    ], 3));
  }

  var weather = {
    name: "weather",
    data: null,
    fetchedAt: 0,
    stale: false,
    subs: [],
    lastHour: -1,   // wall-clock hour of the last rollover check; see init()

    onData: function (fn) { this.subs.push(fn); },

    init: function () {
      var loc = C.location || {};
      if (loc.latitude == null || loc.longitude == null) {
        $("wx-temp").textContent = "--°";
        $("wx-desc").textContent = "No location set";
        $("wx-meta").textContent = "Set latitude/longitude in assets/config.js, then rebuild";
        WP.status("Weather is off — no location set", true);
        return;
      }
      /* Paint from cache first so the panel is never blank while the request is in
         flight (or forever, if the wifi is down at boot). */
      var cached = WP.store.readJSON(WX_CACHE, null);
      if (cached && cached.d) {
        this.data = cached.d;
        this.fetchedAt = cached.t || 0;
        this.stale = true;
        this.publish();
      }
      this.fetch();
      setInterval(this.fetch.bind(this), (C.weatherRefreshMinutes || 15) * 60 * 1000);

      /* Refetch on the hour boundary as well as on the refresh timer.
         Why: the hourly strip re-anchors itself the moment the wall clock crosses into a
         new hour (its own 15 s tick watches nowIndex), but the big "Now" temperature only
         changes when a fetch lands. Between a rollover and the next scheduled fetch the
         two disagree on screen — observed live as "65°" on the Now card beside "NOW 66°"
         in the strip, because the card still held the 6:55 reading while the strip had
         advanced to the 07:00 slot. Same instant, two different current temperatures.
         Refetching on the rollover keeps every card sourced from one payload, and costs
         at most one extra request per hour. */
      setInterval(function () { weather.checkRollover(); }, 15000);

      /* Changing units re-requests rather than converting locally: Open-Meteo will hand
         back mph/inch or km/h/mm to match, so every derived field stays consistent.
         The status line embeds a formatted clock, so a 12/24h flip has to redraw it too —
         otherwise the header keeps saying "Updated 11:31 PM" above a 23:31 clock until the
         next fetch, up to 15 minutes later. */
      S.onChange(function (k) {
        if (k === "units" || k === "*") weather.fetch();
        else if (k === "clockHours") weather.showStatus();
      });
    },

    /* Called by the 15 s tick above. A named method rather than an anonymous interval body
       because it IS the fix for the Now/NOW desync and therefore the thing a test has to be
       able to ask about: has the wall clock crossed into a new hour, and if so has the
       payload been refreshed so the card and the strip are reading the same one. Returns
       true when it started a refetch. */
    checkRollover: function () {
      var h = new Date().getHours();
      if (this.lastHour === h) return false;
      this.lastHour = h;
      if (!this.fetchedAt) return false;        // boot pass; init() already fetched
      this.fetch();
      return true;
    },

    /* Single source of truth for the status line, so it can be redrawn at any time from
       state instead of only at the moment a fetch lands.

       SILENT WHEN FRESH. It used to print "Updated 10:38 PM" — directly above a clock card
       reading 10:38 PM, in the biggest type on the wall. The one thing a fresh timestamp
       cannot tell you is that the data is fresh, because on this screen it is the same
       glyphs as the time. A status line on a wall panel earns its row by speaking when
       something is wrong; the fresh case has nothing to say and says it.

       Stale is unchanged and stays loud, because that is the case the line exists for. */
    showStatus: function () {
      if (this.stale) {
        if (!this.data) return;
        WP.status("Offline — showing last reading"
          + (this.fetchedAt ? " (" + fmt.ago(this.fetchedAt) + ")" : ""), true);
      } else if (this.fetchedAt) {
        WP.status("");
      }
    },

    url: function () {
      var loc = C.location;
      var metric = S.isMetric();
      return "https://api.open-meteo.com/v1/forecast"
        + "?latitude=" + encodeURIComponent(loc.latitude)
        + "&longitude=" + encodeURIComponent(loc.longitude)
        + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation"
          + ",weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m"
          + ",wind_direction_10m,wind_gusts_10m"
        + "&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m"
          + ",precipitation_probability,precipitation,weather_code,cloud_cover,visibility"
          + ",wind_speed_10m,wind_direction_10m,uv_index,is_day"
        + "&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max"
          + ",apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max"
          + ",precipitation_sum,precipitation_probability_max,wind_speed_10m_max"
          + ",wind_gusts_10m_max,wind_direction_10m_dominant"
        + "&temperature_unit=" + (metric ? "celsius" : "fahrenheit")
        + "&wind_speed_unit=" + (metric ? "kmh" : "mph")
        + "&precipitation_unit=" + (metric ? "mm" : "inch")
        + "&timezone=auto&forecast_days=7";
    },

    fetch: function () {
      var self = this;
      if (!C.location || C.location.latitude == null) return;
      fetch(this.url(), { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (d) {
          self.data = d;
          self.fetchedAt = Date.now();
          self.stale = false;
          WP.store.writeJSON(WX_CACHE, { t: self.fetchedAt, u: S.get("units"), d: d });
          self.publish();
          self.showStatus();
        })
        .catch(function (e) {
          /* Offline: keep the last reading on screen and badge it, never blank the card. */
          self.stale = true;
          self.publish();
          if (self.data) self.showStatus();
          else WP.status("Weather unavailable (" + e.message + ")", true);
        });
    },

    publish: function () {
      this.render();
      this.subs.forEach(function (fn) {
        try { fn(weather.data, weather.stale); } catch (e) { console.error("wx sub: " + e.message); }
      });
      /* Three of the home cards just changed size (an empty card is a fraction of the
         height of a loaded one), and the growth caps are measured off exactly that. */
      WP.relayoutHome();
    },

    /* index into hourly[] for the hour we are currently inside */
    /* Which hourly slot the wall clock is inside. Called by the hourly strip's 15 s tick and
       by every render, and it parses up to 168 ISO date strings each time — ~670 Date
       constructions a minute to answer a question whose answer is, by construction, valid
       until the next hour boundary.

       So cache the answer together with the exact window it was derived from, and reuse it
       while the clock is still inside that window. Not keyed on "the current hour": the
       payload's timestamps come back in the location's own zone (timezone=auto), and a zone
       at a :30 or :45 offset would put a UTC-hour key out of step with the slot boundaries.
       The window is taken from the data itself, so it cannot drift from it. A miss (no slot
       contains `now`, e.g. a stale cached payload) is deliberately not cached — that is the
       case where re-checking every call is the point. */
    nowIndex: function () {
      var d = this.data;
      if (!d || !d.hourly || !d.hourly.time) return -1;
      var now = Date.now();
      if (this.niData === d && now >= this.niFrom && now < this.niTo) return this.niVal;
      for (var i = 0; i < d.hourly.time.length; i++) {
        var t = new Date(d.hourly.time[i]).getTime();
        if (t <= now && now < t + 3600000) {
          this.niData = d; this.niFrom = t; this.niTo = t + 3600000; this.niVal = i;
          return i;
        }
      }
      return 0;
    },

    /* ---------------- SOURCE OF TRUTH for "right now" ----------------

       Open-Meteo answers with two different "now"s and they legitimately disagree.
       `current` is INTERPOLATED TO THE MINUTE the request was made; `hourly[i]` is the
       value AT THE TOP OF THE HOUR. Both are correct, they are simply not the same
       measurement — which is why the Now card read 91° beside a NOW chip reading 90° on
       the wall, and why the rollover refetch above (a real fix, for a real second cause)
       could never finish the job. Refetching cannot make two different quantities equal.

       THE DECISION: hourly[nowIndex()] is this wall panel's truth.

         * Everything else on the screen already comes out of hourly[]. The 24-chip strip,
           the hourly panel's list and hero, the daily panel's hour bars — 50-odd numbers.
           Sourcing the ONE big number from `current` made one number disagree with all
           the rest; sourcing it from hourly[] makes the whole wall one payload, one hour,
           one reading.
         * `current` moves between fetches while hourly[] does not, so a card fed from it
           can drift away from the strip at ANY moment, not only across a rollover. There
           is no cadence that fixes that; there is only picking one array.
         * The cost is honest and small: the big number is the hour's value rather than
           this minute's, on a panel read from 2-4 m that also shows the next 24 hours.

       Fields hourly[] does not carry (pressure, gusts) still come from `current` — they
       have nothing on screen to disagree with. `current` is also the whole fallback when
       there is no usable hourly slot. */
    nowReading: function () {
      var d = this.data;
      if (!d || !d.current) return null;
      var cur = d.current, h = d.hourly, i = this.nowIndex();
      function pick(key) {
        return (h && h[key] && i >= 0 && h[key][i] != null) ? h[key][i] : cur[key];
      }
      return {
        index: i,
        temperature_2m: pick("temperature_2m"),
        apparent_temperature: pick("apparent_temperature"),
        relative_humidity_2m: pick("relative_humidity_2m"),
        cloud_cover: pick("cloud_cover"),
        precipitation: pick("precipitation"),
        weather_code: pick("weather_code"),
        is_day: pick("is_day"),
        wind_speed_10m: pick("wind_speed_10m"),
        wind_direction_10m: pick("wind_direction_10m"),
        /* hourly[] carries none of these three */
        wind_gusts_10m: cur.wind_gusts_10m,
        pressure_msl: cur.pressure_msl,
        surface_pressure: cur.surface_pressure
      };
    },

    render: function () {
      var d = this.data;
      if (!d || !d.current) return;
      var cur = this.nowReading();
      var info = WP.wmo(cur.weather_code, cur.is_day === 0);

      $("wx-icon").innerHTML = WP.wxIcon(cur.weather_code, cur.is_day === 0);
      $("wx-temp").textContent = fmt.deg(cur.temperature_2m);
      $("wx-desc").textContent = info.text;
      $("wx-badge").hidden = !this.stale;

      $("wx-quick").innerHTML =
        '<div class="wxq"><span class="wxq-k">Feels</span><span class="wxq-v">'
          + fmt.deg(cur.apparent_temperature) + "</span></div>"
        + '<div class="wxq"><span class="wxq-k">Wind</span><span class="wxq-v">'
          + Math.round(cur.wind_speed_10m) + " " + fmt.speedUnit() + "</span></div>"
        + '<div class="wxq"><span class="wxq-k">Humidity</span><span class="wxq-v">'
          + Math.round(cur.relative_humidity_2m) + "%</span></div>";

      var i = this.nowIndex();
      var bits = [];
      if (C.location && C.location.name) bits.push(C.location.name);
      if (d.daily && d.daily.temperature_2m_max) {
        bits.push("H " + fmt.deg(d.daily.temperature_2m_max[0])
          + " / L " + fmt.deg(d.daily.temperature_2m_min[0]));
      }
      if (i >= 0 && d.hourly.uv_index) {
        var uv = fmt.uv(d.hourly.uv_index[i]);
        bits.push("UV " + uv.n + " " + uv.label);
      }
      if (this.stale) bits.push("last update " + fmt.ago(this.fetchedAt));
      $("wx-meta").textContent = bits.join("   ·   ");
    },

    /* One line, from state, in a person's words. It used to read "<place> · live" /
       "<place> · stale" — "stale" is a cache's word for itself, not something to tell
       somebody standing in front of a wall panel. The freshness belongs here rather than in
       a Source section at the bottom of a screen that had to be scrolled to reach it.
       (The place name itself is never written into a source file: it comes from
       CONFIG.location.name at runtime, and config.js is held out of the repo.) */
    /* "updated 3s ago" was a string that changed every second, for ever, at 2.8 arcminutes
       of cap height — churn nobody can read, on the line that is supposed to be the quiet
       provenance of the screen. A HEALTHY panel says the clock time it was fetched at,
       which is a fact that sits still. An age is kept for the unhealthy case, because there
       the point IS that it is growing. */
    panelSub: function () {
      var age = this.fetchedAt ? fmt.ago(this.fetchedAt) : "";
      var at = this.fetchedAt ? fmt.clock(new Date(this.fetchedAt), false) : "";
      var where = (C.location && C.location.name) ? C.location.name + " · " : "";
      if (!this.data) return where + "waiting for the forecast";
      if (this.stale) return where + (age ? "offline, last reading " + age : "offline");
      return where + (at ? "updated " + at : "current conditions") + " · Open-Meteo";
    },

    onOpen: function (panel) {
      var body = WP.qs("[data-body]", panel);
      var d = this.data;
      WP.qs("[data-sub]", panel).textContent = this.panelSub();

      if (!d || !d.current) {
        body.innerHTML = '<div class="muted">No weather data yet. '
          + "The panel retries every " + (C.weatherRefreshMinutes || 15) + " minutes.</div>";
        return;
      }

      /* Same reading the home card is drawn from — see nowReading(). This panel is the
         magnification of that card, so "91° / feels 99°" up here and "90° / feels 98°"
         down on the strip was the same defect seen twice. */
      var cur = this.nowReading(), i = this.nowIndex(), h = d.hourly, day = d.daily;
      var info = WP.wmo(cur.weather_code, cur.is_day === 0);
      var uv = fmt.uv(h && h.uv_index && i >= 0 ? h.uv_index[i] : (day ? day.uv_index_max[0] : null));

      var sunrise = day && day.sunrise ? new Date(day.sunrise[0]) : null;
      var sunset = day && day.sunset ? new Date(day.sunset[0]) : null;
      var dayLen = day && day.daylight_duration ? fmt.duration(day.daylight_duration[0] * 1000) : "--";

      /* D2 — this panel's vertical strategy. It used to measure ~111vh against a ~81vh
         scrollport and so was always mid-scroll, with SUN cut in half by the footer and two
         whole sections below the fold. Three changes, no data removed except one genuinely
         redundant cell:
           the hero is a row, not a stack        (-8vh)
           the stat grids run three across       (-22vh, the values here are all short)
           Source is folded into the subtitle    (-6vh)
         "Now: Daytime / Night" is the one cell dropped: the hero glyph two lines above it
         is the sun or the moon, so the cell restated it in words.

         Then the values were sized for a 3 m read, which costs about 2vh per stat row, and
         AIR's second row is the one that paid for it. The three cells that went:
           CLOUD 0%      — the hero two lines above says "Clear". One fact, two grammars.
           VISIBILITY    — 40.4 mi in this valley, nearly every day, and there is no action
                           anybody takes on it.
           DEW POINT     — a comfort proxy, sitting beside HUMIDITY, which is the reading
                           people actually use to answer the same question.
         Cutting a row is the trade the re-scale is paid for with; shrinking the type back
         until nine fields fit is not. */
      body.innerHTML =
        hero(WP.wxIcon(cur.weather_code, cur.is_day === 0), fmt.deg(cur.temperature_2m),
             esc(info.text) + " · feels " + fmt.deg(cur.apparent_temperature))

        + section("Air", statGrid([
            ["Humidity", Math.round(cur.relative_humidity_2m) + "%"],
            /* the unit on its own line, like UV's band and the wind's bearing: "29.92 inHg"
               is eleven glyphs at the value tier and wrapped a third of a 711 px panel */
            ["Pressure", fmt.pressure(cur.pressure_msl).replace(/\s*(\S+)$/, ""),
              fmt.pressure(cur.pressure_msl).split(" ").pop()],
            ["UV index", '<span class="' + uv.tone + '">' + uv.n + "</span>", uv.label]
          ], 3))

        + section("Wind", statGrid([
            ["Speed", Math.round(cur.wind_speed_10m) + " " + fmt.speedUnit()],
            ["Gusts", Math.round(cur.wind_gusts_10m) + " " + fmt.speedUnit()],
            /* The arrow belongs with Direction, not in a cell of its own labelled "Arrow" —
               that labelled a decoration as if it were a measurement, and sat next to the
               Direction cell already carrying the same fact. It points where the wind is
               blowing toward, i.e. bearing + 180.
               The line under it used to read "250° · blowing toward" — a preposition with
               nothing after it. A bearing is read as where the wind comes FROM, which is
               also what the compass letters above it say, so that is what it now says. */
            ["Direction", fmt.compass(cur.wind_direction_10m)
              + ' <span class="wind-arrow" aria-hidden="true" style="transform:rotate('
              + Math.round(cur.wind_direction_10m + 180) + 'deg)">&uarr;</span>',
              "from " + Math.round(cur.wind_direction_10m) + "°"]
          ], 3))

        + section("Sun", statGrid([
            ["Sunrise", sunrise ? esc(fmt.clock(sunrise, false)) : "--"],
            ["Sunset", sunset ? esc(fmt.clock(sunset, false)) : "--"],
            ["Daylight", esc(dayLen)]
          ], 3))

        + rainSection(cur, h, day, i);
    }
  };

  WP.register(weather);
})();
