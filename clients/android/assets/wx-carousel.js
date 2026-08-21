/* Wall panel dashboard — CAROUSEL (screens, swipes and the playlist).

   InkyPi's core behaviour is a playlist: one plugin fills the display, then the next one
   slides in. This file is that behaviour on glass. Every widget's detail panel doubles as
   a full screen: swipe left/right anywhere in an open panel to go to its neighbour (wrap-
   around, slide transition, position dots), and the optional CYCLE setting advances
   through the content screens on a dwell timer — the playlist proper.

   Not a widget: like the sky it has no card and no panel of its own; it registers only to
   be initialised. Navigation state lives in WP.panels — this file just decides WHEN to
   call swap()/open()/closeAll().

   One file, one job (assets/ cannot hold subdirectories — aapt2 on Windows writes the
   separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var C = WP.C;
  var S = WP.settings;

  var SWIPE_MIN = 70;          // CSS px of horizontal travel that count as a swipe
  var SWIPE_RATIO = 1.8;       // and it must be this much more horizontal than vertical
  var TOUCH_HOLDOFF = 45000;   // a person at the panel pauses the playlist this long

  /* The playlist skips the tool screens: cycling INTO Settings on a timer would move
     controls out from under the person using them, and Device/Timer are things you go
     to, not things that come to you. Manual swipes still reach all of them. */
  var TOOLS = { settings: true, system: true, timer: true };

  var carousel = {
    name: "carousel",
    lastTouch: 0,
    lastAdvance: 0,
    dotsTimer: 0,
    start: null,

    init: function () {
      var self = this;
      document.addEventListener("pointerdown", function (ev) {
        self.lastTouch = Date.now();
        self.start = WP.panels.top()
          ? { x: ev.clientX, y: ev.clientY, id: ev.pointerId,
              scroller: self.inSideScroller(ev.target) }
          : null;
      }, true);
      /* Panels scroll vertically, so Chrome may claim a horizontal pan as a scroll
         attempt and end it with pointercancel instead of pointerup — and a cancel does
         not reliably carry final coordinates. Track them ourselves and treat both ends
         of the gesture the same. */
      document.addEventListener("pointermove", function (ev) {
        if (self.start && ev.pointerId === self.start.id) {
          self.start.lx = ev.clientX; self.start.ly = ev.clientY;
        }
      }, true);
      document.addEventListener("pointerup", function (ev) { self.onUp(ev); }, true);
      document.addEventListener("pointercancel", function (ev) { self.onUp(ev); }, true);

      /* one slow tick drives the playlist; the dwell maths happens inside */
      setInterval(function () { self.tick(); }, 1000);
      this.lastAdvance = Date.now();

      S.onChange(function (k) {
        if (k === "cycle" && S.get("cycle")) self.lastAdvance = Date.now();
      });
    },

    /* screens a swipe can reach: every visible widget, dashboard order */
    screens: function () {
      var show = S.get("show");
      return WP.WIDGETS.filter(function (w) { return !!show[w]; });
    },

    /* screens the playlist visits: the content, not the tools */
    playlist: function () {
      return this.screens().filter(function (w) { return !TOOLS[w]; });
    },

    /* A swipe that begins inside a horizontally scrollable strip (the hour chips, the
       day tabs) is that strip's scroll, never navigation. */
    inSideScroller: function (node) {
      while (node && node.classList && !node.classList.contains("panel")) {
        if (node.scrollWidth > node.clientWidth + 4) return true;
        node = node.parentNode;
      }
      return false;
    },

    onUp: function (ev) {
      var st = this.start;
      this.start = null;
      if (!st || st.scroller || ev.pointerId !== st.id) return;
      if (!WP.panels.top()) return;
      var ex = (ev.clientX || ev.clientX === 0) && ev.type === "pointerup"
        ? ev.clientX : (st.lx == null ? st.x : st.lx);
      var ey = ev.type === "pointerup" ? ev.clientY : (st.ly == null ? st.y : st.ly);
      var dx = ex - st.x, dy = ey - st.y;
      if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
      this.nav(dx < 0 ? 1 : -1);
    },

    /* swipe navigation: neighbours wrap, and the direction of travel matches the finger */
    nav: function (dir) {
      var list = this.screens();
      if (list.length < 2) return;
      var cur = WP.panels.top();
      var idx = list.indexOf(cur);
      if (idx === -1) return;
      var next = list[(idx + dir + list.length) % list.length];
      WP.panels.swap(next, dir);
      this.showDots(list.indexOf(next), list.length);
      this.lastAdvance = Date.now();
      WP.armIdle();
    },

    /* ---------------- the playlist ---------------- */

    dwellMs: function () {
      var cfg = C.cycle || {};
      var s = parseInt(cfg.seconds, 10);
      if (isNaN(s)) s = 20;
      /* floor: a 3 s flip is unreadable; ceiling: past the idle unwind the two systems
         would fight over who owns the screen */
      return Math.min(60, Math.max(8, s)) * 1000;
    },

    ringing: function () {
      var t = WP.registry.timer;
      return !!(t && t.ringing);
    },

    tick: function () {
      if (!S.get("cycle") || document.hidden) return;
      var now = Date.now();
      if (now - this.lastTouch < TOUCH_HOLDOFF) return;   // someone is reading it
      if (this.ringing()) return;                          // never take over an alarm
      if (now - this.lastAdvance < this.dwellMs()) return;

      var list = this.playlist();
      if (!list.length) return;
      var top = WP.panels.top();

      if (top === null) {
        /* the dashboard is a screen too: after it, the first content screen */
        WP.panels.open(list[0]);
        this.showDots(0, this.screens().length);
      } else if (list.indexOf(top) !== -1) {
        var idx = list.indexOf(top);
        if (idx === list.length - 1) {
          WP.panels.closeAll();                            // full loop: back to the wall
        } else {
          WP.panels.swap(list[idx + 1], 1);
          this.showDots(this.screens().indexOf(list[idx + 1]), this.screens().length);
        }
      } else {
        return;      // a tool screen was opened by hand; the playlist waits its turn
      }
      this.lastAdvance = now;
      WP.armIdle();
    },

    /* ---------------- the dots ---------------- */

    showDots: function (idx, len) {
      var box = document.getElementById("dots");
      if (!box) return;
      var html = "";
      for (var i = 0; i < len; i++) {
        html += '<span class="dot' + (i === idx ? " on" : "") + '"></span>';
      }
      box.innerHTML = html;
      box.classList.add("show");
      clearTimeout(this.dotsTimer);
      this.dotsTimer = setTimeout(function () { box.classList.remove("show"); }, 1600);
    },

    onOpen: function () {}, onClose: function () {}
  };

  WP.carousel = carousel;
  WP.register(carousel);
})();
