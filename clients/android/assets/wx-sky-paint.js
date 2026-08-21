/* Wall panel dashboard — SKY (the weather painters).

   The half of the sky layer that draws WEATHER: stars, cloud banks, rain, snow, fog and
   the flash of a storm. wx-sky.js keeps the lifecycle — the canvas, the settings switch,
   the payload, the frame loop — and the three painters that draw LIGHT rather than
   weather (wash, horizon, bloom), because those are what the light model is for.

   The split is not cosmetic. wx-sky.js was two lines under the 500-line ceiling, so the
   next honest improvement to any painter would have had to be paid for by deleting a
   comment somewhere else. Lifecycle and painters also change for different reasons and at
   different rates: the loop has not needed a line since it was written, and the fog has
   been rewritten twice.

   The methods are MIXED INTO the sky object rather than called through it, so every
   painter still reads `this.ctx`, `this.drops`, `this.col` exactly as it did when they
   lived in one file — the seam is where the source is cut, not where the object is.

   One flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it). */

(function () {
  "use strict";

  var rgba = WP.skyLight.rgba;

  /* A soft lumpy blob on a transparent square, built once and stamped wherever a mass of
     something diffuse is needed. Cheaper than a radial gradient per bank per frame, and —
     the reason it exists — a bank built from overlapping lobes has a ragged edge where a
     single gradient is visibly an ellipse. */
  function blob(rgb, lobes, peak) {
    var s = 128, c = document.createElement("canvas");
    if (!c || typeof c.getContext !== "function") return null;
    c.width = s; c.height = s;
    var g = c.getContext("2d");
    if (!g) return null;
    for (var i = 0; i < lobes.length; i++) {
      var cx = lobes[i][0] * s, cy = lobes[i][1] * s, r = lobes[i][2] * s;
      var rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, "rgba(" + rgb + "," + peak + ")");
      rg.addColorStop(0.42, "rgba(" + rgb + "," + (peak * 0.45).toFixed(3) + ")");
      rg.addColorStop(0.75, "rgba(" + rgb + "," + (peak * 0.12).toFixed(3) + ")");
      rg.addColorStop(1, "rgba(" + rgb + ",0)");
      g.fillStyle = rg;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    return c;
  }

  /* Seven lobes, not five, and a gentle falloff: five circles is a shape the eye names,
     and an abrupt stop gives a bank a rim. Clouds have no rim. */
  var CUMULUS = [[0.50, 0.52, 0.31], [0.31, 0.57, 0.22], [0.69, 0.55, 0.24],
                 [0.42, 0.42, 0.20], [0.62, 0.44, 0.18],
                 [0.22, 0.49, 0.15], [0.79, 0.48, 0.14]];
  /* Fog is the same idea flattened and stretched: the lobes sit in a band across the
     middle of the sprite, so stamping it wide and short gives a layer whose density
     varies ALONG it. That variation is the whole difference between fog and grey paint. */
  var HAZE = [[0.20, 0.50, 0.26], [0.44, 0.46, 0.30], [0.68, 0.54, 0.27],
              [0.86, 0.48, 0.20], [0.33, 0.58, 0.18], [0.58, 0.40, 0.17]];

  WP.skyPaint = {

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

    /* The cumulus sprite, retinted on a slow throttle because the tint follows the light. */
    makePuff: function (rgb, t) {
      if (this.puff && t - this.puffAt < 45) return this.puff;
      this.puffAt = t;
      this.puff = blob(rgb, CUMULUS, 0.42);
      return this.puff;
    },

    /* How many banks is the real cover percentage; how fast and how bright is depth. A
       cloud is lit by the sky it hangs in, so the tint is the light model's own colour
       pulled halfway to grey — dawn banks are warm, midnight banks are cold. */
    paintClouds: function (light, wind, dt, t, w, h, cover) {
      var n = WP.skyLight.banks(cover, this.MAXCLOUD);
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
        var ry = c.rx * c.sq;
        /* The puff sprite already carries a soft alpha falloff of its own (0.42 at a lobe
           core), so this multiplies down: 0.19 here is about 0.08 on the glass. */
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
      var n = thin ? 70 : (sc === "storm" ? this.MAXDROP : 120);
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
      /* Each streak is drawn TWICE: a dim full-length tail, then a bright head over its
         lowest third. One flat stroke is a scratch ruled on the glass; what makes a drop
         read as FALLING is a leading end brighter than the trail behind it. */
      x.strokeStyle = this.col.rain;
      x.lineCap = "round";
      for (var b = 0; b < 3; b++) {
        if (!band[b].length) continue;
        for (var pass = 0; pass < 2; pass++) {
          x.lineWidth = (0.8 + b * 0.75) * (pass ? 1.25 : 1);
          x.globalAlpha = (pass ? 0.09 + b * 0.09 : 0.08 + b * 0.09) * ak;
          x.beginPath();
          for (i = 0; i < band[b].length; i++) {
            dr = band[b][i];
            var l = dr.l * lk * (pass ? 0.36 : 1);
            x.moveTo(dr.x, dr.y);
            x.lineTo(dr.x - wind.slant * l, dr.y - l);
          }
          x.stroke();
        }
      }
      x.globalAlpha = 1;
      x.lineCap = "butt";
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
        /* the nearest flakes are out of focus: a halo on a few is the difference
           between depth and a field of identical dots */
        if (f.soft) {
          var br = f.r * 3.4;
          var sg = x.createRadialGradient(f.x, f.y, 0, f.x, f.y, br);
          sg.addColorStop(0, rgba(this.col.snow, 0.16));
          sg.addColorStop(1, rgba(this.col.snow, 0));
          x.fillStyle = sg;
          x.globalAlpha = 1;
          x.fillRect(f.x - br, f.y - br, br * 2, br * 2);
          x.fillStyle = this.col.snow;
        }
      }
      x.globalAlpha = 1;
    },

    /* FOG, third attempt, and the first one that is fog.

       Attempt one put four evenly spaced full-width bands across the middle of the frame:
       venetian blinds. Attempt two added a floor gradient and raised the ceiling from 0.10
       to 0.16, which made it brighter without making it fog — brightened four times over
       for inspection it was a flat uniform wash, because a full-width rect at a constant
       alpha IS a flat uniform wash however many of them you stack.

       What was missing is variation ALONG the layer. Fog is not evenly dense: it has banks
       you can see the far side of and banks you cannot, and they slide past each other at
       different speeds. So the bands are stamped from a lumpy sprite, wide and flat, at
       seven depths — near ones tall, slow and stronger, far ones thin, quick and faint —
       and each breathes on a slow sine of its own so no two are ever at the same density.

       This is the one scene where this layer IS the weather: no clouds, no precipitation,
       nothing else on the glass. So it takes the heaviest hand in the alpha budget, and
       the floor gradient's 0.19 of the fog grey (RGB 29 over black) is what keeps
       --dimmer text better than 5:1 with the banks stacked on top of it. */
    paintFog: function (dt, t, w, h) {
      var x = this.ctx, c = this.col.fog, i;
      /* Fog lies on the ground, so the base is a floor gradient, not a fill. */
      var base = x.createLinearGradient(0, h * 0.44, 0, h);
      base.addColorStop(0, rgba(c, 0));
      base.addColorStop(0.5, rgba(c, 0.062));
      base.addColorStop(1, rgba(c, 0.19));
      x.fillStyle = base;
      x.fillRect(0, h * 0.44, w, h * 0.56);

      if (!this.haze) this.haze = blob(this.rgbOf(c), HAZE, 0.5);
      if (!this.haze) return;
      for (i = 0; i < this.bands.length; i++) {
        var b = this.bands[i];
        b.x += b.v * dt;
        if (b.x > w + b.rx) b.x = -b.rx;
        /* the slow breath: a bank that thins and thickens is a bank, one that holds a
           constant alpha for an hour is a decal */
        var a = b.a * (0.72 + 0.28 * Math.sin(t * b.br + b.ph));
        x.globalAlpha = a;
        x.drawImage(this.haze, b.x - b.rx, b.y - b.hh, b.rx * 2, b.hh * 2);
      }
      x.globalAlpha = 1;
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

    /* "#9aa8b8" -> "154,168,184", because a canvas gradient stop wants a colour and
       drawImage wants the channels on their own. */
    rgbOf: function (hex) {
      return rgba(hex, 1).slice(5, -3);
    }
  };
})();
