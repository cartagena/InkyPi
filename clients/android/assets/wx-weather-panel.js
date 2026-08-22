/* Wall panel dashboard — THE CONDITIONS PANEL'S TWO PICTURES.

   The sun arc and the rain section: the two parts of the Conditions screen that are drawn
   rather than tabulated, and between them the two longest things wx-weather.js held. They
   moved out for the 500-line file budget the same way the sensors panel did, and the seam
   is an honest one — nothing here touches the payload, the cache or the fetch cadence.
   Both take finished values and hand back HTML.

   Loaded before wx-weather.js, which reads these two names off WP at parse time.
*/

(function () {
  "use strict";

  var esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section;

  /* ---------------- the rain section ----------------
     On a dry week this section printed "0 in", "0%", "0 in / 0% chance" — nine zeros in
     three cells, under a heading, on a panel read from across a room. In El Cajon that is
     the state of the screen for months at a time. Three cells of zero are not three facts;
     they are one fact, and the fact is "no". So when there is nothing falling and nothing
     forecast, the section says the one thing worth saying and gives its height back — and
     when there IS something, it says WHEN, which is what the zeros never did. The grid
     comes back the moment rain is real (falling now, likely within the hour, or any
     measured total today), because then the three figures genuinely differ. */
  /* THE DAY'S LIGHT, AS ONE PICTURE rather than three labelled cells.

     SUN was SUNRISE / SUNSET / DAYLIGHT: three grey caps over three white figures, the
     same shape as AIR above it and WIND above that, which is what kept this panel reading
     as a spec sheet however much colour was put on it. The three facts are one fact — the
     shape of the day — and a shape is a thing to draw. So: the sun's own path from the
     horizon at sunrise to the horizon at sunset, the part already flown picked out in warm
     light and the rest left as track, and the sun itself where the hour actually is. The
     two times stay at the ends they belong to; the day's length captions the apex.

     The curve is a quadratic and the lit part is the SAME curve split at t with de
     Casteljau, not a dash approximating it — so the marker and the end of the lit arc are
     one point by construction and cannot drift apart at the ends of the day.

     The marker and the labels are HTML, for the reason the hourly chart's are: the box is
     stretched to a declared height, so anything round drawn inside the viewBox would come
     out an ellipse and any text in it would need a size authored outside the ramp. */
  function sunArc(rise, set, dayLen) {
    var P0 = [5, 30], P1 = [50, -18], P2 = [95, 30];   /* ends on the horizon, apex at 6 */
    function mid(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    function quad(a, b, c) {
      return "M " + a[0].toFixed(1) + " " + a[1].toFixed(1)
        + " Q " + b[0].toFixed(1) + " " + b[1].toFixed(1)
        + " " + c[0].toFixed(1) + " " + c[1].toFixed(1);
    }
    var t = (rise && set && set > rise) ? (Date.now() - rise) / (set - rise) : -1;
    var up = t > 0 && t < 1;
    var A = mid(P0, P1, t), B = mid(P1, P2, t), C = mid(A, B, t);
    /* AND THE NIGHT HAS A MARKER TOO. With the sun down this was a hairline grey arc with
       no gold on it and two gold clock times printed underneath, as if something up there
       were pointing at them — a chart with a legend and no plot, which a capture review
       read, correctly, as broken. Below the horizon is a POSITION, not an absence: the
       marker stays, unlit, under the line at whichever end of the day it is nearest, and
       the caption says where the sun is rather than quoting a daylight total for a day
       that is either over or has not started. */
    var restX = t >= 1 ? P2[0] : P0[0];
    return '<div class="sunarc' + (up ? "" : " down") + '"><div class="sun-plot">'
      + '<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">'
      + '<line class="sun-hz" x1="0" y1="30" x2="100" y2="30"/>'
      + '<path class="sun-track" d="' + quad(P0, P1, P2) + '"/>'
      + (up ? '<path class="sun-flown" d="' + quad(P0, A, C) + '"/>' : "")
      + "</svg>"
      + (up ? '<span class="sun-dot" style="left:' + C[0].toFixed(1) + "%;top:"
          + (C[1] / 34 * 100).toFixed(1) + '%"></span>'
          : '<span class="sun-dot rest" style="left:' + restX.toFixed(1)
          + '%;top:100%"></span>')
      + "</div>"
      + '<div class="sun-ends"><span class="sunlit">'
      + (rise ? esc(fmt.clock(new Date(rise), false)) : "--") + "</span>"
      + '<span class="sun-len">'
      + (up ? esc(dayLen) + " of daylight" : "below the horizon") + "</span>"
      + '<span class="sunlit">' + (set ? esc(fmt.clock(new Date(set), false)) : "--")
      + "</span></div></div>";
  }

  function rainSection(cur, h, day, i) {
    /* The heading follows the code, so a snowy hour is not filed under RAIN. */
    var W = fmt.precipWord(cur.weather_code);
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
          /* THAT day's word, not today's: the section is about the day it names. */
          var w2 = fmt.precipWord(day.weather_code && day.weather_code[k]);
          return section(w2, '<div class="muted">Next ' + w2.toLowerCase() + ": "
            + esc(when.toLocaleDateString(undefined, { weekday: "long" }))
            + ", " + Math.round(pops[k]) + "% chance.</div>");
        }
      }
      return section(W, '<div class="muted">None forecast in the next '
        + Math.max(1, pops.length) + " days.</div>");
    }

    /* Three cells, not four. Four in a three-across grid left one cell alone on a second
       row with a hairline stopping at a third of the width, which reads as a section that
       failed to finish. The two "today" facts are one thought, so they are one cell: the
       total on the value line, the chance on the line under it. */
    /* Rain figures wear rain's colour once they mean something, exactly as the hourly
       strip's chance-of-rain figures already do (.hr-p.wet) — a section that only appears
       when it is going to rain should not be printed in the same white as the pressure. */
    function wet3(v, on) { return on ? '<span class="wet">' + v + "</span>" : v; }
    return section(W, statGrid([
      ["Right now", wet3((cur.precipitation || 0) + " " + fmt.precipUnit(),
        (cur.precipitation || 0) > 0)],
      ["Next hour", wet3(nextHour + "%", nextHour >= 30)],
      ["Today", wet3((Math.round(todaySum * 100) / 100) + " " + fmt.precipUnit(), todaySum > 0),
        (day && day.precipitation_probability_max)
          ? Math.round(day.precipitation_probability_max[0]) + "% chance" : ""]
    ], 3));
  }
  WP.wxPanel = { sunArc: sunArc, rainSection: rainSection };
})();
