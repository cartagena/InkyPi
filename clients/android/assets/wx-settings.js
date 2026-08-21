/* Wall panel dashboard — SETTINGS.

   Real, persisted, applied immediately. One idiom per concept: a segmented control only
   for a genuine either/or between two named values, a switch row for everything that is
   merely on or off.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows writes
   the separator as a backslash and file:///android_asset/ cannot resolve it). The plugin
   contract is unchanged and is documented in wx-ui.js.
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc, S = WP.settings;
  var ui = WP.ui;
  var section = ui.section, btn = ui.btn, segmented = ui.segmented,
      switchRow = ui.switchRow;

  var settingsPlugin = {
    name: "settings",
    resetArmed: false,
    resetTimer: null,

    init: function () {
      var self = this;
      this.renderCard();
      S.onChange(function () { self.renderCard(); self.paintPanel(); });

      WP.onAction("settings", function (act, arg) {
        /* Any other setting touched means the user is not resetting — disarm. */
        if (act !== "reset" && self.resetArmed) self.disarmReset();

        switch (act) {
          /* Two shapes of control, and which one a setting gets is decided by the setting,
             not by the screen it happens to sit on (D1):
               units / hours  a genuine either/or between two NAMED values -> segmented,
                              and the action carries which value was chosen;
               secs / burn / widget  simply on or off -> a switch row, and the action is a
                              toggle. Passing an explicit "1"/"0" here would mean the row
                              and the stored value could disagree if a repaint were missed. */
          case "units":  S.set("units", arg); break;
          case "hours":  S.set("clockHours", parseInt(arg, 10)); break;
          case "secs":   S.set("seconds", !S.get("seconds")); break;
          case "burn":   S.set("burnIn", !S.get("burnIn")); break;
          case "sky":    S.set("sky", !S.get("sky")); break;
          case "cycle":  S.set("cycle", !S.get("cycle")); break;
          case "widget": S.setShow(arg, !S.get("show")[arg]); break;
          /* Two-step. This panel is mounted on a wall where anyone walking past can reach
             it, and one tap on a red button used to wipe every preference with no warning
             and no undo. The armed state expires on its own after 5 s. */
          case "reset":
            if (self.resetArmed) {
              self.disarmReset();
              S.reset();
              WP.toast("Settings reset to defaults");
            } else {
              self.resetArmed = true;
              clearTimeout(self.resetTimer);
              self.resetTimer = setTimeout(function () {
                self.resetArmed = false;
                self.paintPanel();
              }, 5000);
              WP.toast("Tap again to confirm reset");
            }
            break;
        }
        self.paintPanel();
      });
    },

    disarmReset: function () {
      this.resetArmed = false;
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    },

    /* The tile's value line is the unit, because that is the setting this dashboard wears
       everywhere else and the one somebody walks up to change. The sub-line carries the
       clock format and, only when there is one, the count of switched-off widgets — which
       is the answer to "why is the moon gone", and the only reason this tile is ever
       urgent. Eleven characters is the whole budget: the tile is 102 CSS px wide. */
    renderCard: function () {
      var big = $("set-big"), el = $("set-sub");
      if (!el) return;
      var hidden = WP.WIDGETS.filter(function (w) { return !S.get("show")[w]; }).length;
      if (big) big.textContent = S.isMetric() ? "°C" : "°F";
      el.textContent = S.get("clockHours") + "h" + (hidden ? " · " + hidden + " off" : "");
    },

    onOpen: function (panel) { this.panel = panel; this.disarmReset(); this.paintPanel(); },
    onClose: function () { this.panel = null; this.disarmReset(); },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("settings");
      if (!panel || !WP.panels.isOpen("settings")) return;
      var body = WP.qs("[data-body]", panel);
      /* D4 — this line used to read "saved to localStorage — survives a force-stop", which
         is a commit message, not something to tell somebody adjusting a thermostat panel. */
      WP.qs("[data-sub]", panel).textContent = "Changes are kept after a restart";

      var show = S.get("show");
      var rows = WP.WIDGETS.map(function (w) {
        return switchRow("settings", "widget", WP.WIDGET_LABELS[w], !!show[w], w);
      }).join("");

      var b = C.burnInProtection || {};

      WP.repaint(body,
        /* Units and Clock share one section and one line. They were two sections, one under
           the other, each with its own heading over a single pair of buttons — 314 CSS px
           of a screen that was overflowing by 1157. They are the same KIND of thing (a
           choice between two named values), which is exactly why they belong on one row.
           A switch for everything that is merely on or off, including the one that used to
           sit here as "Hide seconds | Show seconds" — a pair of buttons for a boolean, two
           rows above a column of switches for the same thing (D1). */
        section("Units & clock", '<div class="seg-pair">'
          /* Two glyphs and two figures, not "°F  mph  inHg" and "12-hour": three controls
             share this line and a label that wraps to two lines inside a button makes the
             whole row taller than the thing it is labelling. The units each choice implies
             are on screen already, on every panel behind this one. */
          + segmented("settings", "units",
              [["fahrenheit", "°F"], ["celsius", "°C"]], S.get("units"), "Units")
          + segmented("settings", "hours",
              [[12, "12h"], [24, "24h"]], S.get("clockHours"), "Clock format")
          + '<div class="srows">'
          + switchRow("settings", "secs", "Seconds", !!S.get("seconds"))
          + "</div></div>")

        /* D5 — one line, not five. The five-line version explained AMOLED ghosting, the
           nudge distance, the interval, the finger rule and the 90 s idle unwind, on a
           settings screen. All of it is still in INTERACTIVE.md, where somebody who wants
           it will look. Each note is now short enough to SET on one line as well: three
           notes wrapping to two lines each was 84 px, and this panel had none to spare. */
        /* Two of the three notes are gone into their own labels: a note that restates its
           switch is a line of type doing nothing, and this panel is a height budget. Only
           drifting the layout still needs a reason, because "Drift the layout" does not on
           its own explain why anybody would want it. */
        + section("Display", '<div class="srows">'
          + switchRow("settings", "sky", "Weather behind the cards", S.get("sky") === true)
          + switchRow("settings", "cycle", "Cycle screens every "
              + Math.round((C.cycle && C.cycle.seconds) || 20) + "s", !!S.get("cycle"))
          /* "so nothing burns in" wrapped in landscape and left "in." alone on a line of
             its own. The clause is the reason the setting exists, so it stays; what goes is
             the two words that made it a sentence longer than the row is wide. */
          + switchRow("settings", "burn", "Drift the layout", !!S.get("burnIn"), null,
              "A few pixels every "
              + Math.round((b.intervalSeconds || 120) / 60) + " minutes, against burn-in.")
          + "</div>")

        /* WP.repaint, not body.innerHTML: replacing the content outright drops the scroll
           offset, so toggling "Next days" jumped the panel back to UNITS and the next tap
           landed on a control the user was not aiming at. Same reason the sensors and
           device panels use it. */
        /* cols3: twelve full-width switch rows were 1005 px — a whole screen for a section
           that is a checklist. Same switch row, same target height, three across, and the
           labels are the words printed on the cards they control (see WIDGET_LABELS). */
        + section("Widgets", '<div class="srows cols3">' + rows + "</div>", "wide")

        /* The bottom strip: the one destructive control, and the one line saying what this
           dashboard is actually connected to. Both used to be sections with headings of
           their own — MAINTENANCE over a single button and ABOUT over two sentences, 108 px
           of headings for two objects that fit on one line together. When the reset is
           armed, the line beside it becomes what the button is about to do, which is the
           only moment either of them is worth reading. */
        + '<div class="pfoot"><div class="btn-row">'
            + btn("reset", this.resetArmed ? "Tap again to confirm" : "Reset to defaults",
                  "", null, "settings")
            + "</div>"
            + (this.resetArmed
                ? '<div class="muted">This clears units, clock format, burn-in and which '
                  + "widgets are shown. Tap anything else to cancel.</div>"
                : '<div class="muted">Home readings '
                  + (WP.registry.sensors.mode === "demo" ? "simulated" : "live")
                  + "; tablet sensors "
                  + (WP.bridge.present() ? "connected" : "not readable")
                  + ".</div>")
            + "</div>");
    }
  };

  WP.register(settingsPlugin);
})();
