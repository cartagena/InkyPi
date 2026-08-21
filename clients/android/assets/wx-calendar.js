/* Wall panel dashboard — CALENDAR.

   InkyPi's calendar plugin on glass: one or more ICS feeds (Google "secret address in
   iCal format", Apple/Outlook published calendars, Nextcloud — any read-only .ics URL),
   shown as the next few days' agenda. No account is signed into; the panel only READS a
   feed address that config.js gives it: `calendar: { urls: ["https://…/basic.ics"],
   days: 7, refreshMinutes: 30 }`. The parsing and recurrence arithmetic live in ics.js.

   Feeds ride the Java shell's bridge fetch, like the news — calendar hosts do not send
   CORS headers to a file:// page, and the secret address must never be typed into a
   browser that could leak it. In a browser (no shell) the tile says so instead of
   erroring. Fetched events are cached, so a feed that is down keeps yesterday's agenda
   on the wall, marked as such, rather than a blank.

   The tile is the NEXT thing: its time as the value, its name and day under it. Nothing
   coming up is a state worth printing too ("Nothing for 7 days"). The panel lists every
   instance in the window, grouped by day, using the news panel's row idiom.

   The tile is repainted on a minute tick but only rewrites when the next event changes,
   and a weekday name is formatted only then — the app's toLocaleDateString budget is once
   a day (polling.test.js) and a minute tick must not spend it.

   One widget, one flat file (assets/ cannot hold subdirectories).
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc;
  var section = WP.ui.section;

  var CACHE = "inky.cal.v1";
  var DAY = 86400000;

  function cfg() { return (C && C.calendar) || {}; }
  function urls() {
    var u = cfg().urls;
    return Array.isArray(u) ? u.filter(function (x) { return typeof x === "string" && /^https?:\/\//i.test(x); }) : [];
  }
  function days() { return Math.min(31, Math.max(1, parseInt(cfg().days, 10) || 7)); }
  function configured() { return urls().length > 0; }

  function midnight(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function dayIndex(ms, now) { return Math.round((midnight(ms) - midnight(now)) / DAY); }

  /* A VOID IS NOT AN EMPTY STATE, and this panel had the worst one in the product: three
     lines of grey type over about 900 device px of pure black, which at three metres is
     indistinguishable from a screen that failed to draw. The Picture panel had the same
     void for the same reason and got a picture of the missing thing a round earlier; this
     is that fix, arriving where it should have arrived at the same time.

     A month page: the block that hangs the calendar, the head band, and three weeks of
     day cells with one of them lit. Drawn against the icon pack's own gradients so it is
     the same drawing language as the weather glyphs, not a second one. Deliberately not a
     real month — a wrong date on a wall is worse than an obvious diagram. */
  var CELL_W = 9.6, CELL_H = 7.4, CELL_GX = 4.2, CELL_GY = 4;
  function pageArt() {
    var cells = "";
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 7; c++) {
        var lit = (r === 1 && c === 3);
        cells += '<rect x="' + (17 + c * (CELL_W + CELL_GX)).toFixed(1)
          + '" y="' + (38 + r * (CELL_H + CELL_GY)).toFixed(1)
          + '" width="' + CELL_W + '" height="' + CELL_H + '" rx="1.8" fill="'
          + (lit ? "url(#wxg-sun)" : "var(--ic-fog)")
          + '" opacity="' + (lit ? 0.85 : 0.3) + '"/>';
      }
    }
    return '<svg class="pic-art" viewBox="0 0 120 84" aria-hidden="true">'
      + '<rect x="8" y="12" width="104" height="70" rx="7"'
      + ' fill="url(#wxg-cloudd)" opacity="0.28"/>'
      /* the head band, lit along its top edge the way every cloud in the pack is */
      + '<path d="M 8 19 A 7 7 0 0 1 15 12 L 105 12 A 7 7 0 0 1 112 19 L 112 30 L 8 30 Z"'
      + ' fill="url(#wxg-cloud)" opacity="0.5"/>'
      + '<path d="M 10 21 C 11.4 16.8 15 14.6 19.5 14.4 L 100 14.4"'
      + ' fill="none" stroke="var(--ic-cloud-lit)" stroke-width="1.3"'
      + ' stroke-linecap="round" opacity="0.6"/>'
      + cells
      + '<rect x="8.9" y="12.9" width="102.2" height="68.2" rx="6.2" fill="none"'
      + ' stroke="var(--ic-fog)" stroke-width="1.8" opacity="0.55"/>'
      /* the two rings it hangs from — the detail that stops the shape reading as a card */
      + '<rect x="33" y="4" width="4.4" height="15" rx="2.2" fill="var(--ic-fog)"'
      + ' opacity="0.7"/>'
      + '<rect x="82.6" y="4" width="4.4" height="15" rx="2.2" fill="var(--ic-fog)"'
      + ' opacity="0.7"/>'
      + "</svg>";
  }
  function emptyPanel(title, sub) {
    return WP.ui.emptyState(pageArt(), esc(title), esc(sub));
  }

  /* "2:30 PM" / "14:30" from the clock setting — no Intl, so the minute tick stays free */
  function hm(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    var mm = (m < 10 ? "0" : "") + m;
    if (WP.settings.get("clockHours") === 24) return (h < 10 ? "0" : "") + h + ":" + mm;
    var h12 = h % 12 || 12;
    return h12 + ":" + mm + " " + (h < 12 ? "AM" : "PM");
  }
  function span(ev) {
    if (ev.allDay) return "All day";
    var a = hm(ev.start), b = hm(ev.end);
    if (ev.end - ev.start <= 60000) return a;
    /* "2:30 – 3:30 PM": the meridiem once when both halves share it */
    var am = a.slice(-3), bm = b.slice(-3);
    if (am === bm && (am === " AM" || am === " PM")) a = a.slice(0, -3);
    return a + " – " + b;
  }
  /* the day a tile or a heading names: today / tomorrow / weekday + date */
  function dayName(ms, now, long) {
    var di = dayIndex(ms, now);
    if (di === 0) return "Today";
    if (di === 1) return "Tomorrow";
    return new Date(ms).toLocaleDateString(undefined,
      long ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "short" });
  }

  var calendar = {
    name: "calendar",
    panel: null,
    events: [],          // parsed VEVENTs (the whole feed, unexpanded)
    fetchedAt: 0,
    stale: false,
    cardKey: null,

    init: function () {
      var cached = WP.store.readJSON(CACHE, null);
      if (cached && Array.isArray(cached.events)) {
        this.events = cached.events; this.fetchedAt = cached.t || 0; this.stale = true;
      }
      this.renderCard();
      this.fetch();
      var mins = Math.max(5, parseInt(cfg().refreshMinutes, 10) || 30);
      setInterval(this.fetch.bind(this), mins * 60 * 1000);
      setInterval(this.renderCard.bind(this), 60 * 1000);
    },

    /* instances in [today 00:00, today 00:00 + days) — the agenda proper */
    agenda: function (now) {
      var from = midnight(now), to = from + days() * DAY - 1;
      return WP.ics.expand(this.events, from, to);
    },
    /* the tile's event: the first one that has not ENDED yet */
    next: function (now) {
      var list = this.agenda(now);
      for (var i = 0; i < list.length; i++) if (list[i].end > now) return list[i];
      return null;
    },

    fetch: function () {
      if (!configured()) { this.renderCard(); return; }
      if (!WP.bridgeFetch.available()) { this.renderCard(); return; }   // browser: the tile says so
      var self = this;
      Promise.all(urls().map(function (url) {
        return WP.bridgeFetch.get(url, { Accept: "text/calendar, text/plain" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return WP.ics.parse(r.text);
          })
          .catch(function () { return null; });
      })).then(function (feeds) {
        var got = feeds.filter(Boolean);
        if (got.length) {
          self.events = [].concat.apply([], got);
          self.fetchedAt = Date.now();
          self.stale = got.length < feeds.length;       // one feed down: show what came, marked
          WP.store.writeJSON(CACHE, { events: self.events, t: self.fetchedAt });
        } else if (self.events.length) {
          self.stale = true;
        }
        self.cardKey = null;
        self.renderCard();
        if (self.panel) self.paintPanel();
      });
    },

    renderCard: function () {
      var big = $("cal-big"), sub = $("cal-sub");
      if (!big) return;
      var now = Date.now();
      var key, bigText, subText;
      if (!configured()) { key = "unset"; bigText = "—"; subText = "Not set up"; }
      else if (!WP.bridgeFetch.available() && !this.events.length) { key = "noshell"; bigText = "—"; subText = "Needs the tablet"; }
      else {
        var ev = this.next(now);
        if (!ev) { key = "none" + midnight(now); bigText = "—"; subText = "Nothing for " + days() + " days"; }
        else {
          key = ev.uid + "@" + ev.start + "|" + midnight(now) + "|" + WP.settings.get("clockHours");
          bigText = ev.allDay ? "All day" : hm(ev.start);
          var di = dayIndex(ev.start, now);
          subText = ev.title + (di === 0 ? "" : " · " + dayName(ev.start, now, false));
        }
      }
      if (key === this.cardKey) return;            // nothing changed: write nothing
      this.cardKey = key;
      big.textContent = bigText;
      sub.textContent = subText;
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("calendar");
      if (!panel) return;
      var now = Date.now();
      var subEl = WP.qs("[data-sub]", panel), body = WP.qs("[data-body]", panel);
      if (!configured()) {
        subEl.textContent = "Not set up";
        body.innerHTML = emptyPanel("No calendar yet",
          "Any published calendar works — the address is set when the panel is built, "
          + "the same way as the location.");
        return;
      }
      if (!WP.bridgeFetch.available() && !this.events.length) {
        subEl.textContent = "Needs the tablet";
        body.innerHTML = emptyPanel("The agenda needs the tablet",
          "A browser tab cannot read a calendar feed. It fills in once the panel is "
          + "running on the wall.");
        return;
      }
      var list = this.agenda(now);
      subEl.textContent = "Next " + days() + " days · "
        + (list.length ? list.length + (list.length === 1 ? " event" : " events") : "nothing scheduled")
        + (this.stale && this.fetchedAt ? " · as of " + hm(this.fetchedAt) : "");
      if (!list.length) {
        /* An empty week is the answer, not a failure — but it has to LOOK like an answer,
           and a one-line sentence in the middle of a black screen looks like neither. */
        body.innerHTML = emptyPanel("Nothing scheduled",
          "The next " + days() + " days are clear.");
        return;
      }
      /* grouped by day; the heading names the day once, the rows carry only times */
      var groups = [], byDay = {};
      list.forEach(function (ev) {
        var k = midnight(ev.start);
        if (ev.end <= now) return;                 // over: not an agenda item any more
        if (!byDay[k]) { byDay[k] = []; groups.push(k); }
        byDay[k].push(ev);
      });
      body.innerHTML = groups.map(function (k) {
        var rows = byDay[k].map(function (ev) {
          return '<div class="news-row"><div class="news-row-t">' + esc(ev.title) + "</div>"
            + '<div class="news-row-m">' + esc(span(ev) + (ev.location ? " · " + ev.location : "")) + "</div></div>";
        }).join("");
        return section(dayName(k, now, true), '<div class="news-list">' + rows + "</div>");
      }).join("");
    }
  };

  /* the feed origins go on the shell's allowlist while the file parses; boot() locks it */
  urls().forEach(function (url) {
    var o = WP.originOf(url);
    if (o && WP.fetchOrigins.indexOf(o) === -1) WP.fetchOrigins.push(o);
  });

  calendar.hm = hm;
  calendar.span = span;
  calendar.configured = configured;
  WP.register(calendar);
})();
