/* Wall panel dashboard — CLOCK.

   The wall clock on the home card, and a detail panel with the calendar arithmetic
   and nine world clocks — all computed with Intl, no network and no key.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section;

  var clock = {
    name: "clock",
    panelTimer: null,

    /* Last value written to each of the four nodes. The tick has to run at 1 Hz — the
       seconds field is optional but real — while the minute changes 1/60 as often and the
       date once a day. Writing all four every second meant 86,400 toLocaleDateString() calls
       and 345,600 textContent assignments a day to produce ~1,500 actual changes; every one
       of those assignments is a layout invalidation on the busiest element on the wall.
       Cache what was written and skip the writes that would change nothing. The dirty check
       is on the RENDERED STRING, not on the clock, so a 12/24h flip or a seconds toggle
       still lands on the very next tick (S.onChange calls straight into here). */
    shown: { time: null, ampm: null, secs: null, date: null },

    init: function () {
      this.tick();
      setInterval(this.tick.bind(this), 1000);
      S.onChange(this.tick.bind(this));   // 12/24h and seconds apply immediately
    },

    /* Write only if the text actually differs. */
    put: function (id, key, value) {
      if (this.shown[key] === value) return false;
      this.shown[key] = value;
      var el = $(id);
      if (el) el.textContent = value;
      return true;
    },

    tick: function () {
      var now = new Date();
      var h = now.getHours(), m = now.getMinutes(), ampm = "";
      if (S.get("clockHours") === 12) {
        ampm = h >= 12 ? "PM" : "AM";
        h = h % 12; if (h === 0) h = 12;
      } else {
        h = WP.pad2(h);
      }
      this.put("time", "time", h + ":" + WP.pad2(m));
      this.put("ampm", "ampm", ampm);
      this.put("secs", "secs", S.get("seconds") ? ":" + WP.pad2(now.getSeconds()) : "");

      /* toLocaleDateString is the expensive one (it builds an Intl formatter), so it is
         guarded by the calendar day rather than by comparing its own output — that would
         mean calling it to find out whether it was worth calling. */
      var day = now.getFullYear() + "-" + now.getMonth() + "-" + now.getDate();
      if (day !== this.shownDay) {
        this.shownDay = day;
        this.put("date", "date", now.toLocaleDateString(undefined, {
          weekday: "long", month: "long", day: "numeric"
        }));
      }
    },

    /* Detail: seconds, full date, timezone, and world clocks computed with Intl —
       real data, no network, no key. */
    onOpen: function (panel) {
      var self = this;
      var body = WP.qs("[data-body]", panel);
      /* The zone, in the words a person uses for it.
         This line read "America/Los Angeles" — an IANA database key with its underscores
         combed out, which is still a machine identifier and still the wrong half of the
         fact (the continent is not the interesting part; whether we are on daylight time
         is). Intl already knows the long name — "Pacific Daylight Time" — so ask for that
         and keep the id only as a fallback for an ICU build that cannot answer. */
      var localZone = "";
      try { localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
      catch (e0) { localZone = ""; }

      var tzText = "";
      try {
        var parts = new Intl.DateTimeFormat(undefined, {
          hour: "numeric", timeZoneName: "long" }).formatToParts(new Date());
        for (var pi = 0; pi < parts.length; pi++) {
          if (parts[pi].type === "timeZoneName") { tzText = parts[pi].value; break; }
        }
      } catch (e) { /* fall through to the id below */ }
      if (!tzText) {
        try { tzText = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").replace(/_/g, " "); }
        catch (e2) { tzText = ""; }
      }
      WP.qs("[data-sub]", panel).textContent = tzText || "local time";

      /* SIX cities, two across, down from nine across three. A world clock's time is that
         cell's value and takes the value tier like every other number on every other panel,
         and "10:09 PM" at that size measured 213 px against a 213 px cell — one glyph of
         Roboto away from wrapping the time onto two lines on every cell in the grid. Two
         columns give it 320 px. The three that went are the three nearest neighbours of the
         local clock two centimetres above: Denver, Chicago and Berlin are each within an
         hour of a zone still listed, which is what a world clock is for. */
      /* The local zone is NOT in this list, and the list is filtered rather than trimmed
         so it stays right if the tablet is ever hung somewhere else. Los Angeles was the
         first cell of WORLD CLOCKS on a panel whose hero, 700 px above, is the time in Los
         Angeles — a world clock for the room you are standing in. Six cells are authored so
         that dropping the local one still leaves a full two-by-two-and-a-bit grid. */
      var zones = [
        ["Los Angeles", "America/Los_Angeles"],
        ["New York", "America/New_York"],
        ["UTC", "UTC"],
        ["London", "Europe/London"],
        ["Tokyo", "Asia/Tokyo"],
        ["Sydney", "Australia/Sydney"],
        ["Berlin", "Europe/Berlin"]
      ].filter(function (z) { return z[1] !== localZone; }).slice(0, 6);

      /* Two cadences, not one.

         This whole body used to be rebuilt once a second: nine world clocks, each costing
         two freshly-constructed Intl.DateTimeFormat objects, plus a full innerHTML swap of
         the panel — 18 formatter constructions per second for a row of numbers that shows
         minutes and therefore changes once a minute.

         Only two things on this panel genuinely move every second: the big readout (it shows
         seconds) and the epoch counter. Those two get their own nodes and a textContent
         write; everything else is rebuilt when the minute rolls over, or when a setting that
         affects it changes. Same pixels, 1/60th of the work — and as a side effect the panel
         stops replacing its own DOM under a reader's finger 59 times a minute. */
      function liveKey() {
        var n = new Date();
        return n.getFullYear() + "-" + n.getMonth() + "-" + n.getDate()
          + " " + n.getHours() + ":" + n.getMinutes() + " " + S.get("clockHours");
      }

      function tickLight() {
        var now = new Date();
        if (liveKey() !== self.panelKey) { render(); return; }
        var big = $("clk-big");
        if (!big) { render(); return; }          // panel was rebuilt from under us
        big.textContent = fmt.clock(now, true);
      }

      function render() {
        var now = new Date();
        self.panelKey = liveKey();
        var offMin = -now.getTimezoneOffset();
        var offTxt = (offMin >= 0 ? "+" : "-") + WP.pad2(Math.abs(offMin) / 60)
          + ":" + WP.pad2(Math.abs(offMin) % 60);

        /* day-of-year / ISO week are cheap extras that make the panel worth opening.
           Both are DST-sensitive calendar arithmetic (see fmt.dayOfYear for the bug that
           taught us so), so they live in fmt with the rest of the formatters. */
        var doy = fmt.dayOfYear(now);
        var isoWeek = fmt.isoWeek(now);

        /* Scroll-preserving: this rebuilds once a second, so a plain innerHTML swap would
           make the panel impossible to scroll at all. */
        WP.repaint(body,
          '<div class="big-readout"><div class="big-time" id="clk-big">'
          + esc(fmt.clock(now, true)) + "</div>"
          + '<div class="big-sub">' + esc(now.toLocaleDateString(undefined, {
              weekday: "long", year: "numeric", month: "long", day: "numeric" })) + "</div></div>"
          /* THREE cells, one row, and every one of them is something a person might want
             off a wall. What went, and why:
               "Unix time 1786999387" — a seconds-since-1970 counter, ticking, on a kiosk in
                 a hallway. Raw developer output; nobody reads it and nothing reads it back.
               "Time zone America/Los Angeles" — the subtitle four hundred pixels above says
                 the same thing, better. One fact, one place.
               "Clock 12-hour" — a SETTING, not a reading. It is in Settings, and it is on
                 the home screen's SETUP tile. This panel is about what time it is.
             And two of the three that stayed printed their own label inside their value:
             WEEK said "Week 34" and UTC OFFSET said "UTC-07:00". The label is the label.

             The labels are SHORT because a third of this panel is about nine characters
             wide at the label tier. "Day of year" was eleven, wrapped to two lines, and
             dropped its own value ~90 device px below the two beside it — three values on
             three baselines in a row that is read across. Neither word was carrying
             anything: the value "229 of 365" is what "of year" was going to say, and
             "-07:00" under UTC is an offset by construction. */
          + section("Today", statGrid([
              ["UTC", offTxt],
              ["Day", String(doy) + " of " + fmt.daysInYear(now)],
              ["Week", String(isoWeek)]
            ], 3))
          + section("World clocks", '<div class="wc-grid">' + zones.map(function (z) {
              var s = "--:--", day = "";
              try {
                s = new Intl.DateTimeFormat(undefined, {
                  timeZone: z[1], hour: "numeric", minute: "2-digit",
                  hour12: S.get("clockHours") === 12
                }).format(now);
                day = new Intl.DateTimeFormat(undefined, {
                  timeZone: z[1], weekday: "short" }).format(now);
              } catch (e) { /* zone unsupported on this ICU build */ }
              return '<div class="wc"><div class="wc-city">' + esc(z[0]) + "</div>"
                + '<div class="wc-time">' + esc(s) + "</div>"
                + '<div class="wc-day">' + esc(day) + "</div></div>";
            }).join("") + "</div>"));
      }

      render();
      this.panelTimer = setInterval(tickLight, 1000);
      /* No S.onChange registration here: onOpen runs every time the panel is opened, and a
         listener added per open is a listener that is never removed. It is not needed either
         — liveKey() carries clockHours, so a 12/24h flip forces a full rebuild on the very
         next tick, which is the same latency the old rebuild-everything loop had. */
      WP.onAction("clock", function () { /* no in-panel actions */ });
    },

    onClose: function () {
      clearInterval(this.panelTimer);
      this.panelTimer = null;
      this.panelKey = null;
    }
  };

  WP.register(clock);
})();
