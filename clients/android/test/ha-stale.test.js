/* Home Assistant freshness.

   The defect this file exists for: with a real HA configured, every poll that fails —
   an expired long-lived token 401ing, the box rebooting, the LAN moving — left the LAST
   GOOD numbers painted on the wall with nothing whatsoever to say they were old. An
   overnight token expiry therefore produced a dashboard full of plausible, wrong readings
   that was indistinguishable from a working one. Weather has badged exactly this since it
   was written ("stale"); these tests pin the same contract for HA.

   Three properties, and all three matter:
     1. the reading is KEPT. Blanking it destroys the last thing that was true, and a wall
        panel showing "--" is not more honest than one showing a marked stale value.
     2. the reading is MARKED — on the card badge, on the tile, and in words on the status
        line and the panel.
     3. recovery clears all of it, so the marker cannot become permanent furniture. */

"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var h = require("./lib/harness.js");

/* A controllable Home Assistant. `status` is what the next poll gets; flipping it is how a
   test expires a token. Weather is switched off in the config below so the only thing
   touching fetch() — and therefore the only thing writing the status line — is HA. */
function feed() {
  var f = { status: 200, temp: 68.4, on: true, urls: [], posts: [] };
  f.impl = function (url, init) {
    url = String(url);
    if (init && init.method === "POST") f.posts.push(url);
    else f.urls.push(url);
    if (f.status === 0) return Promise.reject(new Error("Failed to fetch"));
    if (f.status !== 200) {
      return Promise.resolve({
        ok: false, status: f.status,
        json: function () { return Promise.resolve({}); }
      });
    }
    var id = decodeURIComponent(url.split("/api/states/")[1] || "");
    var body = id.indexOf("switch.") === 0
      ? { entity_id: id, state: f.on ? "on" : "off", attributes: {} }
      : { entity_id: id, state: String(f.temp),
          attributes: { unit_of_measurement: "°F" } };
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(body); }
    });
  };
  return f;
}

function liveApp(f) {
  var cfg = h.defaultConfig();
  /* no location => the weather widget never fetches and never touches the status line */
  cfg.location = { name: "", latitude: null, longitude: null };
  cfg.homeAssistant = {
    enabled: true,
    baseUrl: "http://ha.test.invalid:8123",
    token: "t0ken",
    refreshSeconds: 30,
    entities: [
      { id: "sensor.kitchen_temperature", label: "Kitchen", unit: "°F" },
      { id: "switch.porch", label: "Porch" }
    ]
  };
  return h.createApp({ config: cfg, fetch: f.impl });
}

/* stepLive resolves on the host microtask queue, two thens deep behind a Promise.all. */
/* The live path is Promise.all over one fetch per entity, and each of those resolves
   through two `.then` hops before the widget repaints — so "settled" is several macrotask
   turns away, not one. Two flushes was enough on an idle machine and was observed failing
   once on a loaded one (`Not updating` had not yet replaced `Live` in the subtitle), which
   is a flaky test rather than a flaky app. Four turns costs microseconds and removes the
   race; it is still a bounded wait, not a sleep, so a genuinely stuck promise still fails
   the assertion rather than hanging the suite. */
function settle(app) {
  return app.flush()
    .then(function () { return app.flush(); })
    .then(function () { return app.flush(); })
    .then(function () { return app.flush(); });
}

function badge(app) { return app.$("ha-badge"); }
function tile(app, id) {
  return app.qsa("#sensors .sensor").filter(function (n) {
    return (n.getAttribute("data-arg") || "") === id;
  })[0];
}

test("a live feed fills the tiles and badges itself live", function () {
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    assert.equal(app.registry.sensors.mode, "live");
    assert.equal(badge(app).textContent, "live");
    assert.equal(badge(app).className, "badge badge-live");
    var t = tile(app, "sensor.kitchen_temperature");
    assert.ok(t, "no tile for the configured entity");
    assert.match(t.textContent, /68\.4/);
    assert.equal(t.className.indexOf("stale"), -1, "a fresh tile must not be marked stale");
    assert.ok(f.urls.some(function (u) { return u.indexOf("sensor.kitchen_temperature") !== -1; }),
      "the entity was never requested");
  });
});

test("a 401 keeps the last reading on the wall and marks it stale", function () {
  /* The whole point. Before this, the two assertions about the badge below were the ones
     nothing enforced: the tiles went on saying 68.4 under a live badge indefinitely. */
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    assert.equal(badge(app).textContent, "live");

    f.status = 401;                     // the token expired overnight
    app.advance(30000);
    return settle(app);
  }).then(function () {
    var t = tile(app, "sensor.kitchen_temperature");

    /* 1. the number is still there */
    assert.match(t.textContent, /68\.4/, "the last good reading was thrown away");

    /* 2. and nothing about it still claims to be current */
    assert.notEqual(badge(app).textContent, "live",
      "a 401 left the card badged live — this is the defect");
    assert.equal(badge(app).textContent, "stale");
    assert.equal(badge(app).className, "badge badge-stale");
    assert.notEqual(t.className.indexOf("stale"), -1, "the tile carries no stale marker");
    assert.equal(app.registry.sensors.stale, true);

    /* 3. and it says so in words, naming the cause a person can act on */
    assert.match(app.text("status"), /token/i,
      "a 401 is a rejected token and the status line should say so");
    assert.equal(app.$("status").className, "status warn");
  });
});

test("the stale tile is still readable — the value is dimmed, not emptied", function () {
  /* The marker is a class, so this is really a check that the class is on the tile rather
     than on the value being replaced by a placeholder. "--" would be a regression: it
     destroys the last thing that was true without making anything more honest. */
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    f.status = 401;
    app.advance(30000);
    return settle(app);
  }).then(function () {
    var v = tile(app, "sensor.kitchen_temperature").querySelector(".sensor-value");
    assert.match(v.textContent, /68\.4/);
    assert.equal(/--/.test(v.textContent), false, "the reading was blanked");
  });
});

test("an unreachable host is stale too, and does not blame the token", function () {
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    f.status = 0;                        // fetch rejects outright
    app.advance(30000);
    return settle(app);
  }).then(function () {
    assert.equal(badge(app).textContent, "stale");
    assert.match(app.text("status"), /not answering/i);
    assert.equal(/token/i.test(app.text("status")), false,
      "a network failure is not a rejected token");
  });
});

test("one entity failing marks that entity, not the whole house", function () {
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    /* fail only the switch */
    var base = f.impl;
    f.impl = function (url, init) {
      if (String(url).indexOf("switch.porch") !== -1) {
        return Promise.resolve({ ok: false, status: 500,
          json: function () { return Promise.resolve({}); } });
      }
      return base(url, init);
    };
    app.win.fetch = function (url, init) { return f.impl(url, init); };
    app.advance(30000);
    return settle(app);
  }).then(function () {
    assert.notEqual(tile(app, "switch.porch").className.indexOf("stale"), -1,
      "the failing entity is not marked");
    assert.equal(tile(app, "sensor.kitchen_temperature").className.indexOf("stale"), -1,
      "a healthy entity was marked stale because a sibling failed");
    assert.match(app.text("status"), /1 of 2/);
  });
});

test("recovery clears the badge, the tile and the status line", function () {
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    f.status = 401;
    app.advance(30000);
    return settle(app);
  }).then(function () {
    assert.equal(badge(app).textContent, "stale");
    f.status = 200;
    f.temp = 71.2;                       // the token was renewed and the room moved on
    app.advance(30000);
    return settle(app);
  }).then(function () {
    assert.equal(badge(app).textContent, "live");
    assert.equal(badge(app).className, "badge badge-live");
    var t = tile(app, "sensor.kitchen_temperature");
    assert.match(t.textContent, /71\.2/);
    assert.equal(t.className.indexOf("stale"), -1, "the stale marker became permanent");
    assert.equal(app.registry.sensors.stale, false);
    assert.equal(app.$("status").className, "status", "the warning outlived the fault");
    assert.match(app.text("status"), /answering again/i);
  });
});

test("the panel says how old the reading is instead of pretending it is live", function () {
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    app.WP.panels.open("sensors");
    assert.match(app.qs('[data-panel="sensors"] [data-sub]').textContent, /Live/);

    f.status = 401;
    app.advance(30000);
    return settle(app);
  }).then(function () {
    var sub = app.qs('[data-panel="sensors"] [data-sub]').textContent;
    assert.match(sub, /Not updating/i);
    assert.match(sub, /ago/, "the subtitle should date the last answer");
    assert.match(app.panelBody("sensors").textContent, /refused the token/i);
  });
});

test("a service call that fails marks the entity rather than leaving a wrong state", function () {
  /* The tile flips optimistically on tap. If the POST then fails the switch did not move,
     so the tile is showing something untrue — the same lie a stale poll tells. */
  var f = feed();
  var app = liveApp(f);
  return settle(app).then(function () {
    var before = app.registry.sensors.find("switch.porch").on;
    f.status = 401;
    app.registry.sensors.toggle("switch.porch");
    assert.equal(app.registry.sensors.find("switch.porch").on, !before,
      "the optimistic flip is deliberate and should still happen");
    return settle(app);
  }).then(function () {
    assert.equal(app.registry.sensors.stale, true);
    assert.equal(badge(app).textContent, "stale");
    assert.notEqual(tile(app, "switch.porch").className.indexOf("stale"), -1);
    assert.ok(f.posts.length, "no service call was issued at all");
  });
});

test("the demo simulator never goes stale — it cannot", function () {
  /* The badge has three states and only one of them may appear in demo mode; a simulator
     that badged itself stale would be nonsense, and a simulator that could badge itself
     live would be a lie. */
  var app = h.createApp({});
  assert.equal(app.registry.sensors.mode, "demo");
  assert.equal(badge(app).textContent, "demo");
  app.advance(10 * 60000);
  assert.equal(badge(app).textContent, "demo");
  assert.equal(app.registry.sensors.stale, false);
  assert.equal(app.qsa("#sensors .sensor.stale").length, 0);
});

test("every poll carries the bearer token, before and after a failure", function () {
  var f = feed();
  var app = liveApp(f);
  var seen = [];
  var wrapped = f.impl;
  f.impl = function (url, init) { seen.push(init); return wrapped(url, init); };
  app.win.fetch = function (url, init) { return f.impl(url, init); };
  app.advance(30000);
  return settle(app).then(function () {
    f.status = 401;
    app.advance(30000);
    return settle(app);
  }).then(function () {
    assert.ok(seen.length >= 4, "expected two polls of two entities, got " + seen.length);
    seen.forEach(function (init) {
      assert.equal((init.headers || {})["Authorization"], "Bearer t0ken");
    });
  });
});
