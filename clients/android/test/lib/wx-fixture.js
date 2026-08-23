/* A synthetic Open-Meteo payload, in the exact shape the real API returns with
   timezone=auto (local ISO stamps, no offset suffix).

   THE ONE DELIBERATE PROPERTY: current.temperature_2m is NOT the hourly bucket.

   This fixture used to build `current.temperature_2m = temp[idx]` — literally the hourly
   value — "so that a test can say the Now card and the NOW chip must agree and mean it".
   It meant the exact opposite. With the two pinned equal, the card and the chip agree no
   matter WHICH array the card reads, so the invariant could not fail and did not: the
   desync was live on the wall (91° card, 90° chip) with the test green.

   The real API is not like that. `current` is interpolated to the minute the request was
   made; `hourly[i]` is the value at the top of the hour. They differ by a degree or two,
   always, for every request. CURRENT_SKEW reproduces that, so a card sourced from the
   wrong array now shows a different number from the strip and the test says so.
   Everything else is arbitrary but plausible and deterministic. */

"use strict";

/* how far `current` sits from its own hourly bucket — see above */
var CURRENT_SKEW = 3;

function pad(n) { return ("0" + n).slice(-2); }

function localIso(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + "T" + pad(d.getHours()) + ":00";
}
function localDay(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/* temperature for a given absolute hour — distinct for every hour so a card reading the
   wrong bucket is visible rather than a coincidence */
function tempAt(hourIndex) { return 60 + (hourIndex % 24); }

function build(opts) {
  opts = opts || {};
  var now = opts.now == null ? Date.now() : opts.now;
  var hours = opts.hours || 24 * 7;      // forecast_days=7, like the real request
  /* start at midnight of the current local day, so index === hour for day one */
  var d0 = new Date(now);
  var start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, 0, 0, 0);

  var time = [], temp = [], app = [], hum = [], dew = [], pop = [], precip = [];
  var code = [], cloud = [], vis = [], wind = [], dir = [], uv = [], isDay = [];
  for (var i = 0; i < hours; i++) {
    var t = new Date(start.getTime() + i * 3600000);
    time.push(localIso(t));
    temp.push(tempAt(i));
    app.push(tempAt(i) - 2);
    hum.push(40 + (i % 30));
    dew.push(50 + (i % 8));
    pop.push((i * 7) % 100);
    precip.push((i % 5) / 100);
    code.push([0, 1, 2, 3, 61, 95][i % 6]);
    cloud.push((i * 11) % 100);
    vis.push(10000 + i * 10);
    wind.push(3 + (i % 12));
    dir.push((i * 23) % 360);
    uv.push((i % 12) / 2);
    isDay.push(t.getHours() >= 6 && t.getHours() < 20 ? 1 : 0);
  }

  var days = Math.ceil(hours / 24);
  var dTime = [], dCode = [], dMax = [], dMin = [], dAMax = [], dAMin = [];
  var sunrise = [], sunset = [], daylight = [], uvMax = [], pSum = [], pMax = [];
  var wMax = [], gMax = [], wDir = [];
  for (var k = 0; k < days; k++) {
    var day = new Date(start.getTime() + k * 86400000);
    dTime.push(localDay(day));
    dCode.push([0, 2, 61, 95, 3, 1, 71][k % 7]);
    dMax.push(78 + k);
    dMin.push(58 + k);
    dAMax.push(80 + k);
    dAMin.push(56 + k);
    sunrise.push(localDay(day) + "T05:4" + (k % 10));
    sunset.push(localDay(day) + "T20:1" + (k % 10));
    daylight.push(51840 + k * 60);
    uvMax.push(7 + (k % 3));
    pSum.push(k % 3 ? 0 : 0.12);
    pMax.push((k * 13) % 100);
    wMax.push(12 + k);
    gMax.push(21 + k);
    wDir.push((k * 40) % 360);
  }

  var idx = Math.floor((now - start.getTime()) / 3600000);
  var base = temp[idx] == null ? temp[0] : temp[idx];
  var cur = {
    time: localIso(new Date(now)),
    /* + CURRENT_SKEW: the minute-interpolated reading, deliberately not the hourly
       bucket. See the header — this is what makes the Now/NOW invariant falsifiable. */
    temperature_2m: base + CURRENT_SKEW,
    relative_humidity_2m: 48,
    apparent_temperature: base - 2 + CURRENT_SKEW,
    is_day: isDay[idx] == null ? 1 : isDay[idx],
    precipitation: 0,
    weather_code: code[idx] == null ? 0 : code[idx],
    cloud_cover: 22,
    pressure_msl: 1013,
    surface_pressure: 1009,
    wind_speed_10m: 6,
    wind_direction_10m: 250,
    wind_gusts_10m: 14
  };
  if (opts.current) Object.assign(cur, opts.current);

  return {
    latitude: 10, longitude: 20, timezone: "auto",
    current: cur,
    hourly: {
      time: time, temperature_2m: temp, apparent_temperature: app,
      relative_humidity_2m: hum, dew_point_2m: dew,
      precipitation_probability: pop, precipitation: precip,
      weather_code: code, cloud_cover: cloud, visibility: vis,
      wind_speed_10m: wind, wind_direction_10m: dir, uv_index: uv, is_day: isDay
    },
    daily: {
      time: dTime, weather_code: dCode,
      temperature_2m_max: dMax, temperature_2m_min: dMin,
      apparent_temperature_max: dAMax, apparent_temperature_min: dAMin,
      sunrise: sunrise, sunset: sunset, daylight_duration: daylight,
      uv_index_max: uvMax, precipitation_sum: pSum,
      precipitation_probability_max: pMax, wind_speed_10m_max: wMax,
      wind_gusts_10m_max: gMax, wind_direction_10m_dominant: wDir
    }
  };
}

/* A fetch stub that always answers with a payload built for the *current* virtual time,
   which is what a real refetch after an hour rollover would return. The harness hands the
   clock to the stub as a third argument. */
function serve(opts) {
  var served = [];
  function impl(url, init, clock) {
    var body = build(Object.assign({ now: clock.now }, opts || {}));
    served.push(body);
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(body); }
    });
  }
  impl.served = served;
  return impl;
}

/* what the *hourly* bucket says for a given hour — the wall panel's source of truth */
function feelsAt(hourIndex) { return tempAt(hourIndex) - 2; }


/* A small Open-Meteo air-quality payload, shaped like the real endpoint answers.
   AQI 42 = "Good": green, and low enough that no health-warning copy renders. */
function aqi(opts) {
  opts = opts || {};
  var now = opts.now || Date.now();
  var t0 = new Date(now); t0.setMinutes(0, 0, 0);
  var times = [], vals = [];
  for (var i = 0; i < 48; i++) {
    times.push(new Date(t0.getTime() + i * 3600000).toISOString().slice(0, 16));
    vals.push(40 + (i % 7));
  }
  return {
    current: {
      us_aqi: opts.us_aqi != null ? opts.us_aqi : 42,
      pm2_5: 8.1, pm10: 15.2, ozone: 61, nitrogen_dioxide: 9.3,
      sulphur_dioxide: 1.2, carbon_monoxide: 143
    },
    hourly: { time: times, us_aqi: vals }
  };
}

module.exports = {
  build: build, serve: serve, tempAt: tempAt, feelsAt: feelsAt, localIso: localIso,
  CURRENT_SKEW: CURRENT_SKEW, aqi: aqi };
