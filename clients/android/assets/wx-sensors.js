/* Wall panel dashboard — HOME ASSISTANT.

   Simulator by default, real REST API when configured. No token is bundled (the repo is
   public), so the default is a genuine simulator: every numeric entity is a
   mean-reverting random walk around a time-of-day curve, seeded deterministically per
   entity so two hours of plausible history exist the instant the panel boots.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero, btn = ui.btn;

  var HA_STATE_KEY = "inky.ha.v1";

  var sensors = {
    name: "sensors",
    mode: "demo",          // "demo" | "live"
    sel: null,
    ents: [],
    tickMs: 5000,
    sampleMs: 30000,
    lastSample: 0,

    /* Simulated home. `phase` is the hour of day at which the daily curve peaks; `short`
       is what fits a home tile (five across), `label` is used everywhere with room.

       Two knobs give each quantity its own physics. `tau` is the time constant with which
       it chases its target — a room has thermal mass and takes a quarter of an hour to
       react to a lamp, while household power follows the load in seconds. `noise` is the
       random kick per 5 s tick, sized so the resulting standing jitter is about ±0.1 °F for
       a room rather than the ±1 °F of noise it used to be. `dwell` is the plausible range
       of on / off run lengths for switch-like entities, used both to synthesise their past
       and to drive the door's live flips. */
    /* Glyphs are text-presentation symbols from the Geometric Shapes / Misc Symbols blocks,
       not emoji. The row used to be 🌡🛏🌤💧🫁⚡💡🌀🚪, which Android renders as full-colour
       sprites sitting beside the weather widgets' crisp white line glyphs.

       Switch-like entities carry TWO glyphs and swap on state: filled = energised, hollow =
       not. A lamp that was off still drew the same lit bulb as a lamp that was on, so from
       across the room the giant yellow bulb said "on" while the text underneath said Off.
       Filled-vs-hollow is legible at 2-4 m in a way that a colour shift is not. */


    /* ---- demo model ----
       The whole simulator (entity defs, the seeded two-hour history, the diffusion
       stepper) lives in wx-sensors-demo.js as WP.sensorsDemo; these three delegates are
       the only coupling. demoDefs stays a property because the tests and the glyph
       audit read it from the registry. */
    demoDefs: WP.sensorsDemo.defs,
    initDemo: function () { WP.sensorsDemo.seed(this); },
    stepDemo: function () { WP.sensorsDemo.step(this); },
    reversion: function (def, dt) { return WP.sensorsDemo.reversion(def, dt); },
    noiseFor: function (def, dt) { return WP.sensorsDemo.noiseFor(this, def, dt); },
    target: function (def, when, flags) { return WP.sensorsDemo.target(def, when, flags); },
    flags: function () { return WP.sensorsDemo.flags(this); },

    /* ---- freshness ----
       The live feed can stop answering while the app keeps running: a long-lived token
       expires, the HA box reboots, the LAN moves. Every one of those 401s or timeouts used
       to leave the last good numbers on the wall with nothing to say they were hours old —
       so an overnight token expiry produced a panel full of plausible, wrong readings that
       looked exactly like a working dashboard.

       The weather card has had the answer to this since it was written: keep the last
       reading (blanking it destroys the last thing that WAS true) and badge it `stale`.
       This is that same badge, driven from the same kind of state. */
    stale: false,        // the live feed is not answering for at least one entity
    staleSince: 0,       // when it first stopped answering
    lastOkAt: 0,         // last poll in which every entity answered

    init: function () {
      var ha = C.homeAssistant || {};
      this.mode = (ha.enabled && ha.baseUrl && ha.token) ? "live" : "demo";
      this.setBadge();

      if (this.mode === "live") this.initLive(ha); else this.initDemo();

      var self = this;
      WP.onAction("sensors", function (act, arg) {
        if (act === "toggle") { self.toggle(arg); }
        else if (act === "pick") { self.sel = arg; self.paintPanel(); }
      });

      /* °F/°C flips have to reach the tiles straight away, not on the next 5 s tick */
      S.onChange(function () { self.render(); self.paintPanel(); });

      /* Demo and live run on deliberately different clocks. `tickMs` is the *simulation*
         step: the model's per-step random kick is scaled against it (see noiseFor), so it is
         a tuning constant and not something a config file may move. The live path is a
         network poll of somebody else's Home Assistant box, and that is what
         `homeAssistant.refreshSeconds` was always meant to be — it was documented as
         configuration while no code read it, which is worse than not offering it. Floored at
         5 s so a mistyped 0 or -1 cannot turn the panel into a request loop against HA. */
      this.livePollMs = Math.max(5000, Math.round((+ha.refreshSeconds || 60) * 1000));
      setInterval(this.tick.bind(this),
                  this.mode === "live" ? this.livePollMs : this.tickMs);
      this.tick();
    },

    /* ---- demo simulator ----
       The seeded history is a synthetic *past*, not a copy of the present. Filling all 240
       samples with the entity's current state used to make the detail panel contradict
       itself for a full two hours after any toggle ("State now: Off" beside "On: 100% of
       window"). Switches are walked backwards from their current state in randomised runs;
       numerics are then integrated forward along that same timeline, so the lamp having
       been on an hour ago shows up in the living-room temperature an hour ago too. */
    windowMs: 7200000,

    /* Both the seed and the forward stepper use these, so a 30 s seed step and a 5 s
       simulation step produce the same statistics and the trace has no seam where one hands
       over (this pair is the demo model only; live mode reads real states): the pull
       toward target decays over the entity's own time constant, and the random kick scales
       as sqrt(dt) like any diffusion. */
    trimHist: function (e, now) {
      var cut = now - sensors.windowMs;
      while (e.hist.length > 2 && e.hist[0].t < cut) e.hist.shift();
      if (e.hist.length > 800) e.hist.splice(0, e.hist.length - 800);
    },

    sample: function (e, now) {
      e.hist.push({ t: now, v: e.kind === "numeric" ? e.value : (e.on ? 1 : 0) });
      sensors.trimHist(e, now);
    },

    /* ---- real Home Assistant ---- */
    initLive: function (ha) {
      this.base = ha.baseUrl.replace(/\/+$/, "");
      this.token = ha.token;
      this.ents = (ha.entities || []).map(function (cfg) {
        var domain = String(cfg.id).split(".")[0];
        return {
          id: cfg.id, label: cfg.label || cfg.id, short: cfg.label || cfg.id,
          icon: "•", unit: cfg.unit || "",
          kind: (domain === "light" || domain === "switch" || domain === "fan")
            ? "toggle" : "numeric",
          /* err/okAt are the freshness pair: err is why this entity is not updating, okAt is
             when it last did. Both start unset — an entity that has never answered is not
             "stale", it is simply empty, and the tile shows "--" for that. */
          /* Decimals by what the number IS, not one rule for everything: a live feed gave
             every entity one decimal, so the wall read "512.0 W" and "44.0 %" — a tenth of
             a watt and a tenth of a percent are noise, and the extra digit is one more
             thing to read from across a room. A temperature earns its decimal; a count,
             a percentage and a power reading do not. `decimals` in the entity's config
             overrides this for anything the guess gets wrong. */
          domain: domain, hist: [], value: null, on: false, err: null, okAt: 0,
          dp: (typeof cfg.decimals === "number") ? cfg.decimals
            : (/°|temp/i.test(cfg.unit || "") || /temp/i.test(cfg.id) ? 1 : 0)
        };
      });
    },

    /* All live traffic goes through here. On the tablet it rides the Java shell's
       fetch (WP.bridgeFetch): the page's origin is file:// -> null, so a direct fetch
       with an Authorization header dies in a CORS preflight stock Home Assistant never
       answers — this was broken for every real user on day one, and no HA setting short
       of a reverse proxy fixes it from the page side. In a browser (tests, dev) the
       bridge is absent and it falls back to a plain fetch, where CORS is the caller's
       problem. Both paths resolve to the same {ok, status, json()} shape. */
    haFetch: function (url, opts) {
      opts = opts || {};
      var headers = this.haHeaders();
      if (WP.bridgeFetch.available()) {
        var p = opts.method === "POST"
          ? WP.bridgeFetch.post(url, headers, opts.body)
          : WP.bridgeFetch.get(url, headers);
        return p.then(function (r) {
          return {
            ok: r.ok, status: r.status,
            json: function () {
              var j = r.json();
              return j == null ? Promise.reject(new Error("bad JSON")) : Promise.resolve(j);
            }
          };
        });
      }
      var init = { headers: headers, cache: "no-store" };
      if (opts.method) init.method = opts.method;
      if (opts.body != null) init.body = opts.body;
      return fetch(url, init);
    },

    haHeaders: function () {
      return { "Authorization": "Bearer " + this.token, "Content-Type": "application/json" };
    },

    /* The `live` / `stale` / `demo` badge beside HOME on the dashboard card. One function so
       the three states cannot drift apart, and so a test can ask what the wall is showing
       rather than inferring it from internal flags. */
    setBadge: function () {
      var b = $("ha-badge");
      if (!b) return;
      var state = this.mode !== "live" ? "demo" : (this.stale ? "stale" : "live");
      b.textContent = state;
      b.className = "badge badge-" + state;
    },

    /* What to put on the status line when the feed is failing. It says what happened rather
       than what to go and edit: a 401 from Home Assistant means one thing and one thing only
       — the token is no longer accepted — and that is worth naming, because it is the
       failure that happens silently months after setup. */
    liveError: function (bad) {
      var auth = bad.some(function (e) { return /\b40[13]\b/.test(e.err || ""); });
      if (bad.length === this.ents.length) {
        return auth
          ? "Home Assistant refused the token — readings below are old"
          : "Home Assistant is not answering — readings below are old";
      }
      return bad.length + " of " + this.ents.length
        + " Home Assistant readings are not updating";
    },

    /* Why THIS entity is not updating, for the note at the top of its own panel. Separate
       from liveError(), which is about the whole feed and counts entities — printed above
       the one reading the panel is showing, "1 of 2 readings are not updating" answers a
       question nobody asked. */
    entityNote: function (e) {
      if (!e || !e.err) return "";
      return /\b40[13]\b/.test(e.err)
        ? "Not updating — Home Assistant refused the token"
        : "Not updating — Home Assistant is not answering for this one";
    },

    stepLive: function () {
      var self = this, now = Date.now();
      Promise.all(this.ents.map(function (e) {
        return self.haFetch(self.base + "/api/states/" + encodeURIComponent(e.id))
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (j) {
            e.err = null;
            e.okAt = now;
            e.attrs = j.attributes || {};
            if (e.kind === "toggle") { e.on = (j.state === "on"); e.value = e.on ? 1 : 0; }
            else {
              var n = parseFloat(j.state);
              e.value = isNaN(n) ? null : n;
              if (!e.unit) e.unit = e.attrs.unit_of_measurement || "";
            }
            e.hist.push({ t: now, v: e.value });
            /* Trim by age, not by sample count: the poll interval is configurable now, so a
               fixed 240-sample cap would mean a different window for every refreshSeconds
               while the panel keeps calling it "Last 2 hours". */
            sensors.trimHist(e, now);
          })
          .catch(function (err) { e.err = err.message; });
      })).then(function () {
        var bad = self.ents.filter(function (e) { return e.err; });
        var wasStale = self.stale;
        self.stale = bad.length > 0;
        if (self.stale && !wasStale) self.staleSince = now;
        if (!self.stale) { self.staleSince = 0; self.lastOkAt = now; }

        self.setBadge();
        if (self.stale) WP.status(self.liveError(bad), true);
        else if (wasStale) WP.status("Home Assistant is answering again");

        self.render();
        self.paintPanel();
      });
    },

    /* How old the newest reading for this entity is, in ms, or null while it is fresh.
       Reads the entity's own last-good time rather than the widget's, because a partial
       failure leaves some tiles live and some not, and the wall should say which. */
    ageOf: function (e) {
      if (!e || !e.err) return null;
      var at = e.okAt || (e.hist.length ? e.hist[e.hist.length - 1].t : 0);
      return at ? Date.now() - at : null;
    },

    tick: function () {
      if (this.mode === "live") { this.stepLive(); return; }
      this.stepDemo();
      this.render();
      this.paintPanel();
    },

    /* Toggles are optimistic in demo mode and fire the real service call when live. */
    toggle: function (id) {
      var e = this.find(id);
      if (!e || (e.kind !== "toggle")) return;
      e.on = !e.on;
      e.last = Date.now();
      /* record the edge now: waiting for the next 30 s grid sample left the sparkline and
         the duty figures disagreeing with the state the tile was already showing */
      this.sample(e, e.last);
      WP.toast(e.label + " " + (e.on ? "on" : "off"));

      if (this.mode === "demo") {
        var saved = WP.store.readJSON(HA_STATE_KEY, {}) || {};
        saved[id] = e.on;
        WP.store.writeJSON(HA_STATE_KEY, saved);
      } else {
        var self = this;
        /* encodeURIComponent, like the states fetch at stepLive(). The domain is derived
           from a config-supplied entity id, so it is not attacker-controlled in any real
           sense — but it IS the only place in the file that interpolated a config string
           into a URL raw, and a lone exception is how a rule stops being a rule. */
        this.haFetch(this.base + "/api/services/" + encodeURIComponent(e.domain)
              + "/turn_" + (e.on ? "on" : "off"), {
          method: "POST",
          body: JSON.stringify({ entity_id: id })
        })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); })
          .catch(function (err) {
            /* The tile flipped optimistically a moment ago and the switch did not actually
               move, so the tile is now showing something that is not true. Mark it exactly
               the way a failed poll would — the next successful poll clears it and puts the
               real state back. */
            e.err = err.message;
            self.stale = true;
            if (!self.staleSince) self.staleSince = Date.now();
            self.setBadge();
            WP.status("Could not switch " + e.label + " — " + self.liveError([e]), true);
            self.render();
            self.paintPanel();
          });
      }
      this.render();
      this.paintPanel();
    },

    find: function (id) {
      for (var i = 0; i < this.ents.length; i++) if (this.ents[i].id === id) return this.ents[i];
      return null;
    },

    /* Duty cycle has to be time-weighted, not a mean of samples: a toggle records an extra
       off-grid sample at the moment it is pressed, and an unweighted mean would count that
       instant as heavily as a 30 s interval. */
    duty: function (hist) {
      if (!hist || hist.length < 2) return null;
      var on = 0, total = 0;
      for (var i = 1; i < hist.length; i++) {
        var dt = hist[i].t - hist[i - 1].t;
        if (dt <= 0) continue;
        total += dt;
        if (hist[i - 1].v >= 0.5) on += dt;
      }
      return total ? on / total : null;
    },
    lastChange: function (hist) {
      for (var i = (hist || []).length - 1; i > 0; i--) {
        if ((hist[i].v >= 0.5) !== (hist[i - 1].v >= 0.5)) return hist[i].t;
      }
      return null;
    },

    /* The simulator models °F natively. Convert on the way out so demo entities honour the
       unit setting like everything else on the panel. A real Home Assistant reports its own
       units, so this only ever applies in demo mode. */
    isDemoF: function (e) { return sensors.mode === "demo" && e.unit === "°F"; },
    out: function (e, v) {
      if (v == null) return null;
      return (sensors.isDemoF(e) && S.isMetric()) ? (v - 32) * 5 / 9 : v;
    },
    outUnit: function (e) {
      return (sensors.isDemoF(e) && S.isMetric()) ? "°C" : (e.unit || "");
    },

    /* On/off entities draw the filled glyph only while they are actually on. */
    glyph: function (e) {
      return (e.iconOff && !e.on) ? e.iconOff : e.icon;
    },
    isOffish: function (e) {
      return (e.kind === "toggle" || e.kind === "binary") && !e.on;
    },

    display: function (e) {
      if (e.kind === "toggle") return e.on ? "On" : "Off";
      if (e.kind === "binary") return e.on ? (e.def.onText || "On") : (e.def.offText || "Off");
      if (e.value == null) return "--";
      /* Fixed decimals, not Math.round: dropping the trailing zero changed the string
         width, so the column jittered "72" / "71.9" / "72.1" every 30 s (and "22 °C"
         beside "20.2 °C"). Same rule is used for the min/max/mean stats below. */
      return Number(sensors.out(e, e.value)).toFixed(e.dp || 0);
    },

    render: function () {
      var box = $("sensors");
      if (!box) return;
      if (!this.ents.length) {
        box.innerHTML = '<div class="muted">No entities configured.</div>';
        return;
      }
      /* Skip this frame if a finger is down: replacing a tile mid-press would move the
         click target out from under the user and swallow the tap. */
      if (WP.touching()) return;
      /* The card shows the FIRST FIVE entities (config order decides which); the panel
         has everything. The second row of tiles became the news ticker's height — and a
         wall of ten look-alike tiles was the least glanceable card on the panel anyway. */
      box.innerHTML = this.ents.slice(0, 5).map(function (e) {
        var isSwitch = (e.kind === "toggle");
        var stale = !!e.err;
        /* toggles act on tap; readings open the detail panel */
        var attrs = isSwitch
          ? 'data-ns="sensors" data-act="toggle" data-arg="' + esc(e.id) + '"'
            + ' role="switch" aria-checked="' + (e.on ? "true" : "false") + '"'
          : 'data-open="sensors" data-arg="' + esc(e.id) + '"';
        /* The tile is a glyph, a name, a number and a unit stacked in one button. Spoken
           straight through that is "◆ FAN Off" with a symbol read aloud; the glyph is
           decorative (it duplicates the on/off the switch state already carries) so it is
           hidden, and the tile gets one sentence. */
        var name = e.short || e.label;
        var aria = name + " " + sensors.display(e) + " " + sensors.outUnit(e)
          + (stale ? " (not updating)" : "");
        return '<button class="sensor tappable' + (isSwitch ? " has-sw" : "")
          + (isSwitch && e.on ? " on" : "")
          + (stale ? " stale" : "")
          + (e.kind === "binary" && e.on ? " alertish" : "") + '" ' + attrs
          + ' aria-label="' + esc(aria.replace(/\s+/g, " ").trim()) + '">'
          + '<div class="sensor-label"><span aria-hidden="true">' + sensors.glyph(e)
          + "</span> " + esc(name) + "</div>"
          + '<div class="sensor-value">' + esc(sensors.display(e))
          + '<span class="sensor-unit">' + esc(sensors.outUnit(e)) + "</span></div>"
          + (isSwitch ? '<div class="sensor-sw" aria-hidden="true"><span></span></div>' : "")
          + "</button>";
      }).join("");
    },

    onOpen: function (panel, arg) {
      this.panel = panel;
      this.sel = arg || (this.ents[0] && this.ents[0].id);
      this.paintPanel();
    },
    onClose: function () { this.panel = null; },

    /* The panel's one subtitle line, in a person's words. It used to read
       "DEMO — simulated entities, no token configured" and "live · http://10.x.x.x:8123":
       one is a build state, the other is a URL. Neither is what somebody standing in front
       of a wall panel wants to know, which is whether these numbers are true right now. */
    panelSub: function (e) {
      /* ONE demo notice, not two. This line used to say "nothing here is really happening"
         while an orange banner fifteen centimetres below it said "the switches really do
         change the readings" — both true, read together as a contradiction, and the reader
         has to reconcile them before they can trust either. The banner is now reserved for
         a genuine alert (a live feed that has stopped answering), and the demo state is
         stated once, here, in a sentence that does not argue with itself. */
      if (this.mode === "demo") return "Demo data — simulated readings you can still switch";
      if (this.stale) {
        var at = (e && e.okAt) || this.lastOkAt;
        return at ? "Not updating — last answered " + fmt.ago(at) : "Not updating";
      }
      /* a clock time, not an age: see the note on weather.panelSub — "updated 0s ago"
         re-rendered every second and could not be read at the size it is set in */
      return this.lastOkAt
        ? "Live — updated " + fmt.clock(new Date(this.lastOkAt), false) : "Live";
    },

  };


  /* Registered while the file parses so boot() locks it into the shell's allowlist:
     the bridge fetch refuses any origin not on the list, including this one if the
     config had no baseUrl at boot. */
  (function () {
    var ha = WP.C.homeAssistant || {};
    if (ha.enabled && ha.baseUrl) {
      var o = WP.originOf(ha.baseUrl);
      if (o) WP.fetchOrigins.push(o);
    }
  })();

  WP.register(sensors);
})();
