/* Wall panel dashboard — STOPWATCH & TIMER.

   Timekeeping is done from Date.now() deltas rather than by counting ticks, so it stays
   correct even if the WebView throttles the interval while a panel is closed. Owns the
   full-screen alarm overlay as well as its own panel.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var $ = WP.$, fmt = WP.fmt;
  var ui = WP.ui;
  var section = ui.section, btn = ui.btn, segmented = ui.segmented;

  var timer = {
    name: "timer",
    mode: "stopwatch",
    sw: { running: false, startedAt: 0, base: 0, laps: [] },
    cd: { running: false, endsAt: 0, remain: 5 * 60000, duration: 5 * 60000 },
    ringing: false,
    finishedAt: 0,
    lastCardPaint: 0,
    lastKey: "",
    audio: null,

    /* How long the alarm overlay may hold the whole screen with nobody in front of it, and
       how long the home tile then remembers that it fired. See fireAlarm / paintCard. */
    ALARM_IDLE_MS: 60000,
    TRACE_MS: 30 * 60000,

    init: function () {
      var self = this;
      setInterval(this.tick.bind(this), 100);

      /* The alarm overlay is not a panel, but it covers the dashboard exactly like one, so
         it registers with the same idle unwind instead of inventing its own timeout. 60s
         rather than the panels' 90s: it is the loudest thing the app can put on screen and
         it hides everything, so it earns less patience. */
      WP.registerIdleLayer({
        name: "alarm",
        ms: this.ALARM_IDLE_MS,
        isOpen: function () { return self.ringing; },
        close: function () { self.stopAlarm(); },
        toast: "Timer finished — dashboard restored"
      });

      /* All in-panel buttons funnel through one handler keyed by data-act. */
      WP.onAction("timer", function (act, arg) {
        var cd = self.cd, sw = self.sw;
        switch (act) {
          case "mode":      self.mode = arg; break;
          case "sw-toggle":
            if (sw.running) { sw.base = self.swElapsed(); sw.running = false; }
            else { sw.startedAt = Date.now(); sw.running = true; }
            break;
          case "sw-lap":
            if (sw.running) { sw.laps.unshift(self.swElapsed()); if (sw.laps.length > 30) sw.laps.pop(); }
            break;
          case "sw-reset":  sw.running = false; sw.base = 0; sw.laps = []; break;
          case "cd-preset": cd.duration = parseInt(arg, 10) * 1000; self.cdReset(); break;
          case "cd-bump":
            var delta = parseInt(arg, 10) * 1000;
            if (cd.running) { cd.endsAt = Math.max(Date.now(), cd.endsAt + delta); }
            /* Floor of one minute, not one second. At 1:00, "−1 min" used to leave a
               00:01 countdown — a timer nobody set on purpose, and one that fires its
               full-screen alarm a second after you look away. The buttons step in
               minutes, so the floor is a minute. */
            else { cd.duration = Math.max(60000, cd.duration + delta); cd.remain = cd.duration; }
            break;
          case "cd-toggle":
            if (cd.running) { cd.remain = Math.max(0, cd.endsAt - Date.now()); cd.running = false; }
            else {
              if (cd.remain <= 0) cd.remain = cd.duration;
              cd.endsAt = Date.now() + cd.remain; cd.running = true;
              self.ringing = false; self.finishedAt = 0;
            }
            break;
          /* Order matters, but not for the reason it is easy to assume. It is not that
             stopAlarm() would overwrite the reloaded duration — it is that cdReset() clears
             `ringing`, and stopAlarm() early-returns unless `ringing` is set. Reset-while-
             ringing with these two swapped therefore reloads the duration correctly and
             leaves the full-screen alarm overlay on the wall forever. */
          case "cd-reset":  self.stopAlarm(); self.cdReset(); break;
          /* Dismiss on the full-screen alarm. It used to carry its own click listener,
             which is the one path the pointerup delegation never saw: a short tap worked
             and a 700ms hold — the way anybody presses a button on a wall — did nothing,
             because Chrome swallows the click once it decides the gesture was a long press.
             Routing it through data-act puts it on the same path as every other control. */
          case "alarm-dismiss": self.stopAlarm(); break;
        }
        self.renderPanel();
        self.paintCard();
      });
    },

    swElapsed: function () {
      return this.sw.base + (this.sw.running ? Date.now() - this.sw.startedAt : 0);
    },
    cdRemain: function () {
      return this.cd.running ? Math.max(0, this.cd.endsAt - Date.now()) : this.cd.remain;
    },
    cdReset: function () {
      this.cd.running = false;
      this.cd.remain = this.cd.duration;
      this.ringing = false;
      this.finishedAt = 0;
    },

    /* Milliseconds since a countdown finished, while that is still worth mentioning on the
       home tile — otherwise null. The tile used to read "00:00 / finished" from the moment
       an alarm was dismissed until somebody walked over and pressed Reset inside the panel
       (it survived a full settings reset), so the wall panel's default resting state became
       a stale report about a timer that had ended hours ago. Bounding it is what lets the
       alarm overlay take itself down without the fact that it fired being lost: the tile
       carries a quiet "finished 4m ago" for half an hour, then goes back to "tap to open". */
    trace: function () {
      if (!this.finishedAt) return null;
      var age = Date.now() - this.finishedAt;
      if (age > this.TRACE_MS) { this.finishedAt = 0; return null; }
      return age;
    },

    /* Everything the panel's button row / chip row is drawn from. The 10 Hz fast path only
       rewrites the digits, so any state that changes *outside* a button press (the alarm
       firing, the alarm being dismissed) has to be caught here or the buttons keep their
       old labels — which is how "Pause" ended up starting a countdown. */
    stateKey: function () {
      return [this.mode, this.sw.running ? 1 : 0, this.sw.laps.length,
              this.cd.running ? 1 : 0, this.ringing ? 1 : 0, this.cd.duration].join("|");
    },

    tick: function () {
      /* countdown reaching zero fires the alarm exactly once */
      if (this.cd.running && this.cdRemain() <= 0) {
        this.cd.running = false;
        this.cd.remain = 0;
        this.fireAlarm();
      }
      var open = WP.panels.isOpen("timer");
      var now = Date.now();
      /* 10 Hz while the panel is up (tenths are visible); 1 Hz for the home tile.
         The fast path only rewrites the two nodes that change — rebuilding the panel's
         markup ten times a second would replace buttons out from under a live tap, so a
         full re-render happens only when the control state itself moved (and never with a
         finger down; it will be picked up on the next tick). */
      if (open) {
        if (this.stateKey() !== this.lastKey && !WP.touching()) this.renderPanel();
        else this.tickPanel();
      }
      if (open || now - this.lastCardPaint > 950) { this.lastCardPaint = now; this.paintCard(); }
    },

    /* What was last written to the home tile. paintCard runs at 10 Hz with the panel open and
       1 Hz without it, and in the app's resting state ("00:00 / tap to open") every one of
       those writes is identical to the last. Comparing first turns the resting cost into two
       string comparisons. The comparison is on the rendered text, so anything that genuinely
       changes still lands on the same tick it always did. */
    shownBig: null,
    shownSub: null,
    shownAlert: null,

    paintCard: function () {
      var big = $("tmr-big"), sub = $("tmr-sub");
      if (!big) return;
      /* Priority: anything actually counting beats the memory of something that finished,
         which beats something merely parked. A stopwatch running through an alarm has to
         keep the tile — it is the live number. */
      var trace = this.trace();
      /* Every one of these strings has to SET in about eleven characters: six tiles share
         one line of the home column, so this one is 102 CSS px wide and "stopwatch running"
         needed 124 of its 80. The big line above already says which mode is showing — a
         clock reading 00:00.0 is the stopwatch and 04:59 counting down is the timer — so
         the word "stopwatch" was the tile spending its whole width on the thing it was
         least able to be wrong about. */
      var bigText, subText;
      if (this.ringing) {
        bigText = "00:00";
        subText = "TIMER DONE";
      } else if (this.cd.running) {
        bigText = fmt.countdown(this.cdRemain());
        subText = "counting";
      } else if (this.sw.running) {
        bigText = fmt.stopwatch(this.swElapsed(), false);
        subText = "running";
      } else if (trace != null) {
        /* the quiet trace: it fired, here is roughly when, and it expires by itself */
        bigText = "00:00";
        subText = trace < 60000 ? "just finished"
          : "done " + fmt.durationShort(trace) + " ago";
      } else if (this.cd.remain > 0 && this.cd.remain < this.cd.duration) {
        bigText = fmt.countdown(this.cd.remain);
        subText = "paused";
      } else if (this.swElapsed() > 0) {
        bigText = fmt.stopwatch(this.swElapsed(), false);
        subText = "paused";
      } else {
        bigText = "00:00";
        subText = "ready";
      }
      if (bigText !== this.shownBig) { this.shownBig = bigText; big.textContent = bigText; }
      if (subText !== this.shownSub) { this.shownSub = subText; sub.textContent = subText; }
      if (this.ringing !== this.shownAlert) {
        this.shownAlert = this.ringing;
        big.classList.toggle("alert", this.ringing);
      }
    },

    /* The countdown hitting zero and the alarm being dismissed both change which controls
       are legal, so both repaint the panel and the home tile instead of leaving the last
       button row on screen. */
    fireAlarm: function () {
      this.ringing = true;
      this.finishedAt = Date.now();
      $("alarm-sub").textContent = fmt.countdown(this.cd.duration) + " countdown elapsed";
      $("alarm").classList.add("show");
      /* Start the idle countdown on the overlay itself. Without this the alarm only ever
         came down when a human pressed Dismiss. */
      WP.armIdle();
      this.renderPanel();
      this.paintCard();
      this.beep();
    },
    /* Called by Dismiss, by a tap anywhere on the overlay, by Reset, and by the idle unwind
       — all four want the same thing, so there is one path. */
    stopAlarm: function () {
      if (!this.ringing) return;
      this.ringing = false;
      /* These two lines are an assertion, not a fix — be precise about that, because the
         comment that used to sit here ("anything else lets the next tap re-fire the same
         alarm") claimed work they do not do. `ringing` is only ever set by fireAlarm(), and
         tick() has already written running=false / remain=0 before calling it, so by the time
         any of the four dismiss paths reaches this line both values are already what it sets
         them to. Restating them costs nothing and keeps a future fireAlarm() caller from
         leaving a dismissed countdown running; the thing this function is actually FOR is the
         line below, which takes the overlay off the screen. */
      this.cd.running = false;
      this.cd.remain = 0;
      $("alarm").classList.remove("show");
      this.renderPanel();
      this.paintCard();
    },

    /* One AudioContext for the life of the page, created the first time an alarm actually
       needs to sound and reused afterwards, instead of a fresh context per alarm.

       Be precise about what this did and did not buy, because the reuse was originally
       written up as a fix for something it does not fix. Every ring still logs 4-5 of
       "AS.AudioService: Uncaught exception" from system_server — measured across three
       consecutive alarms, with the audio session id staying constant, so the context really
       is being reused and the exceptions are not tied to session creation. They come from
       Samsung's AudioServiceDumpProvider dumping AudioService on this ROM and throwing
       inside system_server while doing it; it is not this app's exception, nothing in the
       app's own logcat stream reports an error, and the chirp plays.

       What reuse is actually worth: one context rather than one per alarm (no unbounded
       accumulation of hardware clients over a wall panel's uptime), and an app run that
       never rings never opens audio at all. Keep it for those reasons.
       (MainActivity sets setMediaPlaybackRequiresUserGesture(false), and by the time a
       countdown ends the user has necessarily touched the panel, so no gesture is lost.) */
    openAudio: function () {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!this.audio) this.audio = new Ctx();
        if (this.audio.state === "suspended" && this.audio.resume) this.audio.resume();
      } catch (e) { this.audio = null; }
      return this.audio;
    },
    /* Short chirp. Optional by design — a muted or audio-less panel just gets the visual
       alarm, so any failure here is swallowed. */
    beep: function () {
      try {
        var ac = this.openAudio();
        if (!ac) return;
        [0, 0.35, 0.7].forEach(function (offset) {
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = "sine"; o.frequency.value = 880;
          g.gain.setValueAtTime(0.001, ac.currentTime + offset);
          g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + offset + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + offset + 0.25);
          o.connect(g); g.connect(ac.destination);
          o.start(ac.currentTime + offset); o.stop(ac.currentTime + offset + 0.3);
        });
      } catch (e) { /* no audio on this panel — visual alarm still fires */ }
    },

    onOpen: function (panel) {
      this.panel = panel;
      this.renderPanel();
    },
    onClose: function () { this.panel = null; },

    /* Fast path: only the digits (and the countdown bar) move between frames. */
    tickPanel: function () {
      var disp = $("tmr-disp");
      if (!disp) { this.renderPanel(); return; }
      if (this.mode === "stopwatch") {
        var ms = this.swElapsed();
        var core = $("tmr-core"), tenths = $("tmr-tenths");
        if (!core || !tenths) { this.renderPanel(); return; }
        var c = fmt.stopwatch(ms, false), t = "." + (Math.floor(ms / 100) % 10);
        if (core.textContent !== c) core.textContent = c;
        if (tenths.textContent !== t) tenths.textContent = t;
      } else {
        var r = this.cdRemain();
        disp.textContent = fmt.countdown(r);
        var fill = $("tmr-bar");
        if (fill) fill.style.width =
          (this.cd.duration ? Math.max(0, Math.min(100, (r / this.cd.duration) * 100)) : 0) + "%";
        var box = $("tmr-box");
        if (box) box.classList.toggle("alarm-flash", this.ringing);
      }
    },

    renderPanel: function () {
      var self = this;
      var panel = this.panel || WP.panels.el("timer");
      if (!panel || !WP.panels.isOpen("timer")) return;
      this.lastKey = this.stateKey();
      var body = WP.qs("[data-body]", panel);
      WP.qs("[data-sub]", panel).textContent =
        this.mode === "stopwatch" ? "counting up" : "counting down";

      /* Mode switch, readout and controls are one pinned cluster (.stick) under the panel
         header; only the lap list scrolls. Past ~9 laps the list used to push the running
         time AND the Lap button off the top, so reading lap 1 cost you the control you
         needed to take lap 15. The mode tabs are inside the pinned block rather than above
         it because .stick cancels the panel body's top padding with a negative margin —
         anything left above it gets painted over. */
      /* `roomy` while there is no lap list to make room for: the pinned cluster grows and
         the readout centres in it, so the space the lap table is not using goes to the one
         number this screen exists for rather than staying black. See the CSS. */
      var roomy = (this.mode === "stopwatch" && !this.sw.laps.length);
      var html = '<div class="stick' + (roomy ? " roomy" : "") + '">'
        + segmented("timer", "mode", [["stopwatch", "Stopwatch"], ["countdown", "Timer"]],
                    this.mode, "Mode");

      if (this.mode === "stopwatch") {
        var e = this.swElapsed();
        /* The tenths are their own span, a ramp step down and a shade dimmer. At the same
           size as the minutes they were a 130 px digit changing ten times a second, for
           ever, on an AMOLED panel — the brightest strobing object in the app, and the
           least useful glyph on the screen: nobody reads tenths from 3 m, they watch them
           move. Small enough to still say "this is running", small enough not to shout. */
        html += '<div class="big-readout"><div class="big-time mono" id="tmr-disp">'
          + '<span id="tmr-core">' + fmt.stopwatch(e, false) + "</span>"
          + '<span class="tenths" id="tmr-tenths">.' + (Math.floor(e / 100) % 10)
          + "</span></div></div>"
          /* Start/Stop is the PRIMARY, and it is marked by weight rather than by hue.
             It was a green pill, which spent a fifth colour on an affordance and broke the
             rule that a hue on this wall means a datum; removing the green was right, and
             replacing it with nothing was not — the screen was then three identical
             hairline pills with only Lap dimmed, i.e. a stopwatch with no obvious way to
             start it. A neutral fill is the same treatment Settings' selected unit and a
             selected chip already use, so it is one idiom rather than a new one. */
          + '<div class="btn-row">'
          + btn("sw-toggle", this.sw.running ? "Stop" : "Start", "fill", null, "timer")
          + btn("sw-lap", "Lap", this.sw.running ? "" : "off", null, "timer")
          + btn("sw-reset", "Reset", "", null, "timer")
          + "</div></div>";
        /* Splits are differences of the *displayed* totals, so the two columns always
           reconcile — see fmt.swQuantise.
           The list is given the whole remainder of the panel (.laps-sec), and with no laps
           yet its one line of guidance is centred in that space. D2: this screen was ~55%
           dead black below that sentence, which at 2-4 m reads as content that failed to
           load rather than as a stopwatch waiting for you. */
        if (this.sw.laps.length) {
          html += section("Laps (" + this.sw.laps.length + ")",
            '<div class="laps">' + this.sw.laps.map(function (t, i, arr) {
              var cur = fmt.swQuantise(t), prev = fmt.swQuantise(arr[i + 1] || 0);
              return '<div class="lap"><span class="lap-n">#' + (arr.length - i) + "</span>"
                + '<span class="lap-t mono">' + fmt.stopwatch(cur, true) + "</span>"
                + '<span class="lap-d mono">+' + fmt.stopwatch(cur - prev, true) + "</span></div>";
            }).join("") + "</div>", "laps-sec");
        } else {
          /* NO FRAME until there is something to frame. The region is still reserved — it
             keeps its heading and its share of the column, so the layout does not jump when
             lap 1 lands — but it is no longer RULED while it is empty.

             The ruled version was an answer to a real defect (a 747 device px band of
             undifferentiated black, 29% of the frame) and it was the wrong answer: seven
             full-width hairlines at a 142 px pitch with nothing on any of them measured
             8.5% of all the ink on the screen and ~40% of its height. Rules are not
             content. An empty ruled notepad on a wall panel does not read as "waiting for
             a lap", it reads as a table that failed to load — the same thing the black band
             read as, drawn in more pixels. On the one screen in the build whose entire
             subject is a single number, the honest use of that space is the number, which
             is why the readout above is the largest type in the app. */
          html += section("Laps", '<div class="laps-hint"><div class="muted">'
            + "Tap Lap while running to split.</div></div>", "laps-sec laps-empty");
        }

      } else {
        var r = this.cdRemain();
        var pct = this.cd.duration ? (r / this.cd.duration) * 100 : 0;
        html += '<div class="big-readout' + (this.ringing ? " alarm-flash" : "") + '" id="tmr-box">'
          + '<div class="big-time mono" id="tmr-disp">' + fmt.countdown(r) + "</div>"
          /* A full accent bar on an untouched timer read as "finished", not as "ready":
             a progress bar at 100% means done everywhere else on a screen. It stays full —
             all the time IS remaining — but it is only lit once the countdown has actually
             been started, so full-and-grey is armed and full-and-blue is running. */
          + '<div class="bar" role="img" aria-label="time remaining"><div class="bar-fill'
          + (this.cd.running || r < this.cd.duration ? " accent" : "") + '"'
          + ' id="tmr-bar" style="width:' + pct.toFixed(1) + '%"></div></div></div>'
          + '<div class="btn-row">'
          + btn("cd-toggle", this.cd.running ? "Pause" : "Start", "", null, "timer")
          + btn("cd-bump", "+1 min", "", 60, "timer", "add one minute")
          + btn("cd-bump", "&minus;1 min", "", -60, "timer", "take off one minute")
          + btn("cd-reset", "Reset", "", null, "timer")
          + "</div></div>"
          /* Chips, not buttons: a preset is a *choice*, so the one currently loaded is
             highlighted the same way every other segmented control in the app is.
             +1/-1 min moves the duration off every preset, and then none is lit. */
          /* cols4: eight presets on a wrapping row broke 6 + 2. Two rows of four. */
          + section("Presets", '<div class="chip-row cols4">'
              + [1, 3, 5, 10, 15, 20, 30, 60].map(function (m) {
                  var on = self.cd.duration === m * 60000;
                  return '<button class="chip tappable' + (on ? " on" : "") + '"'
                    + ' aria-pressed="' + (on ? "true" : "false") + '"'
                    + ' data-ns="timer" data-act="cd-preset" data-arg="' + (m * 60) + '">'
                    + m + " min</button>";
                }).join("") + "</div>");
      }
      /* Scroll-preserving: taking lap 15 rebuilds this whole body, and dropping the offset
         would throw a reader who had scrolled back to lap 1 up to the top. */
      WP.repaint(body, html);
    }
  };

  WP.register(timer);
})();
