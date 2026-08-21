/* Simulator stand-in for MainActivity's window.Android bridge, plus scenario injection.
   Injected before config.js, so it is in place before the app's first line runs.

   Two jobs:
     1. be the Java shell: deviceInfo(), get/setPref, fetchOrigins/httpFetch (the last
        riding the sim server's /__proxy, which fetches server-side — the same CORS-free
        behaviour the real shell gives the page).
     2. be the WORLD: SIM.scenario decides what the network says back, so states that are
        otherwise unreachable on a desk — a thunderstorm, 3am, a dead wifi, a Home
        Assistant that 401s at midnight — are one switch away. */
(function () {
  "use strict";

  var bootAt = Date.now();

  var SIM = window.SIM = {
    scenario: {
      weather: "live",     // live | clear-day | clear-night | rain | snow | storm | fog
      net: "ok",           // ok | offline | slow
      ha: "demo",          // demo | live-ok | live-401 | live-down
      news: "ok",          // ok | empty | fail
      aqi: "live",         // live, or a number: the reading to force (0-500)
      battery: 83,
      charging: true
    },
    set: function (k, v) { SIM.scenario[k] = v; return SIM.scenario; },
    log: []
  };

  /* ---------------- the Java shell ---------------- */

  function snapshot() {
    var up = 3 * 86400000 + 4 * 3600000 + (Date.now() - bootAt);
    var s = SIM.scenario;
    return {
      battery: { level: s.battery, charging: s.charging,
                 status: s.charging ? "Charging" : "Discharging",
                 plugged: s.charging ? "AC" : "", health: "Good",
                 technology: "Li-ion", voltageMv: 4210, tempC: 27.8 },
      storage: { total: 128 * 1024 * 1024 * 1024, free: 104 * 1024 * 1024 * 1024,
                 blockSize: 4096, appFree: 104 * 1024 * 1024 * 1024 },
      memory: { total: 6442450944, free: 2147483648, low: false, threshold: 268435456 },
      network: s.net === "offline"
        ? { type: "None", validated: false, metered: false, iface: "", downKbps: 0, upKbps: 0 }
        : { type: "Wi-Fi", validated: true, metered: false,
            iface: "wlan0", downKbps: 144000, upKbps: 72000 },
      device: { model: "SM-T860 (sim)", manufacturer: "samsung", android: "16", sdk: 36,
                screen: "1600x2560", density: 360 },
      uptimeMs: up, awakeMs: Math.round(up * 0.6),
      brightness: 128, now: Date.now()
    };
  }

  /* WMO code + day/night the chosen scene implies, or null to leave the real data alone */
  var SCENES = {
    "clear-day":   { code: 0,  day: 1 },
    "clear-night": { code: 0,  day: 0 },
    "rain":        { code: 63, day: 1, pop: 85, precip: 2.4 },
    "snow":        { code: 73, day: 1, pop: 90, precip: 1.1 },
    "storm":       { code: 95, day: 1, pop: 95, precip: 6.2 },
    "fog":         { code: 45, day: 1 }
  };

  /* Rewrite a real Open-Meteo payload into the requested weather, leaving every other
     field (temperatures, sun times, the shape) exactly as the API really answered — so
     what renders is a real payload in a different mood, not a hand-written fixture. */
  function applyScene(json) {
    var sc = SCENES[SIM.scenario.weather];
    if (!sc || !json) return json;
    if (json.current) {
      json.current.weather_code = sc.code;
      json.current.is_day = sc.day;
      if (sc.precip != null) json.current.precipitation = sc.precip;
    }
    if (json.hourly && json.hourly.weather_code) {
      json.hourly.weather_code = json.hourly.weather_code.map(function () { return sc.code; });
      if (json.hourly.is_day) json.hourly.is_day = json.hourly.is_day.map(function () { return sc.day; });
      if (sc.pop && json.hourly.precipitation_probability) {
        json.hourly.precipitation_probability =
          json.hourly.precipitation_probability.map(function (_, i) {
            return Math.max(0, sc.pop - (i % 12) * 6);        // a believable curve
          });
      }
      if (sc.precip && json.hourly.precipitation) {
        json.hourly.precipitation = json.hourly.precipitation.map(function () { return sc.precip; });
      }
    }
    if (json.daily && json.daily.weather_code) {
      json.daily.weather_code = json.daily.weather_code.map(function () { return sc.code; });
    }
    return json;
  }

  /* The page fetches weather and air quality directly (they are CORS-clean); intercept so
     the scenarios reach them too. Everything else passes straight through. */
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, init) {
    var u = String(url);
    if (SIM.scenario.net === "offline") {
      SIM.log.push("offline: blocked " + u.slice(0, 60));
      return Promise.reject(new TypeError("Failed to fetch (sim offline)"));
    }
    if (u.indexOf("//air-quality-api.open-meteo.com") !== -1) {
      return realFetch("/__proxy?u=" + encodeURIComponent(u), init).then(function (r) {
        var forced = parseFloat(SIM.scenario.aqi);
        if (isNaN(forced)) return r;
        /* Scale the whole real payload toward the requested reading rather than pasting a
           number in: the hero, the 24 h curve and every pollutant then stay consistent
           with each other, which is the thing a screenshot of "hazardous" has to prove. */
        return r.json().then(function (j) {
          var base = (j.current && j.current.us_aqi) || 50;
          var k = forced / base;
          if (j.current) {
            j.current.us_aqi = forced;
            ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide",
             "carbon_monoxide"].forEach(function (f) {
              if (typeof j.current[f] === "number") j.current[f] = j.current[f] * k;
            });
          }
          if (j.hourly && j.hourly.us_aqi) {
            j.hourly.us_aqi = j.hourly.us_aqi.map(function (v) { return v * k; });
          }
          return new Response(JSON.stringify(j), { status: r.status,
            headers: { "Content-Type": "application/json" } });
        });
      });
    }
    /* Host-anchored with "//", and the air-quality test moved ABOVE this one:
       "air-quality-api.open-meteo.com" CONTAINS "api.open-meteo.com", so a bare
       substring test here swallowed every air-quality request and handed it to the
       WEATHER rewriter. Forced AQI readings came back as the real one, and the panel
       could not be reviewed at the top of its scale at all. */
    if (u.indexOf("//api.open-meteo.com") !== -1) {
      return realFetch("/__proxy?u=" + encodeURIComponent(u), init).then(function (r) {
        return r.json().then(function (j) {
          var body = JSON.stringify(applyScene(j));
          return new Response(body, { status: r.status,
            headers: { "Content-Type": "application/json" } });
        });
      });
    }
    return realFetch(url, init);
  };

  window.Android = {
    deviceInfo: function () { return JSON.stringify(snapshot()); },
    getPref: function (k) {
      try { return window.localStorage.getItem("simpref." + k); } catch (e) { return null; }
    },
    setPref: function (k, v) {
      try { window.localStorage.setItem("simpref." + k, String(v)); } catch (e) {}
    },
    fetchOrigins: function () { return true; },

    httpFetch: function (id, url, headersJson, method, body) {
      var s = SIM.scenario;
      function fail(msg) {
        SIM.log.push("httpFetch " + msg + ": " + url.slice(0, 50));
        setTimeout(function () {
          if (window.WP && WP.bridgeFetch) WP.bridgeFetch._reject(id, msg);
        }, 10);
      }
      function answer(status, text) {
        setTimeout(function () {
          if (window.WP && WP.bridgeFetch) WP.bridgeFetch._resolve(id, status, btoa(unescape(encodeURIComponent(text))));
        }, 10);
      }
      if (s.net === "offline") return fail("sim offline");

      var isHA = /\/api\/(states|services)\//.test(url);
      if (isHA) {
        if (s.ha === "live-401") return answer(401, '{"message":"Invalid token"}');
        if (s.ha === "live-down") return fail("connect timed out");
        if (s.ha === "live-ok") {
          /* a believable Home Assistant, so live mode can be exercised with no HA box */
          var id2 = decodeURIComponent((url.split("/api/states/")[1] || "").split("?")[0]);
          var val = /humidity/.test(id2) ? "44" : /co2/.test(id2) ? "710"
                  : /power/.test(id2) ? "512" : /lamp|fan/.test(id2) ? "on"
                  : /door/.test(id2) ? "off" : (68 + Math.round(Math.random() * 8)).toFixed(1);
          return answer(200, JSON.stringify({
            entity_id: id2, state: val,
            attributes: { unit_of_measurement: /humidity/.test(id2) ? "%"
              : /co2/.test(id2) ? "ppm" : /power/.test(id2) ? "W" : "°F" },
            last_updated: new Date().toISOString()
          }));
        }
      }
      if (/rss|feeds|\.xml/.test(url)) {
        if (s.news === "fail") return fail("HTTP 503");
        if (s.news === "empty") return answer(200, '<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>');
      }

      var h = {};
      try { h = JSON.parse(headersJson || "{}"); } catch (e) {}
      var headers = {};
      Object.keys(h).forEach(function (k) { headers["X-Sim-" + k] = h[k]; });
      var init = { method: method === "POST" ? "POST" : "GET", headers: headers };
      if (init.method === "POST" && body != null) init.body = body;
      var delay = s.net === "slow" ? 3000 : 0;
      setTimeout(function () {
        realFetch("/__proxy?u=" + encodeURIComponent(url), init)
          .then(function (r) {
            return r.arrayBuffer().then(function (buf) {
              var bytes = new Uint8Array(buf), bin = "";
              for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
              if (window.WP && WP.bridgeFetch) WP.bridgeFetch._resolve(id, r.status, btoa(bin));
            });
          })
          .catch(function (e) { fail(String((e && e.message) || e)); });
      }, delay);
    }
  };

  /* Config overrides land before config.js defines window.CONFIG, so the app sees them
     as if they were edited into the file. Driven from the cockpit. */
  try {
    var over = JSON.parse(window.localStorage.getItem("sim.configOverride") || "null");
    if (over) {
      Object.defineProperty(window, "CONFIG", {
        configurable: true,
        set: function (v) {
          Object.keys(over).forEach(function (k) { v[k] = over[k]; });
          Object.defineProperty(window, "CONFIG", { value: v, writable: true, configurable: true });
        },
        get: function () { return undefined; }
      });
    }
    var sc = JSON.parse(window.localStorage.getItem("sim.scenario") || "null");
    if (sc) Object.keys(sc).forEach(function (k) { SIM.scenario[k] = sc[k]; });
  } catch (e) { /* the sim is not worth breaking the app over */ }
})();
