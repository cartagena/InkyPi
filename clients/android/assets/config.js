/* ============================================================
   INKY OLED — CONFIG
   Edit this file, rebuild, reinstall. It is the only file you
   should normally need to touch.
   ============================================================ */

window.CONFIG = {

  // ---- LOCATION (required for weather) --------------------
  // !! CHANGE THESE !! Currently a placeholder used for testing.
  // Find your own at https://www.latlong.net/
  // Set latitude/longitude to null to show a "set your location" notice instead.
  location: {
    name: "Seattle",
    latitude:  47.6062,
    longitude: -122.3321,
  },

  // "fahrenheit" or "celsius"
  units: "fahrenheit",

  // 12 or 24 hour clock
  clockHours: 12,

  // ---- PLUGINS --------------------------------------------
  // Turn cards on/off. Order here is the order they render.
  // Add "sensors" once Home Assistant is configured below.
  plugins: ["clock", "weather", "forecast"],

  // ---- HOME ASSISTANT (optional) --------------------------
  // Shows your own sensors — e.g. the ESP32 room nodes — instead of only outdoor weather.
  //
  // token: create a Long-Lived Access Token in HA under
  //        Profile -> Security -> Long-Lived Access Tokens.
  //
  // !! The token grants full API access to your Home Assistant. It is stored in plain
  //    text inside the APK. Only sideload this build onto your own device, and never
  //    commit a real token — the repo's pre-commit scanner will block it anyway.
  homeAssistant: {
    enabled: false,
    baseUrl: "http://homeassistant.local:8123",  // or http://<ha-ip>:8123
    token: "",                                    // paste your long-lived token
    refreshSeconds: 60,
    // Each entry becomes a tile. Find entity ids in HA under Developer Tools -> States.
    entities: [
      { id: "sensor.living_room_temperature", label: "Living room", unit: "°F" },
      { id: "sensor.bedroom_temperature",     label: "Bedroom",     unit: "°F" },
      { id: "sensor.outside_temperature",     label: "Outside",     unit: "°F" },
    ],
  },

  // ---- REFRESH --------------------------------------------
  weatherRefreshMinutes: 15,

  // ---- BURN-IN PROTECTION ---------------------------------
  // This panel is AMOLED. Static content ghosts permanently.
  // The whole layout drifts a few pixels on a slow cycle so no element
  // sits on the same pixels for hours. Costs nothing, invisible in use.
  burnInProtection: {
    enabled: true,
    maxShiftPx: 12,        // how far it drifts
    intervalSeconds: 120,  // how often it moves
  },
};
