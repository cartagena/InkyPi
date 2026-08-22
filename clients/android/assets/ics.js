/* Wall panel dashboard — ICS (iCalendar) PARSER + RECURRENCE EXPANDER.

   The pure half of the Calendar widget, kept apart from it so it can be read and tested
   on its own: text in, event instances out. No DOM, no network, no globals but WP.ics.

   What it understands is what real exported calendars (Google, Apple, Outlook, Nextcloud)
   actually emit for a read-only feed:
     * line unfolding (CRLF + one leading space/tab), VEVENT blocks, escaped text
     * DTSTART / DTEND / DURATION, as DATE (all-day), DATE-TIME with Z, with TZID, or
       floating; TZID is resolved with Intl, so "America/New_York" lands at the right
       instant, and an unknown zone degrades to the device's own
     * SUMMARY, LOCATION, UID, STATUS:CANCELLED (dropped)
     * RRULE with FREQ daily/weekly/monthly/yearly, INTERVAL, COUNT, UNTIL, BYDAY
       (weekly lists; monthly ordinals like 2TU / -1FR), BYMONTHDAY (one value)
     * EXDATE, and RECURRENCE-ID overrides (the moved instance replaces the generated one)
   and nothing more exotic. Everything outside that is skipped, never guessed at, because
   a wrong appointment on a kitchen wall is worse than a missing one.

   Times are epoch milliseconds throughout; the widget formats them. Expansion is bounded
   to the asked-for window and a hard iteration cap, so a malformed rule cannot spin.

   One module, one flat file (assets/ cannot hold subdirectories).
*/

(function () {
  "use strict";

  var DAY = 86400000;
  var WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /* ---------------- lines and properties ---------------- */

  function unfold(text) {
    return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .replace(/\n[ \t]/g, "").split("\n");
  }

  /* "DTSTART;TZID=America/New_York;VALUE=DATE-TIME:20260821T143000"
     -> { name: "DTSTART", params: { TZID: "America/New_York", VALUE: "DATE-TIME" }, value } */
  function prop(line) {
    var i = line.indexOf(":");
    if (i < 0) return null;
    /* a ':' inside a quoted parameter value (e.g. ALTREP="http://…") is not the separator */
    var inQ = false;
    for (var k = 0; k < line.length; k++) {
      var ch = line.charAt(k);
      if (ch === '"') inQ = !inQ;
      else if (ch === ":" && !inQ) { i = k; break; }
    }
    var head = line.slice(0, i).split(";"), value = line.slice(i + 1);
    var params = {};
    head.slice(1).forEach(function (p) {
      var e = p.indexOf("=");
      if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, "");
    });
    return { name: head[0].toUpperCase(), params: params, value: value };
  }

  function unescapeText(v) {
    return String(v || "").replace(/\\n/gi, "\n").replace(/\\,/g, ",")
      .replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
  }

  /* ---------------- time zones ----------------
     Offset of `tz` at the UTC instant `ms`, via Intl. Cached per zone+hour. A zone Intl
     does not know throws RangeError; the caller treats that as "floating" (device local). */
  var dtfCache = {};
  function dtf(tz) {
    if (!dtfCache[tz]) {
      dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric"
      });
    }
    return dtfCache[tz];
  }
  function tzOffset(tz, ms) {
    var parts = dtf(tz).formatToParts(new Date(ms)), o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    var asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }
  /* wall-clock fields in `tz` -> epoch ms (two passes settle a DST edge) */
  function zonedToMs(y, mo, d, hh, mi, ss, tz) {
    var guess = Date.UTC(y, mo, d, hh, mi, ss);
    var off = tzOffset(tz, guess);
    var ms = guess - off;
    var off2 = tzOffset(tz, ms);
    return off2 === off ? ms : guess - off2;
  }

  /* "20260821", "20260821T143000", "20260821T143000Z" + params -> { ms, allDay, tz } */
  function parseDate(value, params) {
    var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value || "").trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (!m[4] || (params && params.VALUE === "DATE")) {
      return { ms: new Date(y, mo, d).getTime(), allDay: true, tz: null };
    }
    var hh = +m[4], mi = +m[5], ss = +(m[6] || 0);
    if (m[7]) return { ms: Date.UTC(y, mo, d, hh, mi, ss), allDay: false, tz: "UTC" };
    var tz = params && params.TZID;
    if (tz) {
      try { return { ms: zonedToMs(y, mo, d, hh, mi, ss, tz), allDay: false, tz: tz }; }
      catch (e) { /* unknown zone: fall through to floating */ }
    }
    return { ms: new Date(y, mo, d, hh, mi, ss).getTime(), allDay: false, tz: null };
  }

  /* "P1DT2H30M" / "PT45M" / "P2W" -> ms */
  function parseDuration(v) {
    var m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
    if (!m) return null;
    var ms = (+(m[2] || 0)) * 7 * DAY + (+(m[3] || 0)) * DAY + (+(m[4] || 0)) * 3600000
      + (+(m[5] || 0)) * 60000 + (+(m[6] || 0)) * 1000;
    return m[1] === "-" ? -ms : ms;
  }

  function parseRRule(v) {
    var r = {};
    String(v || "").split(";").forEach(function (kv) {
      var e = kv.indexOf("=");
      if (e > 0) r[kv.slice(0, e).toUpperCase()] = kv.slice(e + 1);
    });
    if (!r.FREQ) return null;
    var out = { freq: r.FREQ.toUpperCase(), interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1) };
    if (r.COUNT) out.count = parseInt(r.COUNT, 10);
    if (r.UNTIL) { var u = parseDate(r.UNTIL, {}); if (u) out.until = u.allDay ? u.ms + DAY - 1 : u.ms; }
    if (r.BYDAY) {
      out.byday = r.BYDAY.split(",").map(function (s) {
        var m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim().toUpperCase());
        return m ? { n: m[1] ? parseInt(m[1], 10) : 0, d: WD[m[2]] } : null;
      }).filter(Boolean);
    }
    if (r.BYMONTHDAY) out.bymonthday = parseInt(r.BYMONTHDAY.split(",")[0], 10);
    return out;
  }

  /* ---------------- VEVENTs ---------------- */

  function parse(text) {
    var events = [], cur = null;
    unfold(text).forEach(function (line) {
      if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; return; }
      if (line === "END:VEVENT") { if (cur && cur.start) events.push(cur); cur = null; return; }
      if (!cur) return;
      var p = prop(line);
      if (!p) return;
      switch (p.name) {
        case "UID": cur.uid = p.value.trim(); break;
        case "SUMMARY": cur.title = unescapeText(p.value); break;
        case "LOCATION": cur.location = unescapeText(p.value); break;
        case "STATUS": cur.cancelled = /^CANCELLED$/i.test(p.value.trim()); break;
        case "DTSTART": cur.start = parseDate(p.value, p.params); break;
        case "DTEND": cur.end = parseDate(p.value, p.params); break;
        case "DURATION": cur.duration = parseDuration(p.value); break;
        case "RRULE": cur.rrule = parseRRule(p.value); break;
        case "EXDATE":
          p.value.split(",").forEach(function (v) {
            var d = parseDate(v, p.params); if (d) cur.exdates.push(d.ms);
          });
          break;
        case "RECURRENCE-ID": cur.recurrenceId = parseDate(p.value, p.params); break;
      }
    });
    return events.filter(function (e) { return !e.cancelled; });
  }

  function endOf(e, startMs) {
    if (e.end) return startMs + (e.end.ms - e.start.ms);
    if (e.duration != null) return startMs + e.duration;
    return e.start.allDay ? startMs + DAY : startMs;
  }

  /* Occurrence starts of a master event inside [from, to], in ms. The rule is walked
     from DTSTART in the event's own wall clock (so a 9:00 weekly stays 9:00 across DST),
     bounded by COUNT / UNTIL / the window / a hard cap. */
  function occurrences(e, from, to) {
    var r = e.rrule, s = e.start;
    if (!r) return (s.ms <= to && endOf(e, s.ms) >= from) ? [s.ms] : [];
    var out = [], n = 0, iter = 0;
    var base = new Date(s.ms);
    var tz = s.tz && s.tz !== "UTC" ? s.tz : null;
    /* wall-clock fields of DTSTART in its zone */
    var w = tz ? wall(s.ms, tz) : { y: base.getFullYear(), mo: base.getMonth(), d: base.getDate(),
                                    hh: base.getHours(), mi: base.getMinutes(), ss: base.getSeconds() };
    if (s.tz === "UTC") {
      w = { y: base.getUTCFullYear(), mo: base.getUTCMonth(), d: base.getUTCDate(),
            hh: base.getUTCHours(), mi: base.getUTCMinutes(), ss: base.getUTCSeconds() };
    }
    function at(y, mo, d) {
      if (s.tz === "UTC") return Date.UTC(y, mo, d, w.hh, w.mi, w.ss);
      if (tz) { try { return zonedToMs(y, mo, d, w.hh, w.mi, w.ss, tz); } catch (x) { /* floating */ } }
      return new Date(y, mo, d, w.hh, w.mi, w.ss).getTime();
    }
    function emit(ms) {
      iter++;
      if (r.until != null && ms > r.until) return false;
      if (r.count != null && n >= r.count) return false;
      n++;                                     // COUNT counts every occurrence, shown or not
      if (ms > to) return false;
      if (endOf(e, ms) >= from && e.exdates.indexOf(ms) === -1) out.push(ms);
      return true;
    }
    var y = w.y, mo = w.mo, d = w.d, CAP = 2000;
    if (r.freq === "DAILY") {
      for (var t = at(y, mo, d); iter < CAP; t = at(y, mo, d += r.interval)) { if (!emit(t)) break; }
    } else if (r.freq === "WEEKLY") {
      var days = (r.byday && r.byday.length) ? r.byday.map(function (b) { return b.d; }) : [new Date(at(y, mo, d)).getDay()];
      var wk = new Date(y, mo, d); wk.setDate(wk.getDate() - wk.getDay());   // Sunday of DTSTART's week
      var first = true;
      while (iter < CAP) {
        var stop = false;
        for (var i = 0; i < 7 && !stop; i++) {
          if (days.indexOf(i) === -1) continue;
          var ms = at(wk.getFullYear(), wk.getMonth(), wk.getDate() + i);
          if (first && ms < s.ms) continue;       // the part of week one before DTSTART
          if (!emit(ms)) stop = true;
        }
        if (stop) break;
        first = false;
        wk.setDate(wk.getDate() + 7 * r.interval);
      }
    } else if (r.freq === "MONTHLY") {
      var bd = r.byday && r.byday.length ? r.byday[0] : null;
      for (var mI = 0; iter < CAP; mI += r.interval) {
        var ms2;
        if (bd) ms2 = nthWeekday(y, mo + mI, bd.n, bd.d, at);
        else {
          var dom = r.bymonthday || d;
          var probe = new Date(y, mo + mI, 1);
          var last = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
          ms2 = dom <= last ? at(probe.getFullYear(), probe.getMonth(), dom) : null;
        }
        if (ms2 == null) { iter++; if (iter >= CAP) break; continue; }
        if (ms2 < s.ms) continue;
        if (!emit(ms2)) break;
      }
    } else if (r.freq === "YEARLY") {
      for (var yI = 0; iter < CAP; yI += r.interval) { if (!emit(at(y + yI, mo, d))) break; }
    } else {
      return [s.ms];                             // unsupported FREQ: the first instance only
    }
    return out;
  }

  function nthWeekday(y, mo, n, wd, at) {
    var first = new Date(y, mo, 1), days = new Date(y, mo + 1, 0).getDate();
    if (n >= 0) {
      var off = (wd - first.getDay() + 7) % 7, dom = 1 + off + (Math.max(1, n) - 1) * 7;
      return dom <= days ? at(first.getFullYear(), first.getMonth(), dom) : null;
    }
    var lastDay = new Date(y, mo, days), back = (lastDay.getDay() - wd + 7) % 7;
    var dom2 = days - back + (n + 1) * 7;
    return dom2 >= 1 ? at(first.getFullYear(), first.getMonth(), dom2) : null;
  }

  function wall(ms, tz) {
    var o = {};
    dtf(tz).formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month - 1, d: +o.day, hh: +o.hour % 24, mi: +o.minute, ss: +o.second };
  }

  /* Event instances inside [from, to], sorted by start: { title, location, start, end,
     allDay, uid }. Overrides (RECURRENCE-ID) replace the instance they name. */
  function expand(events, from, to) {
    var overrides = {};
    events.forEach(function (e) {
      if (e.recurrenceId && e.uid) overrides[e.uid + "@" + e.recurrenceId.ms] = e;
    });
    var out = [];
    events.forEach(function (e) {
      if (e.recurrenceId) {
        if (e.start.ms <= to && endOf(e, e.start.ms) >= from) out.push(instance(e, e.start.ms));
        return;
      }
      occurrences(e, from, to).forEach(function (ms) {
        if (e.uid && overrides[e.uid + "@" + ms]) return;   // replaced by its override
        out.push(instance(e, ms));
      });
    });
    out.sort(function (a, b) { return a.start - b.start || (a.allDay ? -1 : 1); });
    return out;
  }

  function instance(e, startMs) {
    return { title: e.title || "(untitled)", location: e.location || "",
             start: startMs, end: endOf(e, startMs), allDay: !!e.start.allDay, uid: e.uid || "" };
  }

  WP.ics = { parse: parse, expand: expand, parseDate: parseDate, parseDuration: parseDuration,
             parseRRule: parseRRule, unfold: unfold };
})();
