/* Wall panel dashboard — SKY (animated background, the painters).

   A full-screen canvas behind the dashboard that draws what the weather is doing: the
   light of the actual hour, stars with real magnitudes, drifting cloud banks, rain leaning
   on the real wind, snow that drifts rather than falls, fog sitting on the floor of the
   frame, and a dim flash in a storm. This is the "the panel is a window" layer — it is why
   the theme is allowed to stay dark: the background is not empty, it is the weather.

   The LIGHT — which mood, which colour, where the bloom sits, where the horizon is — is
   not decided here. It comes out of wx-sky-light.js, a pure function of (now, sunrise,
   sunset) tested at every phase boundary. This file only paints what that model says: the
   painters can only be judged by looking at them, so the half that CAN be pinned by a
   test lives where a test can reach it.

   AMOLED rules the layer lives by: everything moves, so no pixel can burn in (the bloom
   tracks the real sun and even the stars twinkle); it is dim by construction, with the
   alpha budget stated and defended in wx-sky-light.js and most of the frame left true
   black; it runs at 30 fps, not 60, which is half the GPU work and invisible for weather;
   and it stops entirely when the app is hidden or the Settings switch is off.

   WHY IT SHIPS ON AGAIN: it shipped off after a round of grading called the starfield
   "dust on the glass or dead pixels" — a fair verdict on 110 identical one-pixel
   rectangles, which is what sensor noise looks like. Nothing in a sky is uniform, and the
   populations (wx-sky-light.js) are graded accordingly: star magnitudes on a power curve,
   raindrops of differing length at the same depth, banks of differing proportion, a
   handful of near flakes soft enough to be out of focus. That, plus light that follows
   the real sun, is the difference between an effect and a window.

   WHAT IS AND IS NOT HERE. This file owns the lifecycle — canvas, settings switch,
   payload, frame loop — and the three painters that draw LIGHT (wash, horizon, bloom),
   because those are what the light model is for. The painters that draw WEATHER (stars,
   banks, rain, snow, fog, flash) are in wx-sky-paint.js and are mixed into this object at
   load. Two reasons: the file was two lines under the 500-line ceiling, and the two halves
   change at completely different rates — the loop has not needed a line since it was
   written and the fog has been rewritten twice.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows
   writes the separator as a backslash and file:///android_asset/ cannot resolve it). */

(function () {
  "use strict";

  var S = WP.settings;
  var L = WP.skyLight;
  var sceneFor = L.sceneFor, coverFor = L.coverFor, rgba = L.rgba;

  /* How deep each field is. Rain went UP (a denser, finer field is what stops streaks
     reading as dashes) and snow came DOWN (see the note over the flake population in
     wx-sky-light.js: the flakes that were bought by count were the invisible ones). */
  var MAXCLOUD = 9, MAXDROP = 210, MAXFLAKE = 64;

  var sky = {
    name: "sky",
    canvas: null, ctx: null,
    w: 0, h: 0,
    scene: "clear", night: false,
    /* what the payload said; null until the first fetch lands, which is the offline and
       first-boot case the light model has a documented fallback for */
    sun: null, cover: null, windKmh: 0, windDir: 270,
    stars: [], drops: [], flakes: [], clouds: [], bands: [], aloft: [],
    /* the painters in wx-sky-paint.js read these off `this` — how deep each field is
       belongs with the seeding, not with the drawing */
    MAXCLOUD: MAXCLOUD, MAXDROP: MAXDROP, MAXFLAKE: MAXFLAKE,
    puff: null, puffFar: null, puffAt: -1e9, haze: null, milky: null, bokeh: null,
    moonAt: -1e9, moonK: 1,
    mood: "",
    seedPhase: Math.random() * 1000,
    flashAt: -99, flashNext: 0, flashN: 0,
    raf: 0, last: 0, acc: 0,
    col: {},

    init: function () {
      var self = this;
      /* follow the same payload the cards render from */
      if (WP.registry.weather && WP.registry.weather.onData) {
        WP.registry.weather.onData(function (d) { self.ingest(d); });
      }
      /* THE MOOD IS NOT THE CANVAS, so it is wired before the canvas guard and it ignores
         the Settings switch. Which of the six moods the panel is in is stamped on <html>
         as data-mood, and style-icons.css uses it to warm the weather icons' highlights at
         golden hour and cool them at night. That is a property of the hour, not of the
         animated background — a person who turned the sky layer off still wants the sun
         icon to look like the sun that is actually in the window. Once a minute is far
         more often than the light needs; it costs an attribute compare. */
      this.moodTick();
      if (typeof setInterval === "function") {
        setInterval(function () { self.moodTick(); }, 60000);
      }

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

    /* Which mood, onto <html>. Nothing else in the app reads it; it exists so the icon
       pack can take its highlight colour from the real hour without a paint server ever
       being touched from JavaScript, which is what kept a duplicate-id bug out of the
       gradients in the first place. */
    moodTick: function () {
      var root = (typeof document !== "undefined") ? document.documentElement : null;
      if (!root || typeof root.setAttribute !== "function") return;
      var sun = this.sun || {};
      var m = L.at(Date.now(), sun.rise, sun.set).phase;
      if (m !== this.mood) { this.mood = m; root.setAttribute("data-mood", m); }
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
       points would restart every raindrop on screen. The populations themselves live with
       the light model in wx-sky-light.js: they are the sky's DATA — how many stars at
       which magnitudes, how deep the rain field is — and this file is only the painter. */
    seed: function () {
      var f = WP.skyLight.populate(this.w, this.h, MAXCLOUD, MAXDROP, MAXFLAKE);
      this.stars = f.stars;
      this.drops = f.drops;
      this.flakes = f.flakes;
      this.clouds = f.clouds;
      this.bands = f.bands;
      this.aloft = f.aloft;
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

    draw: function (dt, t) {
      var x = this.ctx, w = this.w, h = this.h, sc = this.scene;
      x.clearRect(0, 0, w, h);

      var sun = this.sun || {};
      var light = L.at(Date.now(), sun.rise, sun.set);
      var cover = this.cover == null ? coverFor(sc, null) : this.cover;
      if (light.phase !== this.mood) this.moodTick();
      var d = L.dim(light, cover);
      var wind = L.wind(this.windKmh, this.windDir);

      this.paintWash(light, d, w, h);
      this.paintHorizon(light, d, w, h);
      this.paintGlow(light, d, t, w, h);
      if (light.stars * d.stars > 0.02) this.paintStars(light, d, t, w, h);
      if (sc !== "clear" && sc !== "fog") this.paintClouds(light, wind, dt, t, w, h, cover, sc);
      if (sc === "rain" || sc === "drizzle" || sc === "storm") {
        this.paintRain(sc, wind, dt, w, h);
      }
      if (sc === "snow") this.paintSnow(wind, dt, t, w, h);
      if (sc === "fog") this.paintFog(dt, t, w, h);
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

    /* The line the light is coming from. Where and how bright is L.horizon's problem —
       arithmetic, therefore testable; this only draws it. A band and not a line (a hard
       edge across a wall panel reads as a rendering fault), and absent at midday. */
    paintHorizon: function (light, d, w, h) {
      var hz = L.horizon(light), a = hz.a * d.glow;
      if (a < 0.004) return;
      var y = h * hz.y, sp = h * hz.spread, c = light.glow.join(",");
      var g = this.ctx.createLinearGradient(0, y - sp * 2.2, 0, y + sp);
      [[0, 0], [0.62, 0.42], [0.88, 1], [1, 0]].forEach(function (k) {
        g.addColorStop(k[0], "rgba(" + c + "," + (a * k[1]).toFixed(4) + ")");
      });
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, y - sp * 2.2, w, sp * 3.2);
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

    onOpen: function () {}, onClose: function () {}
  };

  /* The weather painters live in wx-sky-paint.js and are mixed in here, so each of them
     still reads this.ctx / this.drops / this.col exactly as it did when the file was one
     file. The seam is where the source is cut, not where the object is. */
  Object.keys(WP.skyPaint).forEach(function (k) { sky[k] = WP.skyPaint[k]; });

  sky.sceneFor = sceneFor;
  sky.coverFor = coverFor;
  WP.sky = sky;
  WP.register(sky);
})();
