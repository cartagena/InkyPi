/* Wall panel dashboard — DEVICE.

   Real values through the Android JS bridge. MainActivity exposes one deviceInfo() call
   returning a JSON snapshot; doing it in a single call keeps the JS/Java hop off the
   render path.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var $ = WP.$, esc = WP.esc, fmt = WP.fmt, S = WP.settings;
  var ui = WP.ui;
  var statGrid = ui.statGrid, section = ui.section, hero = ui.hero, bar = ui.bar;

  /* A battery that is as full as the battery is. Drawn rather than typed, because no text
     glyph carries a level: the shell (the same 1px hairline the cards use), a terminal nub,
     and a fill whose WIDTH is the charge.

     Colour follows the one rule the app has for it: danger under 20%, otherwise --fg.
     Charging used to paint the fill var(--accent) — which style.css documents, in a comment
     on the token itself, as the same hex as --temp-cold. So the one screen in the build
     whose panel comment states "blue means cold" was the one screen that broke it: a blue
     battery on a wall where blue is a low temperature everywhere else. Charging does not
     need a hue anyway; the bolt drawn through the fill already says it, in a shape nobody
     has to learn. */
  function batteryIcon(b) {
    var pct = Math.max(0, Math.min(100, b.level == null ? 0 : b.level));
    var fill = pct < 20 ? "var(--danger)" : (b.charging ? "var(--fg)" : "var(--dim)");
    var w = (pct / 100) * 40;
    return '<svg class="wxi" viewBox="0 0 64 64">'
      + '<rect x="8" y="20" width="44" height="24" rx="4" fill="none"'
      + ' stroke="var(--card-line2)" stroke-width="3"/>'
      + '<rect x="54" y="28" width="4" height="8" rx="1.5" fill="var(--card-line2)"/>'
      + '<rect class="bat-fill" x="10" y="22" width="' + w.toFixed(1)
      + '" height="20" rx="2" fill="' + fill + '"/>'
      + (b.charging
          ? '<path d="M34 22 L24 34 L31 34 L28 42 L38 30 L31 30 Z" fill="var(--bg)"/>'
          : "")
      + "</svg>";
  }

  var system = {
    name: "system",
    info: null,
    lastPoll: 0,
    shownBig: null,
    shownSub: null,

    /* Two cadences. The panel is a live readout and wants 5 s; the home tile carries a
       battery percentage, free storage, uptime rounded to the largest unit, and a network
       type — none of which is meaningfully wrong at 60 s, and three of which move slower
       than that.

       The old single 5 s cadence crossed the JS/Java boundary ~17,300 times a day and
       re-rendered the tile every time, whether the panel was open or not and whether
       anything had changed or not. Nothing on the wall was better for it: with the panel
       closed the tile changed maybe 300 times in that day.

       The timer itself still fires at 5 s so that opening the panel gets a fresh reading
       within one tick rather than up to a minute later — what backs off is the JNI call and
       the render, not the callback. */
    POLL_OPEN_MS: 5000,
    POLL_IDLE_MS: 60000,

    init: function () {
      this.refresh();
      setInterval(this.tick.bind(this), this.POLL_OPEN_MS);
    },

    tick: function () {
      var due = WP.panels.isOpen("system") ? this.POLL_OPEN_MS : this.POLL_IDLE_MS;
      /* 100 ms of tolerance: setInterval jitter must not push a poll a whole period late. */
      if (Date.now() - this.lastPoll < due - 100) return;
      this.refresh();
    },

    refresh: function () {
      this.lastPoll = Date.now();
      this.info = WP.bridge.json("deviceInfo");
      this.render();
      this.paintPanel();
    },

    render: function () {
      var big = $("sys-big"), sub = $("sys-sub");
      if (!big) return;
      var i = this.info;
      if (!i) {
        this.put(big, sub, "n/a", WP.bridge.present() ? "sensor error" : "no device link");
        return;
      }
      /* "↯" (U+21AF), not "⚡" (U+26A1): the latter is an emoji-presentation codepoint and
         Android drew it as a colour sprite in an otherwise monochrome tile row. */
      this.put(big, sub,
        (i.battery && i.battery.level != null ? i.battery.level : "--") + "%"
          + (i.battery && i.battery.charging ? " ↯" : ""),
        /* ONE fact, not three. Six tiles share one line of the home column, so a tile is
           102 CSS px wide and its sub-line has room for about eleven characters —
           "104 GB · 21h up · Wi-Fi" needed 152 px of an 80 px box and rendered as
           "104 GB · …", which is a tile with no content strategy, only a clamp. Uptime and
           the network are one tap away on this widget's own panel; free storage is the one
           of the three that can actually go wrong quietly. Even "104 GB free" measured 82 px
           of that 80 — the word went and the figure stayed, because under a heading that
           says DEVICE and a value that says 83%, a figure in GB is not ambiguous. */
        fmt.bytes(i.storage && i.storage.free));
    },

    /* Dirty-checked tile write. A poll that finds nothing changed — which is most of them,
       since the tile's coarsest field is a whole percent — should cost no DOM writes at all. */
    put: function (big, sub, bigText, subText) {
      if (bigText !== this.shownBig) { this.shownBig = bigText; big.textContent = bigText; }
      if (subText !== this.shownSub) { this.shownSub = subText; sub.textContent = subText; }
    },

    onOpen: function (panel) {
      this.panel = panel;
      /* The tile may be up to POLL_IDLE_MS stale when the panel is opened, and the panel is
         the detailed view of exactly that data — so take a reading now rather than showing a
         minute-old battery voltage until the next tick. */
      this.refresh();
    },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("system");
      /* refreshes every 5 s — skip while a finger is down, keep the scroll position */
      if (!panel || !WP.panels.isOpen("system") || WP.touching()) return;
      var body = WP.qs("[data-body]", panel);
      var i = this.info;

      if (!i) {
        WP.qs("[data-sub]", panel).textContent = "device sensors unavailable";
        body.innerHTML = '<div class="muted">This panel reads the tablet’s own battery, '
          + "storage and network, and that link is not available right now. Everything else "
          + "on the dashboard still works. Reinstalling the app restores it.</div>";
        return;
      }

      /* Uptime is a fact about this device, and the subtitle is where this panel already
         says what device it is. It had a section of its own — headed UPTIME, holding a cell
         labelled UPTIME and a cell labelled AWAKE that printed the identical string, because
         a wall panel never sleeps. One heading and two cells to say one thing twice, on a
         panel that was 75 px past the bottom of the frame once the values were re-scaled for
         a 3 m read. The awake share is kept as a share, which is the form in which it can
         differ from uptime and therefore the form in which it is worth printing. */
      var awakePct = i.uptimeMs ? Math.round((i.awakeMs || 0) / i.uptimeMs * 100) : null;
      WP.qs("[data-sub]", panel).textContent =
        (i.device && i.device.model ? i.device.model : "device")
        + " · Android " + (i.device ? i.device.android : "?")
        + " · up " + fmt.duration(i.uptimeMs || 0)
        + (awakePct == null ? "" : ", " + awakePct + "% awake");

      var b = i.battery || {}, st = i.storage || {}, mem = i.memory || {}, net = i.network || {};
      var stUsed = (st.total && st.free != null) ? st.total - st.free : 0;
      var stPct = st.total ? (stUsed / st.total) * 100 : 0;
      var memUsed = (mem.total && mem.free != null) ? mem.total - mem.free : 0;
      var memPct = mem.total ? (memUsed / mem.total) * 100 : 0;

      WP.repaint(body,
        /* The hero glyph is DRAWN from the level (see batteryIcon). It used to be the
           text glyph "▭" — a hollow rectangle, no fill and no terminal, sitting beside
           "83%". At a glance the icon won and the tablet read as flat. An icon whose whole
           job is to show a level, showing no level, is worse than no icon. */
        hero(batteryIcon(b),
             (b.level != null ? b.level : "--") + "%",
             esc(b.status || "") + (b.plugged ? " · " + esc(b.plugged) : ""))
        /* No battery BAR. The icon is drawn to the level, the number beside it says the
           level, and a bar underneath was the same fact a third time — 40 px of a panel
           that was overflowing, spent on repetition. Storage and memory keep their bars,
           because there the bar is the only picture of the figure. */

        /* Two cells, down from eight. The four that went first were the hero again in other
           words (LEVEL, CHARGING, STATUS, PLUGGED). VOLTAGE and CELLS went next: 4.095 V is
           a figure nobody owning a tablet can act on, and "Li-ion" is the same word every
           day for the life of the device. Temperature and health are the two that can
           actually change your mind about the thing on your wall.

           TWO cells in a TWO-column grid. They were two cells in a three-column one, which
           filled columns 1 and 2 and left column 3 empty on a panel where STORAGE, MEMORY
           and NETWORK all filled three — a hole in the grid rather than a shorter row. */
        + section("Battery", statGrid([
            ["Temperature", b.tempC != null
              ? (S.isMetric() ? (Math.round(b.tempC * 10) / 10) + " °C"
                              : (Math.round((b.tempC * 9 / 5 + 32) * 10) / 10) + " °F") : "--"],
            ["Health", esc(b.health || "--")]
          ], 2))

        /* All three bars on this screen fill with what is LEFT, so more is better on every
           one of them. Storage and memory used to fill with what was USED while the battery
           filled with what remained: three grey bars at three lengths, two of them meaning
           the opposite of the one above, and no way to tell from across the room which
           direction was healthy. */
        /* TWO cells, and the total moved into the heading. Free + used + total is three
           figures of which any two determine the third, printed side by side — the grid was
           doing arithmetic homework out loud. The total is the one that never changes, so it
           belongs where a constant belongs: naming the thing, not filling a cell.

           The heading also names the bar's DIRECTION. A nearly-full bar beside "FREE 104 GB"
           reads as "nearly full" to every human alive, and this bar fills with what is left,
           so it says so: STORAGE FREE · 128 GB. */
        + section("Storage free · " + fmt.bytes(st.total),
            bar(100 - stPct, "", "storage free") + statGrid([
            ["Free", fmt.bytes(st.free)],
            ["Used", fmt.bytes(stUsed)]
          ], 2))

        + section("Memory free · " + fmt.bytes(mem.total),
            bar(100 - memPct, "", "memory free") + statGrid([
            ["Free", fmt.bytes(mem.free)],
            ["Used", fmt.bytes(memUsed)]
          ], 2))

        /* "Interface wlan0" is the kernel's name for the radio. Dropped — TRANSPORT above
           it already says Wi-Fi, which is the same fact in a word people use. Down and up
           are one cell for the same reason a hi/lo is one cell: they are one measurement of
           one link, and as two cells they spilled the grid onto a second row that the
           screen did not have. */
        + section("Network", statGrid([
            ["Transport", esc(net.type || "none")],
            ["Internet", net.validated ? "Working" : "No connection"],
            ["Speed", (net.downKbps ? Math.round(net.downKbps / 1000) : "--") + " / "
              + (net.upKbps ? Math.round(net.upKbps / 1000) : "--"), "Mbps down / up"]
          ], 3))

        );
    }
  };

  WP.register(system);
})();
