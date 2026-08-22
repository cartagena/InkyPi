/* Wall panel dashboard — INTERACTION LAYER (panels, gestures, idle, boot).

   Third of the three app files (see app.js). Owns the panel stack and its slide
   transitions, the tap/long-press/close-shadow gesture machinery, the idle unwind, and
   boot itself — boot lives here because it is the file everything else must precede.
*/

(function () {
  "use strict";

  var C = WP.C, $ = WP.$, qs = WP.qs, qsa = WP.qsa, esc = WP.esc;
  var settings = WP.settings, registry = WP.registry, bridge = WP.bridge;
  var bridgeFetch = WP.bridgeFetch, drift = WP.drift;
  var toast = WP.toast, setStatus = WP.status;

  /* ---------------- panel stack ----------------
     Panels are full-screen and pre-authored in index.html; opening one calls the owning
     plugin's onOpen(panel, arg) to fill its body. A stack (rather than a single "open"
     flag) means a panel can push another panel and still return to the right place.

     Idle unwind: see armIdle below — panels are one of the layers that register there. */
  var unmountTimers = {};

  var panels = {
    stack: [],

    el: function (name) { return qs('[data-panel="' + name + '"]'); },

    open: function (name, arg) {
      var el = panels.el(name);
      if (!el) return;
      if (panels.stack.indexOf(name) === -1) panels.stack.push(name);
      /* A close under 240ms ago left an unmount timer running for this same panel; letting
         it fire now would strip is-mounted — and with it visibility — off a panel we are in
         the middle of opening. */
      clearTimeout(unmountTimers[name]);

      /* Panels are pre-authored and reused, so the body still carries the scroll offset it
         had when it was last closed. Reopening Settings scrolled to MAINTENANCE put the
         WIDGETS rows exactly where the reader expected UNITS / CLOCK, and cost a mis-tap
         that silently hid a widget. Reset before onOpen, never after: hourly deliberately
         scrolls its own selected row into view from inside onOpen. */
      var body = qs("[data-body]", el);
      if (body) body.scrollTop = 0;

      var p = registry[name];
      if (p && p.onOpen) {
        try { p.onOpen(el, arg); } catch (e) { console.error(name + " onOpen: " + e.message); }
      }
      /* Force a reflow between "displayed" and "animated" so the 200ms fade/slide
         actually runs instead of being collapsed into the same frame. */
      el.classList.add("is-mounted");
      void el.offsetWidth;
      el.classList.add("is-open");
      document.body.classList.add("panel-open");
      WP._layout.reportPanel(name);
      armIdle();
    },

    close: function () {
      var name = panels.stack.pop();
      if (!name) return;
      var el = panels.el(name);
      if (el) {
        /* is-open carries pointer-events (see style.css), so touch is handed back to the
           dashboard on this line rather than 240ms later when the fade finishes. While it
           was tied to is-mounted, the invisible fading panel ate any tap inside that
           window — tap the close ✕ then immediately tap a card and nothing happened.
           The one thing that must *not* become live again is whatever was hiding under the
           close button itself; that is handled by the close shadow in runHit, not here. */
        el.classList.remove("is-open");
        unmountTimers[name] = setTimeout(function () {
          el.classList.remove("is-mounted");
        }, 240);
      }
      var p = registry[name];
      if (p && p.onClose) {
        try { p.onClose(el); } catch (e) { console.error(name + " onClose: " + e.message); }
      }
      /* Anything still on the stack becomes the visible panel again. */
      if (!panels.stack.length) document.body.classList.remove("panel-open");
      armIdle();
    },

    /* Screen-to-screen slide (the carousel): the outgoing panel exits sideways while
       the incoming one enters from the opposite edge. Unlike open(), this REPLACES the
       top of the stack — screens are siblings, so Android back from any screen goes to
       the dashboard, never through every screen visited. */
    swap: function (name, dir, arg) {
      if (!panels.stack.length || panels.top() === name) return panels.open(name, arg);
      var cur = panels.stack.pop();
      var curEl = panels.el(cur);
      if (curEl) {
        curEl.classList.add(dir > 0 ? "slide-exit-l" : "slide-exit-r");
        clearTimeout(unmountTimers[cur]);
        unmountTimers[cur] = setTimeout(function () {
          curEl.classList.remove("is-open", "is-mounted", "slide-exit-l", "slide-exit-r");
        }, 240);
        var p = registry[cur];
        if (p && p.onClose) {
          try { p.onClose(curEl); } catch (e) { console.error(cur + " onClose: " + e.message); }
        }
      }
      var el = panels.el(name);
      if (el) {
        el.classList.remove("slide-exit-l", "slide-exit-r");
        el.classList.add(dir > 0 ? "slide-from-r" : "slide-from-l");
      }
      panels.open(name, arg);
      if (el) {
        setTimeout(function () { el.classList.remove("slide-from-r", "slide-from-l"); }, 300);
      }
    },

    /* Close ONE named panel wherever it sits in the stack, rather than the top one.
       applyVisibility() needs this: switching a widget off has to take its screen with
       it even if something else was opened on top of it since. */
    closePanel: function (name) {
      var i = panels.stack.indexOf(name);
      if (i === -1) return;
      if (i === panels.stack.length - 1) return panels.close();
      panels.stack.splice(i, 1);
      var el = panels.el(name);
      if (el) {
        el.classList.remove("is-open");
        clearTimeout(unmountTimers[name]);
        unmountTimers[name] = setTimeout(function () { el.classList.remove("is-mounted"); }, 240);
      }
      var p = registry[name];
      if (p && p.onClose) {
        try { p.onClose(el); } catch (e) { console.error(name + " onClose: " + e.message); }
      }
    },

    closeAll: function () { while (panels.stack.length) panels.close(); },

    isOpen: function (name) { return panels.stack.indexOf(name) !== -1; },
    top: function () { return panels.stack[panels.stack.length - 1] || null; }
  };

  /* ---------------- idle unwind ----------------
     A wall panel is walked away from, not closed. Anything parked on top of the dashboard
     therefore has to take itself back down, or the panel stops being a dashboard — that is
     what the 90s panel timeout was added for. A finished countdown then proved the point
     from the other side: the full-screen alarm overlay lived *outside* the panel stack, so
     nothing unwound it. One laundry timer and the wall showed a pulsing red "Timer
     finished" indefinitely, swallowing every tap aimed at the tiles underneath.

     So the timeout is no longer a panel feature. Every layer that can cover the dashboard
     registers here with its own patience, and one timer takes down whatever has sat there
     too long. Any pointerdown restarts every open layer's countdown, so a panel being read
     is never yanked away, and a layer that is genuinely unattended always goes. */
  var PANEL_IDLE_MS = 90000;
  var idleTimer = null;
  var idleLayers = [];

  function registerIdleLayer(layer) {
    layer.since = Date.now();
    idleLayers.push(layer);
    return layer;
  }

  function openIdleLayers() {
    return idleLayers.filter(function (l) {
      try { return !!l.isOpen(); } catch (e) { return false; }
    });
  }

  /* Somebody is here: every open layer's patience starts over. */
  function armIdle() {
    var now = Date.now();
    openIdleLayers().forEach(function (l) { l.since = now; });
    scheduleIdle();
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    var open = openIdleLayers();
    if (!open.length) return;
    var wait = Math.min.apply(null, open.map(function (l) {
      return l.since + l.ms - Date.now();
    }));
    idleTimer = setTimeout(runIdle, Math.max(200, wait));
  }

  function runIdle() {
    if (touching) { armIdle(); return; }        // a finger is down: not idle
    var now = Date.now();
    var due = openIdleLayers().filter(function (l) { return now - l.since >= l.ms - 100; });
    var msg = null;
    due.forEach(function (l) {
      try { l.close(); } catch (e) { console.error("idle close " + l.name + ": " + e.message); }
      if (l.toast && !msg) msg = l.toast;
    });
    if (msg) toast(msg);
    scheduleIdle();
  }

  registerIdleLayer({
    name: "panels",
    ms: PANEL_IDLE_MS,
    isOpen: function () { return panels.stack.length > 0; },
    close: function () { panels.closeAll(); },
    toast: "Idle — back to dashboard"
  });

  /* MainActivity's onBackPressed calls this instead of leaving the app: back closes the
     top panel and nothing else. Returns true if it consumed the press. */
  function onAndroidBack() {
    if (panels.stack.length) { panels.close(); return true; }
    return false;
  }

  /* ---------------- touch wiring ----------------
     One delegated listener for the whole app. `data-open` opens a panel (optionally with
     `data-arg`), `data-close` pops one, `data-act` is handed to the plugin that owns the
     panel it was tapped inside. */
  var actionHandlers = {};
  function onAction(ns, fn) { actionHandlers[ns] = fn; }

  /* True between pointerdown and pointerup. Widgets that repaint on a timer check it and
     skip that frame: replacing a button's DOM node between press and release makes the
     browser dispatch the click on the surviving ancestor instead, silently eating the tap. */
  var touching = false;
  function isTouching() { return touching; }

  /* innerHTML swap that keeps the container's scroll position — a detail panel that
     refreshes every few seconds must not yank the user back to the top mid-read. */
  function repaint(el, html) {
    if (!el) return;
    var top = el.scrollTop;
    el.innerHTML = html;
    if (top) el.scrollTop = top;
  }

  /* The element a tap on `node` would act on, and what that action is. Order matters and
     matches the historical click handler: close beats act beats open. */
  function hit(node) {
    if (!node || !node.closest) return null;
    var el = node.closest("[data-close]");
    if (el) return { el: el, kind: "close" };
    el = node.closest("[data-act]");
    if (el) return { el: el, kind: "act" };
    el = node.closest("[data-open]");
    if (el) return { el: el, kind: "open" };
    return null;
  }

  /* ---- close shadow ----
     Both close affordances sit directly on top of something tappable: the full-width footer
     bar covers the DEVICE / TIMER / SETTINGS tile row, and the header ✕ covers the topbar
     gear. Since pointer-events is released the instant a panel closes (so a tap ~80ms later
     still reaches a card — see panels.close), the *second* tap of a human double-tap on
     either affordance landed on whatever was underneath and re-opened a panel. The ✕ variant
     silently opened Settings, which is where widgets can be hidden.

     A post-close cooldown is the wrong instrument: it would put back exactly the dead window
     that releasing pointer-events removed. What is actually wrong is narrower — one specific
     rectangle became live under the finger without the finger moving — so the suppression is
     that narrow too. A close tap leaves a short-lived "shadow" at the point it landed, and
     only a data-open element whose *current* rect still contains that point is refused.
     Anything else — a different tile, a different card, the same tile after the window —
     opens normally, so close-then-tap-elsewhere keeps working at any gap.

     Reading the live rect (rather than comparing raw tap coordinates) is deliberate: burn-in
     drift can have moved the layer by up to 12 CSS px between the two taps, and the question
     being asked is "is this the thing that was hiding under the close button", which is a
     question about where that element is now. */
  var CLOSE_SHADOW_MS = 600;          // covers the human double-tap range with margin
  var closeShadow = null;

  function shadowed(el) {
    if (!closeShadow || Date.now() > closeShadow.until) { closeShadow = null; return false; }
    var r = el.getBoundingClientRect();
    return closeShadow.x >= r.left && closeShadow.x <= r.right
        && closeShadow.y >= r.top  && closeShadow.y <= r.bottom;
  }

  function runHit(h, pt) {
    if (!h) return false;
    if (h.kind === "close") {
      closeShadow = pt ? { x: pt.x, y: pt.y, until: Date.now() + CLOSE_SHADOW_MS } : null;
      panels.close();
      return true;
    }
    if (h.kind === "act") {
      var ns = h.el.getAttribute("data-ns") || panels.top();
      var fn = actionHandlers[ns];
      if (fn) {
        try { fn(h.el.getAttribute("data-act"), h.el.getAttribute("data-arg"), h.el); }
        catch (e) { console.error("action " + ns + ": " + e.message); }
      }
      return true;
    }
    /* Still "true": the gesture was consumed, so the click Chrome sends afterwards is eaten
       rather than re-running the same suppressed open a frame later. */
    if (shadowed(h.el)) return true;
    panels.open(h.el.getAttribute("data-open"), h.el.getAttribute("data-arg"));
    return true;
  }

  /* ---- press bookkeeping ----
     Activation is driven off the *pointer*, not off `click`. A deliberate 600 ms press —
     which is how people use a panel on a wall — makes Chrome treat the gesture as a
     long-press and swallow the click entirely, so the card lit up under the finger and
     then did nothing on release. Pointer events still arrive in that case (as pointerup,
     or as pointercancel once the gesture is claimed), so both are honoured.

     Two different slops, because the two endings mean different things:
       pointerup   — the gesture was never claimed by a scroller, so a generous 14 CSS px
                     just tolerates finger wobble on release.
       pointercancel — either a long-press gesture (no movement) or a scroll taking over
                     (movement past Chrome's own ~8 px touch slop). A tight 6 px keeps
                     scrolling the hourly strip or a panel body from firing a tap. */
  var UP_SLOP = 14, CANCEL_SLOP = 6;
  var press = null;
  var eatClickUntil = 0;

  function endPress(ev, slop) {
    touching = false;
    qsa(".is-press").forEach(function (n) { n.classList.remove("is-press"); });
    var p = press;
    press = null;
    if (!p || (ev.pointerId != null && ev.pointerId !== p.id)) return;
    if (p.moved > slop || !p.hit) return;
    /* Release must still be over the element the press started on. */
    var over = hit(ev.target);
    if (ev.type === "pointerup" && (!over || over.el !== p.hit.el)) return;
    /* The press-start point, not the release point: it is where the finger actually landed,
       and it cannot have drifted by up to UP_SLOP the way clientX/Y on release can. */
    if (runHit(p.hit, { x: p.x, y: p.y })) {
      /* Chrome will still deliver its own click for a normal short tap; ignore it so the
         action does not run twice. Long-presses never get here. */
      eatClickUntil = Date.now() + 700;
    }
  }

  function bindTouch() {
    document.addEventListener("click", function (ev) {
      /* Fallback path only: mouse, hardware keyboard, or any environment without pointer
         events. A click that follows an activation we already performed is dropped. */
      if (Date.now() < eatClickUntil) { eatClickUntil = 0; return; }
      runHit(hit(ev.target), { x: ev.clientX, y: ev.clientY });
    }, false);

    /* CSS :active is unreliable inside a scroll container in WebView, so press feedback
       is driven explicitly. Every tappable element gets it, including ones built later. */
    document.addEventListener("pointerdown", function (ev) {
      touching = true;
      armIdle();                                   // reading a panel keeps it open
      press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: 0, hit: hit(ev.target) };
      var t = ev.target.closest ? ev.target.closest(".tappable") : null;
      if (t) t.classList.add("is-press");
    }, true);

    document.addEventListener("pointermove", function (ev) {
      if (!press || ev.pointerId !== press.id) return;
      var d = Math.max(Math.abs(ev.clientX - press.x), Math.abs(ev.clientY - press.y));
      if (d > press.moved) press.moved = d;
    }, true);

    /* Chrome can claim a scroll gesture without ever delivering a pointermove, which would
       leave `moved` at 0 and make the pointercancel look like a long-press. touchmove is
       still delivered to passive listeners while scrolling, and a scroll event is proof on
       its own, so both feed the same counter. */
    document.addEventListener("touchmove", function (ev) {
      if (!press || !ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      var d = Math.max(Math.abs(t.clientX - press.x), Math.abs(t.clientY - press.y));
      if (d > press.moved) press.moved = d;
    }, { passive: true, capture: true });
    document.addEventListener("scroll", function () {
      if (press) press.moved = 9999;
    }, true);

    document.addEventListener("pointerup", function (ev) { endPress(ev, UP_SLOP); }, true);
    document.addEventListener("pointercancel", function (ev) { endPress(ev, CANCEL_SLOP); }, true);
    /* pointerleave carries no gesture meaning here — just make sure nothing stays lit. */
    document.addEventListener("pointerleave", function () {
      touching = false;
      qsa(".is-press").forEach(function (n) { n.classList.remove("is-press"); });
    }, true);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    settings.load();
    bridgeFetch.lockOrigins();
    WP.applyVisibility();
    bindTouch();

    Object.keys(registry).forEach(function (name) {
      var p = registry[name];
      if (!p.init) return;
      try { p.init(); }
      catch (e) { console.error("plugin " + name + " init failed: " + e.message); }
    });

    drift.start();
    settings.onChange(function (k) { if (k === "burnIn" || k === "*") drift.start(); });

    console.log("[inky] booted; bridge=" + bridge.present()
      + " viewport=" + window.innerWidth + "x" + window.innerHeight
      + " dpr=" + window.devicePixelRatio);

    /* Regression guard for a whole class of bug rather than for one control. The alarm's
       Dismiss button stayed on a hand-rolled click listener while everything else moved to
       pointerup delegation, so it was the one control in the app that ignored a deliberate
       press-and-hold — exactly the gesture people use on a wall panel. Anything tappable
       that hit() cannot resolve is named here at boot; the expected count is 0. */
    var orphans = qsa("button, .tappable").filter(function (n) {
      return !n.closest("[data-open],[data-act],[data-close]");
    });
    if (orphans.length) {
      console.warn("[inky] " + orphans.length + " tappable(s) are not on the pointer "
        + "delegation and will ignore a long press: "
        + orphans.map(function (n) {
            return (n.id || n.className || n.tagName).toString().split(" ")[0];
          }).join(", "));
    }

    /* The home column is a fixed height budget and the only honest way to know it still
       fits is to measure it on the device, so one line of the log carries the numbers:
       overflow must stay 0 (anything else means a card grew and the bottom tile row is
       being clipped) and slack is the headroom a downward burn-in nudge eats into.
       Deferred until the weather payload has landed and the cards are at full size —
       measured at boot the cards are still empty and the number is meaningless.
       On device with all eight widgets on: overflow=0 slack=34, identical across all four
       12h/24h x seconds combinations. */
    setTimeout(function () {
      var m = WP._layout.metrics();
      if (!m) return;
      console.log("[inky] layout: home overflow=" + m.overflow
        + " overflowX=" + m.overflowX
        + " slack=" + m.slack + "px cards=" + m.kids.length);
      WP.relayoutHome();
    }, 12000);

    /* Every settings change can move the height budget — seconds on, a widget hidden — so
       the column is re-measured afterwards and the numbers go to logcat. The delay is for
       the 1 Hz clock tick and the card repaints to land first; measured immediately, the
       seconds field is still empty and the number is a lie. This is how "overflow=0 in all
       four 12h/24h x seconds combinations" gets checked without eyeballing a screenshot. */
    settings.onChange(function () {
      setTimeout(function () {
        var m = WP._layout.metrics();
        if (!m) return;
        var line = "[inky] layout: home overflow=" + m.overflow
          + " overflowX=" + m.overflowX + " slack=" + m.slack
          + "px cards=" + m.kids.length;
        if (m.overflow > 0) console.warn(line + " — OVERFLOW, bottom row is clipped");
        else if (m.overflowX > 0) console.warn(line + " — OVERFLOW, content runs off the right");
        else console.log(line);
        WP._layout.relayout();
      }, 1500);
    });

    /* Growth caps are measured off the current content, so they have to be re-measured
       when the content changes size. Visibility changes and the weather payload both call
       relayoutHome() directly; this heartbeat is the backstop for everything else (and for
       a cap that was measured while a card was still empty). Two forced layouts a minute
       against a panel that repaints its sensors every five seconds. */
    setInterval(WP._layout.relayout, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    /* widgets.js registers during parse, so a late boot still sees every plugin. */
    setTimeout(boot, 0);
  }

  WP.panels = panels;
  WP.onAction = onAction;
  WP.onAndroidBack = onAndroidBack;
  WP.registerIdleLayer = registerIdleLayer;
  WP.armIdle = armIdle;
  WP.touching = isTouching;
  WP.repaint = repaint;
})();
