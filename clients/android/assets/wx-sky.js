/* Wall panel dashboard — SKY (animated background, the painters).

   A full-screen canvas behind the dashboard that draws what the weather is doing: the
   light of the actual hour, stars with real magnitudes, drifting cloud banks, rain leaning
   on the real wind, snow that drifts rather than falls, fog sitting on the floor of the
   frame, and a dim flash in a storm. This is the "the panel is a window" layer — it is why
   the theme is allowed to stay dark: the background is not empty, it is the weather.

   The LIGHT — which mood, which colour, where the bloom sits — is not decided here. It
   comes out of wx-sky-light.js, a pure function of (now, sunrise, sunset) tested at every
   phase boundary. This file only paints what that model says. The seam is deliberate: the
   painters can only be judged by looking at them, so the half that CAN be pinned by a test
   was moved somewhere a test can reach it.

   AMOLED rules the layer lives by:
     * everything moves — a canvas whose pixels never sit still cannot burn in, which is
       why the bloom tracks the sun across the frame and even the stars twinkle;
     * dim by construction — the alpha budget is stated and defended in wx-sky-light.js;
       nothing composited here exceeds ~0.25, and most of the frame stays true black;
     * 30 fps, not 60 — half the GPU work, invisible for weather;
     * it stops completely when the app is hidden or the switch in Settings is off.

   WHY IT SHIPS ON AGAIN: it shipped off after a round of grading called the starfield
   "dust on the glass or dead pixels", and that was a fair verdict on what was there — 110
   one-pixel rectangles, all the same size and brightness, which is what sensor noise looks
   like. A sky is not uniform: a few bright stars with a bloom and a great many faint ones
   is what makes a field of dots read as a sky. That, plus light that follows the real sun,
   is the difference between an effect and a window.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows
   writes the separator as a backslash and file:///android_asset/ cannot resolve it). */

(function () {
  "use strict";

  var S = WP.settings;
  var L = WP.skyLight;
  var sceneFor = L.sceneFor, coverFor = L.coverFor, rgba = L.rgba;

  var MAXCLOUD = 9, MAXDROP = 150, MAXFLAKE = 90;

  var sky = {
    name: "sky",
    canvas: null, ctx: null,
    w: 0, h: 0,
    scene: "clear", night: false,
    /* what the payload said; null until the first fetch lands, which is the offline and
       first-boot case the light model has a documented fallback for */
    sun: null, cover: null, windKmh: 0, windDir: 270,
    stars: [], drops: [], flakes: [], clouds: [], bands: [],
    puff: null, puffAt: -1e9, moonAt: -1e9, moonK: 1,
    seedPhase: Math.random() * 1000,
    flashAt: -99, flashNext: 0, flashN: 0,
    raf: 0, last: 0, acc: 0,
    col: {},

    init: function () {
      var c = document.getElementById("sky");
      /* The test DOM has no canvas contexts and no rAF; the layer simply stays off
         there — everything testable about it (sceneFor, the light model, the settings
         switch) is pure and lives outside the draw loop. */
      if (!c || typeof c.getContext !== "function"
             || typeof requestAnimationFrame !== "function") return;
      this.canvas = c;
      this.ctx = c.getContext("2d");
      if (!this.ctx) { this.canvas = null; return; }
      this.readPalette();
      this.resize();
      window.addEventListener("resize", this.resize.bind(this));

      var self = this;
      /* follow the same payload the cards render from */
      if (WP.registry.weather && WP.registry.weather.onData) {
        WP.registry.weather.onData(function (d) { self.ingest(d); });
      }
      S.onChange(function (k) {
        if (k === "sky" || k === "*") self.apply();
        /* the wind arrives in whatever unit the panel is set to, so a unit flip changes
           the number the slant is computed from */
        if (k === "units" && WP.registry.weather) self.ingest(WP.registry.weather.data);
      });
      document.addEventListener("visibilitychange", function () { self.apply(); });
      this.apply();
    },

    /* Everything the layer takes from the payload. Sun times and cloud and wind are read
       straight off the same object the Now card renders, so the two cannot disagree. */
    ingest: function (d) {
      var cur = d && d.current;
      if (!cur) return;
      var day = d.daily;
      if (day && day.sunrise && day.sunset && day.sunrise[0] && day.sunset[0]) {
        /* Local ISO with no offset, which Date parses as local time — the same reading
           the Now panel's Sunrise/Sunset rows take from these very fields. */
        var r = Date.parse(day.sunrise[0]), s = Date.parse(day.sunset[0]);
        if (isFinite(r) && isFinite(s)) this.sun = { rise: r, set: s };
      }
      var scene = sceneFor(cur.weather_code);
      this.cover = coverFor(scene, cur.cloud_cover);
      this.windKmh = (S.isMetric() ? 1 : 1.609344) * (Number(cur.wind_speed_10m) || 0);
      this.windDir = Number(cur.wind_direction_10m);
      this.set(scene, cur.is_day === 0);
    },

    readPalette: function () {
      var cs = (typeof getComputedStyle === "function")
        ? getComputedStyle(document.documentElement) : null;
      var fb = { rain: "#5aa9ff", snow: "#d6efff", star: "#cfd4ff", fog: "#9aa8b8" };
      if (!cs) { this.col = fb; return; }
      function v(name, d) { return (cs.getPropertyValue(name) || d).trim() || d; }
      this.col = {
        rain: v("--ic-rain", fb.rain), snow: v("--ic-snow", fb.snow),
        star: v("--ic-star", fb.star), fog: v("--ic-fog", fb.fog)
      };
    },

    resize: function () {
      var c = this.canvas;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = window.innerWidth; this.h = window.innerHeight;
      c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.seed();
    },

    set: function (scene, night) {
      if (scene === this.scene && night === this.night) return;
      this.scene = scene; this.night = night;
      this.seed();
      this.apply();
    },

    on: function () { return S.get("sky") !== false && !document.hidden; },

    apply: function () {
      if (!this.canvas) return;
      if (this.on()) {
        if (!this.raf) { this.last = 0; this.loop(); }
      } else if (this.raf) {
        cancelAnimationFrame(this.raf); this.raf = 0;
        this.ctx.clearRect(0, 0, this.w, this.h);
      }
    },

    /* The full pool is always seeded; how much of it draws is decided per frame from the
       real cover and the real rain rate. Re-seeding because a cloud percentage moved two
       points would restart every raindrop on screen. */
    /* The particle populations live with the light model in wx-sky-light.js: they are
       the sky's DATA — how many stars at which magnitudes, how deep the rain field is —
       and this file is only the painter. (Also the honest reason: the painter crossed the
       500-line budget by eight lines, and the populations were the one block that was not
       painting.) */
    seed: function () {
      var f = WP.skyLight.populate(this.w, this.h, MAXCLOUD, MAXDROP, MAXFLAKE);
      this.stars = f.stars;
      this.drops = f.drops;
      this.flakes = f.flakes;
      this.clouds = f.clouds;
      this.bands = f.bands;
      this.flashNext = f.flashNext;
      this.puffAt = -1e9;
    },

    loop: function () {
      var self = this;
      this.raf = requestAnimationFrame(function (ts) {
        if (!self.on()) { self.raf = 0; return; }
        if (!self.last) self.last = ts;
        var dt = Math.min(ts - self.last, 100);
        self.last = ts;
        self.acc += dt;
        if (self.acc >= 33) {           // ~30 fps
          self.draw(self.acc / 1000, ts / 1000);
          self.acc = 0;
        }
        self.loop();
      });
    },

    /* A new moon is a darker night than a full one and the panel may as well know it. The
       Moon widget computes illumination locally from arithmetic, so this costs nothing and
       needs no network. Recomputed once a minute; it moves slower than that. */
    moonFactor: function (t) {
      if (t - this.moonAt < 60) return this.moonK;
      this.moonAt = t;
      this.moonK = 1;
      var m = WP.registry.moon;
      if (m && typeof m.calc === "function") {
        try { this.moonK = 0.45 + 0.55 * (m.calc(Date.now()).frac || 0); } catch (e) {}
      }
      return this.moonK;
    },

    /* One soft blob, rendered once and stamped for every cloud bank. Cheaper than a
       radial gradient per bank per frame, and — the reason it exists — a bank built from
       five overlapping lobes has a ragged edge, where a single gradient is visibly an
       ellipse. Rebuilt on a slow throttle because the tint follows the light. */
    makePuff: function (rgb, t) {
      if (this.puff && t - this.puffAt < 45) return this.puff;
      this.puffAt = t;
      var s = 128, c = document.createElement("canvas");
      if (!c || typeof c.getContext !== "function") return null;
      c.width = s; c.height = s;
      var g = c.getContext("2d");
      if (!g) return null;
      var lobes = [[0.50, 0.52, 0.30], [0.33, 0.57, 0.21], [0.67, 0.55, 0.23],
                   [0.43, 0.43, 0.19], [0.61, 0.45, 0.17]];
      for (var i = 0; i < lobes.length; i++) {
        var cx = lobes[i][0] * s, cy = lobes[i][1] * s, r = lobes[i][2] * s;
        var rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, "rgba(" + rgb + ",0.5)");
        rg.addColorStop(0.55, "rgba(" + rgb + ",0.17)");
        rg.addColorStop(1, "rgba(" + rgb + ",0)");
        g.fillStyle = rg;
        g.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      this.puff = c;
      return c;
    },

    draw: function (dt, t) {
      var x = this.ctx, w = this.w, h = this.h, sc = this.scene;
      x.clearRect(0, 0, w, h);

      var sun = this.sun || {};
      var light = L.at(Date.now(), sun.rise, sun.set);
      var cover = this.cover == null ? coverFor(sc, null) : this.cover;
      var d = L.dim(light, cover);
      var wind = L.wind(this.windKmh, this.windDir);

      this.paintWash(light, d, w, h);
      this.paintGlow(light, d, t, w, h);
      if (light.stars * d.stars > 0.02) this.paintStars(light, d, t, w, h);
      if (sc !== "clear" && sc !== "fog") this.paintClouds(light, wind, dt, t, w, h, cover);
      if (sc === "rain" || sc === "drizzle" || sc === "storm") {
        this.paintRain(sc, wind, dt, w, h);
      }
      if (sc === "snow") this.paintSnow(wind, dt, t, w, h);
      if (sc === "fog") this.paintFog(dt, w, h);
      if (sc === "storm") this.paintFlash(dt, t, w, h);
    },

    /* The light pools at the bottom of the frame, because that is where the horizon is at
       every hour except noon — and noon's wash is 0.036, which is as close to nothing as a
       thing can be and still be there. */
    paintWash: function (light, d, w, h) {
      var a = light.wash * d.wash;
      if (a < 0.004) return;
      var c = light.sky.join(",");
      /* The first curve kept the colour in the bottom tenth of the frame, which is why
         golden hour read as black with a warm rumour: two thirds of the screen never got
         a single tinted pixel. A real sky's gradient owns the whole height — faint at the
         zenith, full at the horizon. */
      var g = this.ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(" + c + "," + (a * 0.10).toFixed(4) + ")");
      g.addColorStop(0.40, "rgba(" + c + "," + (a * 0.28).toFixed(4) + ")");
      g.addColorStop(0.70, "rgba(" + c + "," + (a * 0.55).toFixed(4) + ")");
      g.addColorStop(0.90, "rgba(" + c + "," + (a * 0.85).toFixed(4) + ")");
      g.addColorStop(1, "rgba(" + c + "," + a.toFixed(4) + ")");
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, w, h);
    },

    /* The sun or the moon: a bloom, never a disc. Its place in the frame comes from the
       light model and therefore from the real sun, so over a day it genuinely rises in the
       east and sets in the west. The small sine on top is not decoration — it is the
       minute-scale motion that keeps a soft bright spot from ever being static pixels. */
    paintGlow: function (light, d, t, w, h) {
      var a = light.glowA * d.glow * (light.stars > 0.5 ? this.moonFactor(t) : 1);
      if (a < 0.004) return;
      var gx = w * light.glowX + Math.sin(t * 0.021 + this.seedPhase) * w * 0.018;
      var gy = h * light.glowY + Math.cos(t * 0.017 + this.seedPhase) * h * 0.012;
      var gr = Math.max(w, h) * light.glowR;
      var c = light.glow.join(",");
      var x = this.ctx;
      var g = x.createRadialGradient(gx, gy, 0, gx, gy, gr);
      g.addColorStop(0, "rgba(" + c + "," + a.toFixed(4) + ")");
      g.addColorStop(0.32, "rgba(" + c + "," + (a * 0.64).toFixed(4) + ")");
      g.addColorStop(0.68, "rgba(" + c + "," + (a * 0.22).toFixed(4) + ")");
      g.addColorStop(1, "rgba(" + c + ",0)");
      /* Low light spreads ALONG the horizon rather than sitting in a circle on it — a
         sunrise is a band, not a spotlight. The stretch is a function of how low the bloom
         is, so it grows in through dawn and flattens back out by noon. */
      var sx = 1 + Math.max(0, light.glowY - 0.45) * 1.7;
      x.save();
      x.translate(gx, gy); x.scale(sx, 1); x.translate(-gx, -gy);
      x.fillStyle = g;
      x.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      x.restore();
    },

    /* Round, sized by magnitude, and the bright few carry a bloom. Twinkle is the product
       of two slow incommensurate sines per star: slow enough that nobody catches one
       doing it, unsynchronised enough that the field never pulses as a sheet. */
    paintStars: function (light, d, t, w, h) {
      var x = this.ctx, k = light.stars * d.stars, i, s, tw, a;
      x.fillStyle = this.col.star;
      for (i = 0; i < this.stars.length; i++) {
        s = this.stars[i];
        tw = 0.74 + 0.26 * Math.sin(t * s.sp + s.ph) * Math.sin(t * s.sp2 + s.ph2);
        a = s.a * tw * k;
        if (a < 0.008) continue;
        if (s.m > 0.7) {
          var br = s.r * 4.5;
          var g = x.createRadialGradient(s.x, s.y, 0, s.x, s.y, br);
          g.addColorStop(0, rgba(this.col.star, (a * 0.30).toFixed(4)));
          g.addColorStop(1, rgba(this.col.star, 0));
          x.fillStyle = g;
          x.fillRect(s.x - br, s.y - br, br * 2, br * 2);
          x.fillStyle = this.col.star;
        }
        x.globalAlpha = a;
        x.beginPath();
        x.arc(s.x, s.y, s.r, 0, 6.283);
        x.fill();
      }
      x.globalAlpha = 1;
    },

    /* How many banks is the real cover percentage; how fast and how bright is depth. A
       cloud is lit by the sky it hangs in, so the tint is the light model's own colour
       pulled halfway to grey — dawn banks are warm, midnight banks are cold. */
    paintClouds: function (light, wind, dt, t, w, h, cover) {
      var n = L.banks(cover, MAXCLOUD);
      if (!n) return;
      var tint = [Math.round(light.sky[0] * 0.35 + 160 * 0.65),
                  Math.round(light.sky[1] * 0.35 + 172 * 0.65),
                  Math.round(light.sky[2] * 0.35 + 194 * 0.65)].join(",");
      var puff = this.makePuff(tint, t);
      if (!puff) return;
      var x = this.ctx;
      var drift = (wind.east >= 0 ? 1 : -1) * (0.45 + wind.force * 1.6);
      for (var i = 0; i < n; i++) {
        var c = this.clouds[i];
        c.x += c.v * drift * dt;
        if (c.x - c.rx > w) c.x = -c.rx;
        if (c.x + c.rx < 0) c.x = w + c.rx;
        var ry = c.rx * (0.30 + c.z * 0.10);
        /* The puff sprite already carries a soft alpha falloff of its own (0.5 at a lobe
           core), so this multiplies down: 0.11 here is about 0.09 on the glass. */
        x.globalAlpha = 0.06 + c.z * 0.13;
        x.drawImage(puff, c.x - c.rx, c.y - ry, c.rx * 2, ry * 2);
      }
      x.globalAlpha = 1;
    },

    /* Three depth bands, drawn as three batched paths so each can keep its own width and
       brightness: near drops long, fast and bright, far ones short, slow and dim. The
       slant is the real wind — direction and speed both — which is the single change that
       stops rain looking like a screensaver, because a screensaver's rain is vertical. */
    paintRain: function (sc, wind, dt, w, h) {
      var x = this.ctx, thin = sc === "drizzle";
      var n = thin ? 70 : (sc === "storm" ? MAXDROP : 120);
      var vk = thin ? 0.5 : 1, lk = thin ? 0.5 : 1, ak = thin ? 0.62 : 1;
      var band = [[], [], []], i, dr;
      for (i = 0; i < n; i++) {
        dr = this.drops[i];
        var v = dr.v * vk;
        dr.y += v * dt;
        dr.x += v * wind.slant * dt;
        if (dr.y > h) { dr.y = -dr.l; dr.x = Math.random() * w * 1.4 - w * 0.2; }
        if (dr.x < -w * 0.25) dr.x += w * 1.5;
        else if (dr.x > w * 1.25) dr.x -= w * 1.5;
        band[dr.z < 0.34 ? 0 : (dr.z < 0.67 ? 1 : 2)].push(dr);
      }
      x.strokeStyle = this.col.rain;
      for (var b = 0; b < 3; b++) {
        if (!band[b].length) continue;
        x.lineWidth = 0.8 + b * 0.7;
        x.globalAlpha = (0.12 + b * 0.14) * ak;      /* ceiling 0.26 — rain you can see */
        x.beginPath();
        for (i = 0; i < band[b].length; i++) {
          dr = band[b][i];
          var l = dr.l * lk;
          x.moveTo(dr.x, dr.y);
          x.lineTo(dr.x - wind.slant * l, dr.y - l);
        }
        x.stroke();
      }
      x.globalAlpha = 1;
    },

    /* Snow does not fall, it drifts: a slow sink, a sway of its own, and a sideways push
       from the real wind. Depth again — the near flakes are twice the size and twice the
       speed of the far ones, which is most of why a flat flake field looks like static. */
    paintSnow: function (wind, dt, t, w, h) {
      var x = this.ctx;
      x.fillStyle = this.col.snow;
      for (var i = 0; i < this.flakes.length; i++) {
        var f = this.flakes[i];
        f.y += f.v * dt;
        f.x += (Math.sin(t * f.sw + f.ph) * (7 + f.z * 11)
                + wind.east * wind.force * (14 + f.z * 30)) * dt;
        if (f.y > h) { f.y = -4; f.x = Math.random() * w; }
        if (f.x < -6) f.x = w + 5; else if (f.x > w + 6) f.x = -5;
        x.globalAlpha = 0.14 + f.z * 0.26;           /* ceiling 0.40 — snow is WHITE */
        x.beginPath();
        x.arc(f.x, f.y, f.r, 0, 6.283);
        x.fill();
      }
      x.globalAlpha = 1;
    },

    /* Fog lies on the ground. The old version put four bands across the middle of the
       frame, evenly spaced, which is not fog — it is venetian blinds. A base gradient
       rising from the bottom edge plus bands that all live in the lower third is. */
    paintFog: function (dt, w, h) {
      var x = this.ctx, c = this.col.fog, i;
      var base = x.createLinearGradient(0, h * 0.5, 0, h);
      base.addColorStop(0, rgba(c, 0));
      base.addColorStop(0.55, rgba(c, 0.035));
      base.addColorStop(1, rgba(c, 0.10));
      x.fillStyle = base;
      x.fillRect(0, h * 0.5, w, h * 0.5);
      for (i = 0; i < this.bands.length; i++) {
        var b = this.bands[i];
        b.x += b.v * dt;
        if (b.x > w) b.x = 0;
        var g = x.createLinearGradient(0, b.y - b.hh, 0, b.y + b.hh);
        g.addColorStop(0, rgba(c, 0));
        g.addColorStop(0.5, rgba(c, b.a));
        g.addColorStop(1, rgba(c, 0));
        x.fillStyle = g;
        /* two copies so the band wraps seamlessly */
        x.fillRect(b.x - w, b.y - b.hh, w, b.hh * 2);
        x.fillRect(b.x, b.y - b.hh, w, b.hh * 2);
      }
    },

    /* Lightning lights the CLOUD, so the flash is brightest at the top of the frame and
       has all but gone by the bottom — a flat white rectangle over the whole panel is a
       camera effect, not weather. Strikes come in ones and twos, as they do. */
    paintFlash: function (dt, t, w, h) {
      this.flashNext -= dt * 1000;
      if (this.flashNext <= 0) {
        this.flashAt = t;
        this.flashN = Math.random() < 0.45 ? 2 : 1;
        this.flashNext = 6000 + Math.random() * 12000;
      }
      var since = (t - this.flashAt) * 1000;
      var k = 0;
      if (since < 240) k = 1 - since / 240;
      else if (this.flashN > 1 && since > 380 && since < 560) k = (560 - since) / 180 * 0.6;
      if (k <= 0.01) return;
      var g = this.ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(214,224,255," + (0.14 * k).toFixed(4) + ")");
      g.addColorStop(0.5, "rgba(214,224,255," + (0.05 * k).toFixed(4) + ")");
      g.addColorStop(1, "rgba(214,224,255,0)");
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, w, h);
    },

    onOpen: function () {}, onClose: function () {}
  };

  sky.sceneFor = sceneFor;
  sky.coverFor = coverFor;
  WP.sky = sky;
  WP.register(sky);
})();
