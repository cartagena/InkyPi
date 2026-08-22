/* A stand-in for MainActivity's @JavascriptInterface object.

   The shape here is the contract between Bridge.deviceInfo() in MainActivity.java and the
   Device widget in widgets.js. Nothing on the JS side can test the Java side, but this does
   pin the shape: if the Java snapshot ever stops carrying battery.level or storage.free,
   the widget tests below start failing instead of the wall quietly reading "n/a". */

"use strict";

function make(over) {
  over = over || {};
  var prefs = Object.assign(Object.create(null), over.prefs || {});
  var snapshot = {
    battery: Object.assign({
      level: 74, charging: false, status: "Discharging", plugged: "",
      health: "Good", technology: "Li-ion", voltageMv: 4102, tempC: 28.4
    }, over.battery || (over.charging ? { charging: true, plugged: "AC", status: "Charging" } : {})),
    storage: Object.assign({
      total: 128 * 1024 * 1024 * 1024,
      free: 41 * 1024 * 1024 * 1024,
      blockSize: 4096,
      appFree: 41 * 1024 * 1024 * 1024
    }, over.storage || {}),
    memory: Object.assign({
      total: 6 * 1024 * 1024 * 1024, free: 2 * 1024 * 1024 * 1024,
      low: false, threshold: 256 * 1024 * 1024
    }, over.memory || {}),
    network: Object.assign({
      type: "Wi-Fi", validated: true, metered: false,
      iface: "wlan0", downKbps: 144000, upKbps: 72000
    }, over.network || {}),
    device: Object.assign({
      model: "TEST-PANEL", manufacturer: "testco", android: "13", sdk: 33,
      screen: "1600x2560", density: 280
    }, over.device || {}),
    uptimeMs: over.uptimeMs == null ? 3 * 86400000 + 4 * 3600000 : over.uptimeMs,
    awakeMs: over.awakeMs == null ? 2 * 86400000 : over.awakeMs,
    brightness: over.brightness == null ? 128 : over.brightness,
    now: over.now == null ? 0 : over.now
  };

  var calls = [];
  var bridge = {
    calls: calls,
    snapshot: snapshot,
    deviceInfo: function () {
      calls.push("deviceInfo");
      if (over.broken) return "not json at all";
      return JSON.stringify(snapshot);
    },
    getPref: function (k) {
      calls.push("getPref:" + k);
      return prefs[k] === undefined ? null : prefs[k];
    },
    setPref: function (k, v) {
      calls.push("setPref:" + k);
      prefs[k] = String(v);
    },
    prefs: prefs
  };

  /* Opt-in network half of the bridge (MainActivity's fetchOrigins/httpFetch). Off by
     default so every existing test keeps exercising the no-bridge fallback paths. */
  if (over.net) {
    bridge.lockedOrigins = null;
    bridge.fetchCalls = [];
    bridge.fetchOrigins = function (json) {
      calls.push("fetchOrigins");
      if (bridge.lockedOrigins !== null) return false;   // first write wins, like Java
      bridge.lockedOrigins = JSON.parse(json);
      return true;
    };
    bridge.httpFetch = function (id, url, headersJson, method, body) {
      calls.push("httpFetch:" + method + ":" + url);
      bridge.fetchCalls.push({ id: id, url: url,
        headers: JSON.parse(headersJson || "{}"), method: method, body: body });
    };
  }
  return bridge;
}

module.exports = { make: make };
