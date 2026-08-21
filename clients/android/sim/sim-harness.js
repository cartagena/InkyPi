/* Simulator driver + whole-app sweep. Loaded last, so the app is fully booted.

   Everything here drives the app the way a finger does — real PointerEvents through the
   app's own delegation — because the interesting bugs live in the gesture layer, not in
   the functions a unit test can call directly. Click automation cannot drive this app at
   all: a wall panel runs 1-second tickers forever, so the page never reaches the idle
   state such tools wait for, and every automated click times out.

   SIM.sweep() walks every screen and every control and returns findings rather than
   pass/fail chatter: an empty findings array is the app behaving. */
(function () {
  "use strict";

  var SIM = window.SIM;
  var errors = [];
  var realErr = console.error, realWarn = console.warn;
  console.error = function () { errors.push("error: " + Array.prototype.join.call(arguments, " ")); realErr.apply(console, arguments); };
  console.warn = function () { errors.push("warn: " + Array.prototype.join.call(arguments, " ")); realWarn.apply(console, arguments); };
  window.addEventListener("error", function (e) { errors.push("uncaught: " + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    errors.push("unhandled rejection: " + ((e.reason && e.reason.message) || e.reason));
  });

  function el(sel, idx) {
    return typeof sel === "string" ? document.querySelectorAll(sel)[idx || 0] : sel;
  }
  function pointer(target, type, x, y) {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: "touch", clientX: x, clientY: y
    }));
  }

  /* a tap: down and up on the same spot, like a finger that did not travel */
  SIM.tap = function (sel, idx) {
    var e = el(sel, idx);
    if (!e) return "missing: " + sel;
    var r = e.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer(e, "pointerdown", x, y);
    pointer(e, "pointerup", x, y);
    return true;
  };

  /* a press-and-hold, which must still activate: people lean on wall panels */
  SIM.longPress = function (sel, idx, ms) {
    var e = el(sel, idx);
    if (!e) return Promise.resolve("missing: " + sel);
    var r = e.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer(e, "pointerdown", x, y);
    return new Promise(function (res) {
      setTimeout(function () { pointer(e, "pointerup", x, y); res(true); }, ms || 800);
    });
  };

  /* a swipe across whatever screen is open, with the intermediate moves a finger makes */
  SIM.swipe = function (dx, dy) {
    var e = document.querySelector(".panel.is-open [data-body]") || document.body;
    var r = e.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer(e, "pointerdown", x, y);
    for (var i = 1; i <= 4; i++) pointer(e, "pointermove", x + dx * i / 4, y + (dy || 0) * i / 4);
    pointer(e, "pointerup", x + dx, y + (dy || 0));
    return WP.panels.top();
  };

  SIM.errors = function () { return errors.slice(); };
  SIM.clearErrors = function () { errors.length = 0; };

  /* ---------------- invariants ----------------
     Checked after every step of the sweep. Each one is a property the panel must hold no
     matter what was just tapped. */
  function check(where) {
    var out = [];
    var home = document.getElementById("home");
    var openPanel = document.querySelector(".panel.is-open");

    if (!openPanel) {
      var ov = home.scrollHeight - home.clientHeight;
      if (ov > 0) out.push(where + ": home overflows by " + ov + "px — the bottom card is clipped");
      var ovx = home.scrollWidth - home.clientWidth;
      if (ovx > 0) out.push(where + ": home overflows sideways by " + ovx + "px");
    }
    if (WP.panels.stack.length > 2) {
      out.push(where + ": panel stack is " + WP.panels.stack.length + " deep — screens are stacking");
    }
    var stuck = document.querySelectorAll(".is-press");
    if (stuck.length) out.push(where + ": " + stuck.length + " control(s) left in the pressed state");
    if (WP.touching()) out.push(where + ": the app still thinks a finger is down");

    /* anything a finger can hit must say what it is */
    document.querySelectorAll(".tappable").forEach(function (n) {
      if (n.tagName === "BUTTON") return;
      var role = n.getAttribute("role");
      if (role !== "button" && role !== "switch") {
        out.push(where + ": ." + (n.getAttribute("class") || "").split(" ")[0] + " is tappable with no role");
      }
    });

    /* nothing on the wall should ever read as a raw JS value */
    var body = openPanel ? openPanel.querySelector("[data-body]") : home;
    if (body && /\b(undefined|NaN|\[object)\b/.test(body.textContent)) {
      out.push(where + ": a raw JavaScript value reached the screen");
    }
    return out;
  }
  SIM.check = check;

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------------- the sweep ----------------
     Opens every screen the way a person does (tapping its card), exercises every control
     inside it, swipes the carousel end to end, and returns everything that looked wrong. */
  SIM.sweep = function (opts) {
    opts = opts || {};
    var findings = [];
    var visited = [];
    SIM.clearErrors();

    function note(list) { list.forEach(function (f) { if (findings.indexOf(f) === -1) findings.push(f); }); }

    var widgets = WP.WIDGETS.slice();
    var chain = Promise.resolve();
    SIM.progress = "starting";

    /* 1. every card opens its own screen by tap */
    widgets.forEach(function (w) {
      chain = chain.then(function () {
        SIM.progress = "open: " + w;
        WP.panels.closeAll();
        return wait(30);
      }).then(function () {
        var card = document.querySelector('#home [data-widget="' + w + '"][data-open]')
                || document.querySelector('#home [data-widget="' + w + '"] [data-open]');
        if (!card) { findings.push(w + ": no way in from the dashboard"); return; }
        SIM.tap(card);
        return wait(60).then(function () {
          if (WP.panels.top() !== w) {
            findings.push(w + ': tapping its card opened "' + WP.panels.top() + '" instead');
            return;
          }
          visited.push(w);
          note(check(w));
          var panel = document.querySelector('[data-panel="' + w + '"]');
          var body = panel.querySelector("[data-body]");
          /* A screen whose content is a PHOTOGRAPH has no text, and the front page and
             the daily picture are exactly that: judging them by textContent reported the
             working ones as blank. Blank means neither words nor picture. */
          var pictured = body.querySelectorAll(".page-img, img, canvas, svg").length > 0;
          if (!(body.textContent || "").trim() && !pictured) {
            findings.push(w + ": the screen is blank");
          }
          /* dead-space and near-miss-scroll are text-layout judgements; a letterboxed
             picture is SUPPOSED to leave bars, so they do not apply to it */
          if (pictured) return;
          var deadTail = (function () {
            var kids = Array.prototype.filter.call(body.children, function (c) {
              return c.getBoundingClientRect().height > 0;
            });
            if (!kids.length) return 0;
            return Math.round(body.getBoundingClientRect().bottom
              - kids[kids.length - 1].getBoundingClientRect().bottom);
          })();
          if (deadTail > body.clientHeight * 0.25) {
            findings.push(w + ": " + deadTail + "px of dead space at the end ("
              + Math.round(deadTail / body.clientHeight * 100) + "% of the screen)");
          }
          var ov = body.scrollHeight - body.clientHeight;
          if (ov > 0 && ov < 60) {
            findings.push(w + ": scrolls by only " + ov + "px — reads as clipped, not scrollable");
          }
        });
      });
    });

    /* 2. every control inside every screen, tapped */
    if (opts.controls !== false) {
      widgets.forEach(function (w) {
        chain = chain.then(function () {
          WP.panels.closeAll();
          WP.panels.open(w);
          return wait(30);
        }).then(function () {
          SIM.progress = "controls: " + w;
          var panel = document.querySelector('[data-panel="' + w + '"]');
          var acts = Array.prototype.map.call(panel.querySelectorAll("[data-act]"), function (b) {
            return { act: b.getAttribute("data-act"), arg: b.getAttribute("data-arg") };
          });
          /* Repetitive lists (24 hourly rows, 7 day chips, 9 entity chips) are the same
             control repeated; three of each proves the wiring without spending a minute
             re-rendering the same panel. */
          var perAct = {};
          acts = acts.filter(function (a) {
            perAct[a.act] = (perAct[a.act] || 0) + 1;
            return perAct[a.act] <= 3;
          });
          var inner = Promise.resolve();
          acts.forEach(function (a) {
            inner = inner.then(function () {
              /* re-query: most panels rebuild themselves after every action */
              var sel = '[data-panel="' + w + '"] [data-act="' + a.act + '"]'
                + (a.arg != null ? '[data-arg="' + a.arg + '"]' : "");
              var node = document.querySelector(sel);
              if (!node) return;
              if (a.act === "reset") return;             // needs two taps; covered separately
              SIM.tap(node);
              return wait(25).then(function () {
                note(check(w + " [" + a.act + (a.arg != null ? "=" + a.arg : "") + "]"));
              });
            });
          });
          return inner;
        });
      });
    }

    /* 3. the carousel, end to end and back */
    chain = chain.then(function () {
      SIM.progress = "carousel";
      /* the control sweep may legitimately have switched widgets off; put the dashboard
         back the way it was found so the carousel walk means something */
      WP.WIDGETS.forEach(function (w) { WP.settings.setShow(w, true); });
      WP.panels.closeAll();
      WP.panels.open(WP.carousel.screens()[0]);
      return wait(30);
    }).then(function () {
      var seen = [], inner = Promise.resolve();
      var n = WP.carousel.screens().length + 2;          // past the end, to prove it wraps
      for (var i = 0; i < n; i++) {
        inner = inner.then(function () {
          SIM.swipe(-160);
          return wait(40).then(function () {
            seen.push(WP.panels.top());
            note(check("swipe"));
          });
        });
      }
      return inner.then(function () {
        var uniq = seen.filter(function (v, i2, a) { return a.indexOf(v) === i2; });
        if (uniq.length < WP.carousel.screens().length) {
          findings.push("swiping reached only " + uniq.length + " of "
            + WP.carousel.screens().length + " screens");
        }
        if (seen[seen.length - 1] === seen[seen.length - 2]) {
          findings.push("swiping stopped advancing at " + seen[seen.length - 1]);
        }
      });
    });

    /* 4. a vertical drag must scroll, never navigate */
    chain = chain.then(function () {
      var before = WP.panels.top();
      SIM.swipe(30, 260);
      return wait(40).then(function () {
        if (WP.panels.top() !== before) findings.push("a vertical drag changed screens");
      });
    });

    /* 5. back out to the dashboard and confirm it is whole */
    chain = chain.then(function () {
      WP.panels.closeAll();
      return wait(300);
    }).then(function () {
      SIM.progress = "done";
      note(check("dashboard"));
      var missing = WP.WIDGETS.filter(function (w) {
        return !document.querySelector('#home [data-widget="' + w + '"]');
      });
      if (missing.length) findings.push("no dashboard card for: " + missing.join(", "));
      var unvisited = WP.WIDGETS.filter(function (w) { return visited.indexOf(w) === -1; });
      if (unvisited.length) findings.push("never opened: " + unvisited.join(", "));
      SIM.errors().forEach(function (e) {
        if (e.indexOf("OVERFLOW") === -1) findings.push("console " + e);
      });
      return { scenario: JSON.parse(JSON.stringify(SIM.scenario)),
               viewport: window.innerWidth + "x" + window.innerHeight,
               screensVisited: visited.length, findings: findings };
    });

    return chain;
  };

  /* ?open=timer opens that screen a moment after boot. This exists so a screenshot can be
     taken of a PANEL and not just the dashboard: headless Chrome can only ask for a URL,
     and every panel in this app is opened by a tap. Anything a reviewer has to drive by
     hand is a screen that stops being looked at. */
  var want = /[?&]open=([a-z0-9]+)/.exec(window.location.search);
  if (want) {
    setTimeout(function () {
      try {
        WP.panels.closeAll();
        WP.panels.open(want[1]);
        /* and land it, rather than leaving it mid-fade: headless Chrome's virtual clock
           does not run CSS transitions, so every screenshot came out with the dashboard
           showing through the panel at about half opacity. */
        var el = document.querySelector(".panel.is-open");
        if (el) { el.style.transition = "none"; el.style.opacity = "1"; el.style.transform = "none"; }
      } catch (e) { /* not a screen */ }
    }, 250);
  }

  console.log("[sim] harness ready — SIM.sweep(), SIM.tap(), SIM.swipe(), SIM.set()");
})();
