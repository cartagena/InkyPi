/* Wall panel dashboard — WEATHER ICONS (colored SVG).

   Replaces the U+2600 text glyphs. Those existed to dodge Android's emoji sprites: any
   codepoint with emoji-presentation rendered as a full-colour bitmap the app had no say
   over, so the safe set was monochrome text symbols. Drawing the icons ourselves removes
   the constraint the monochrome rule existed for — every colour below is a token from
   style.css (--ic-*), so the palette is decided in exactly one place and the icons follow
   the theme, not the font.

   Every composite is assembled from a small set of primitives (sun, moon, cloud, drops,
   flakes, bolt, fog) so the 28 WMO codes stay one drawing style. viewBox is 64x64 and the
   svg is sized 1em x 1em: the icon inherits its size from the type ramp exactly like the
   glyph it replaced — no icon authors its own size.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  /* ---------------- primitives ----------------
     All colours are var(--ic-*) references — a literal hex here is a test failure
     (icons.test.js), because it would fork the palette away from style.css. */

  function sun(cx, cy, r) {
    var rays = "";
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI / 4) * i + Math.PI / 8;
      var x1 = cx + Math.cos(a) * (r + 3), y1 = cy + Math.sin(a) * (r + 3);
      var x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
      rays += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1)
        + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    return '<g stroke="var(--ic-ray)" stroke-width="3.5" stroke-linecap="round">' + rays
      + '</g><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--ic-sun)"/>';
  }

  /* Crescent between an outer circular arc and an inner elliptical terminator.
     p is the synodic phase 0..1 (0 = new). Shared with the Moon widget so the icon in the
     tile and the big disc in the panel are literally the same shape. */
  function moonPath(cx, cy, r, p) {
    var c = Math.cos(2 * Math.PI * p);        // +1 new … 0 quarter … -1 full
    var waxing = p < 0.5;
    var rx = (Math.abs(c) * r).toFixed(2);
    var outer = waxing ? 1 : 0;               // lit limb: right when waxing, left waning
    var inner = waxing ? (c > 0 ? 0 : 1) : (c > 0 ? 1 : 0);
    return "M " + cx + " " + (cy - r)
      + " A " + r + " " + r + " 0 0 " + outer + " " + cx + " " + (cy + r)
      + " A " + rx + " " + r + " 0 0 " + inner + " " + cx + " " + (cy - r) + " Z";
  }

  /* The icon moon is a fixed pleasant crescent, not the live phase — at 2.9vh nobody can
     read a gibbous from a quarter, and the Moon tile shows the real phase. */
  function moon(cx, cy, r) {
    return '<path d="' + moonPath(cx, cy, r, 0.18) + '" fill="var(--ic-moon)"/>';
  }

  function star(cx, cy, s) {
    return '<path d="M ' + cx + " " + (cy - s) + " L " + (cx + s * 0.35) + " " + (cy - s * 0.35)
      + " L " + (cx + s) + " " + cy + " L " + (cx + s * 0.35) + " " + (cy + s * 0.35)
      + " L " + cx + " " + (cy + s) + " L " + (cx - s * 0.35) + " " + (cy + s * 0.35)
      + " L " + (cx - s) + " " + cy + " L " + (cx - s * 0.35) + " " + (cy - s * 0.35)
      + ' Z" fill="var(--ic-star)"/>';
  }

  /* Three discs and a slab, one fill: overlaps vanish because the colour is flat. */
  function cloud(dx, dy, s, tone) {
    return '<g fill="var(--ic-' + (tone || "cloud") + ')" transform="translate(' + dx + " " + dy
      + ") scale(" + s + ')">'
      + '<circle cx="22" cy="36" r="10"/><circle cx="33" cy="29" r="12"/>'
      + '<circle cx="44" cy="37" r="9"/><rect x="21" y="33" width="24" height="13" rx="6.5"/>'
      + "</g>";
  }

  function drops(n, len, y) {
    var xs = n === 2 ? [26, 38] : [22, 32, 42];
    return '<g stroke="var(--ic-rain)" stroke-width="3.5" stroke-linecap="round">'
      + xs.map(function (x) {
        return '<line x1="' + x + '" y1="' + y + '" x2="' + (x - 3) + '" y2="' + (y + len) + '"/>';
      }).join("") + "</g>";
  }

  function flakes(n, y) {
    var xs = n === 2 ? [26, 38] : [22, 32, 42];
    return '<g stroke="var(--ic-snow)" stroke-width="2.5" stroke-linecap="round">'
      + xs.map(function (x, i) {
        var cy = y + (i === 1 ? 4 : 0);
        return '<line x1="' + (x - 3) + '" y1="' + cy + '" x2="' + (x + 3) + '" y2="' + cy + '"/>'
          + '<line x1="' + x + '" y1="' + (cy - 3) + '" x2="' + x + '" y2="' + (cy + 3) + '"/>'
          + '<line x1="' + (x - 2.2) + '" y1="' + (cy - 2.2) + '" x2="' + (x + 2.2) + '" y2="' + (cy + 2.2) + '"/>'
          + '<line x1="' + (x - 2.2) + '" y1="' + (cy + 2.2) + '" x2="' + (x + 2.2) + '" y2="' + (cy - 2.2) + '"/>';
      }).join("") + "</g>";
  }

  function bolt() {
    return '<path d="M 34 40 L 27 52 L 33 52 L 29 62 L 40 48 L 34 48 L 38 40 Z" fill="var(--ic-bolt)"/>';
  }

  function fog(y) {
    var rows = "";
    for (var i = 0; i < 3; i++) {
      rows += '<line x1="' + (16 + (i % 2) * 4) + '" y1="' + (y + i * 6)
        + '" x2="' + (44 + (i % 2) * 4) + '" y2="' + (y + i * 6) + '"/>';
    }
    return '<g stroke="var(--ic-fog)" stroke-width="3.5" stroke-linecap="round">' + rows + "</g>";
  }

  function wrap(inner) {
    return '<svg class="wxi" viewBox="0 0 64 64" aria-hidden="true">' + inner + "</svg>";
  }

  /* ---------------- composites per WMO group ---------------- */

  var clearDay = sun(32, 32, 11);
  var clearNight = moon(30, 32, 13) + star(48, 18, 3.5) + star(52, 34, 2.5);
  var partlyDay = sun(22, 22, 8.5) + cloud(6, 6, 0.95);
  var partlyNight = moon(21, 21, 9) + star(52, 14, 2.5) + cloud(6, 6, 0.95);
  var overcast = cloud(12, -8, 0.8, "cloud-dk") + cloud(0, 4, 1.0);
  var foggy = cloud(2, -8, 0.85) + fog(44);
  var drizzle = cloud(2, -8, 0.95) + drops(2, 6, 48);
  var rain = cloud(2, -8, 0.95) + drops(3, 9, 47);
  /* one drop beside one flake: rain that freezes */
  var freezing = cloud(2, -8, 0.95)
    + '<g stroke="var(--ic-rain)" stroke-width="3.5" stroke-linecap="round">'
    + '<line x1="25" y1="47" x2="22" y2="56"/></g>'
    + '<g stroke="var(--ic-snow)" stroke-width="2.5" stroke-linecap="round">'
    + '<line x1="36" y1="51" x2="44" y2="51"/><line x1="40" y1="47" x2="40" y2="55"/>'
    + '<line x1="37.2" y1="48.2" x2="42.8" y2="53.8"/><line x1="37.2" y1="53.8" x2="42.8" y2="48.2"/>'
    + "</g>";
  var snow = cloud(2, -8, 0.95) + flakes(3, 51);
  var showersDay = sun(20, 16, 7) + cloud(4, -6, 0.95) + drops(3, 8, 48);
  var showersNight = moon(19, 15, 7.5) + cloud(4, -6, 0.95) + drops(3, 8, 48);
  var storm = cloud(2, -10, 1.0, "cloud-dk") + bolt();
  var stormRain = cloud(2, -10, 1.0, "cloud-dk") + bolt()
    + '<g stroke="var(--ic-rain)" stroke-width="3.5" stroke-linecap="round">'
    + '<line x1="20" y1="44" x2="17" y2="52"/><line x1="46" y1="44" x2="43" y2="52"/></g>';
  var snowShowersDay = sun(20, 16, 7) + cloud(4, -6, 0.95) + flakes(2, 52);
  var snowShowersNight = moon(19, 15, 7.5) + cloud(4, -6, 0.95) + flakes(2, 52);

  /* code -> [day icon, night icon]; text stays in app.js's WMO table. */
  var ICONS = {
    0: [clearDay, clearNight], 1: [clearDay, clearNight],
    2: [partlyDay, partlyNight], 3: [overcast, overcast],
    45: [foggy, foggy], 48: [foggy, foggy],
    51: [drizzle, drizzle], 53: [drizzle, drizzle], 55: [rain, rain],
    56: [freezing, freezing], 57: [freezing, freezing],
    61: [rain, rain], 63: [rain, rain], 65: [rain, rain],
    66: [freezing, freezing], 67: [freezing, freezing],
    71: [snow, snow], 73: [snow, snow], 75: [snow, snow], 77: [snow, snow],
    80: [showersDay, showersNight], 81: [showersDay, showersNight],
    82: [stormRain, stormRain],
    85: [snowShowersDay, snowShowersNight], 86: [snowShowersDay, snowShowersNight],
    95: [storm, storm], 96: [stormRain, stormRain], 99: [stormRain, stormRain]
  };
  var UNKNOWN = wrap('<circle cx="32" cy="32" r="4" fill="var(--ic-fog)"/>');

  WP.wxIcon = function (code, night) {
    var e = ICONS[code];
    return e ? wrap(night ? e[1] : e[0]) : UNKNOWN;
  };
  /* Exposed for the Moon widget and for the tests. */
  WP.wxIcon.moonPath = moonPath;
  WP.wxIcon.codes = Object.keys(ICONS).map(Number);
})();
