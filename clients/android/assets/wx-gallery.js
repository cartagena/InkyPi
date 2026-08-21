/* Wall panel dashboard — DAILY PICTURE.

   The picture half of InkyPi's catalogue, folded into one widget: XKCD's comic, the
   Wikimedia Commons picture of the day, NASA's astronomy picture of the day, and — when
   config carries an OpenAI key — a generated image. One tile, one screen, one picture at
   a time; the sources are chips inside the panel, and the tile rotates to a different
   source each day so the wall does not show the same kind of thing every morning.

   Keys: xkcd and Wikimedia need none; APOD ships against NASA's public DEMO_KEY (fine at
   one request a day; `apod: { apiKey } ` upgrades it); AI needs `openai: { apiKey }` in
   config and shows an honest explanation without one — never an error, absence of a key
   is a configuration, not a failure.

   Images ride the bridge fetch and land as data: URIs; the CSP admits no remote image,
   so the shell's origin allowlist is the one authority on where pictures come from.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows
   writes the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc;

  /* the day picks the tile's source, so a Tuesday is not forever comics */
  var ORDER = ["wpotd", "apod", "xkcd", "ai"];

  function dayIndex() {
    return Math.floor(Date.now() / 86400000);
  }
  function aiEnabled() {
    return !!(C.openai && C.openai.apiKey);
  }
  function sources() {
    return ORDER.filter(function (s) { return s !== "ai" || aiEnabled(); });
  }
  function todaysSource() {
    var list = sources();
    return list[dayIndex() % list.length];
  }
  function isoToday() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
      + "-" + String(d.getDate()).padStart(2, "0");
  }

  var NAMES = { xkcd: "XKCD", wpotd: "Wikimedia", apod: "NASA", ai: "Generated" };

  /* A transport failure is not a sentence. The panel printed whatever the shell threw —
     "Error: sim offline" in the simulator, "connect timed out" or "origin not allowed"
     on the tablet — which is the machine's vocabulary on a wall in somebody's kitchen,
     and exactly what the copy sweep exists to keep off the screen. Every failure becomes
     one of four things a person can act on. */
  function humanError(err, name) {
    var e = String(err || "").toLowerCase();
    if (/offline|failed to fetch|timed out|timeout|unreachable|refused|network/.test(e)) {
      return "No connection to " + name + " right now.";
    }
    if (/\b401\b|\b403\b|unauthor|forbidden|api key|invalid/.test(e)) {
      return name + " refused the request — check the key in config.js.";
    }
    if (/\b404\b|no picture|no comic|no image/.test(e)) {
      return name + " has not published one today.";
    }
    return name + " is not answering right now.";
  }

  var gallery = {
    name: "gallery",
    cur: null,                       // which source the panel is showing
    slots: {},                       // source -> {uri, title, note, at} | {err}
    busy: {},
    panel: null,

    init: function () {
      this.cur = todaysSource();
      this.renderCard();
      this.load(this.cur);
      var self = this;
      /* a new day brings a new picture and possibly a new source */
      setInterval(function () {
        var want = todaysSource();
        if (want !== self.cur || !self.slots[want] || (Date.now() - (self.slots[want].at || 0)) > 86400000) {
          self.cur = want;
          self.load(want);
        }
      }, 30 * 60 * 1000);

      WP.onAction("gallery", function (act, arg) {
        if (act === "pick") {
          self.cur = arg;
          if (!self.slots[arg] || self.slots[arg].err) self.load(arg);
          self.paintPanel();
          self.renderCard();
        } else if (act === "regen" && aiEnabled()) {
          delete self.slots.ai;
          self.load("ai");
          self.paintPanel();
        }
      });
    },

    /* ---------------- the sources ---------------- */

    load: function (src) {
      if (!WP.bridgeFetch.available() || this.busy[src]) { this.renderCard(); return; }
      var self = this;
      this.busy[src] = true;
      var done = function (slot) {
        self.busy[src] = false;
        slot.at = Date.now();
        self.slots[src] = slot;
        self.renderCard();
        if (self.panel) self.paintPanel();
      };
      var fail = function (why) { done({ err: String(why || "failed") }); };

      if (src === "xkcd") {
        WP.bridgeFetch.get("https://xkcd.com/info.0.json")
          .then(function (r) {
            var j = r.json();
            if (!j || !j.img) throw new Error("no comic");
            return WP.bridgeFetch.get(j.img).then(function (img) {
              if (!img.ok) throw new Error("HTTP " + img.status);
              done({ uri: img.dataUri("image/png"), title: j.safe_title || j.title,
                     note: j.alt || "" });
            });
          })
          .catch(fail);
      } else if (src === "wpotd") {
        var url = "https://commons.wikimedia.org/w/api.php?action=query"
          + "&generator=images&titles=" + encodeURIComponent("Template:Potd/" + isoToday())
          + "&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200&format=json";
        WP.bridgeFetch.get(url)
          .then(function (r) {
            /* a transport failure must not masquerade as "no picture today" — the sim's
               proxy surfaced one as a 502 body and the widget blamed the calendar */
            if (!r.ok) throw new Error("HTTP " + r.status);
            var info = gallery.wpotdParse(r.json());
            if (!info) throw new Error("no picture today");
            return WP.bridgeFetch.get(info.thumb).then(function (img) {
              if (!img.ok) throw new Error("HTTP " + img.status);
              done({ uri: img.dataUri("image/jpeg"), title: info.title, note: "" });
            });
          })
          .catch(fail);
      } else if (src === "apod") {
        var key = (C.apod && C.apod.apiKey) || "DEMO_KEY";
        WP.bridgeFetch.get("https://api.nasa.gov/planetary/apod?thumbs=true&api_key=" + key)
          .then(function (r) {
            var j = r.json();
            var img = j && (j.media_type === "image" ? j.url : j.thumbnail_url);
            if (!img) throw new Error("no image today");
            return WP.bridgeFetch.get(img).then(function (pic) {
              if (!pic.ok) throw new Error("HTTP " + pic.status);
              done({ uri: pic.dataUri("image/jpeg"), title: j.title || "Astronomy picture",
                     note: (j.copyright ? "© " + j.copyright.trim() : "NASA") });
            });
          })
          .catch(fail);
      } else if (src === "ai") {
        if (!aiEnabled()) { this.busy[src] = false; return; }
        var prompt = (C.openai && C.openai.prompt)
          || "A serene natural landscape, soft dawn light, painterly, muted colours, calm";
        WP.bridgeFetch.post("https://api.openai.com/v1/images/generations",
          { Authorization: "Bearer " + C.openai.apiKey, "Content-Type": "application/json" },
          JSON.stringify({ model: (C.openai.model || "gpt-image-1"), prompt: prompt,
                           size: "1024x1024", quality: (C.openai.quality || "low") }))
          .then(function (r) {
            var j = r.json();
            var b64 = j && j.data && j.data[0] && j.data[0].b64_json;
            if (!b64) throw new Error((j && j.error && j.error.message) || "no image");
            done({ uri: "data:image/png;base64," + b64, title: "Generated this morning",
                   note: prompt });
          })
          .catch(fail);
      }
    },

    /* Commons answers a nest keyed by page id; pure and exported for the tests. */
    wpotdParse: function (j) {
      var pages = j && j.query && j.query.pages;
      if (!pages) return null;
      var best = null;
      Object.keys(pages).forEach(function (k) {
        var ii = pages[k].imageinfo && pages[k].imageinfo[0];
        if (!ii || !ii.thumburl) return;
        if (!best) {
          var meta = ii.extmetadata || {};
          var t = (meta.ObjectName && meta.ObjectName.value) || pages[k].title || "";
          best = { thumb: ii.thumburl,
                   title: String(t).replace(/<[^>]*>/g, "").replace(/^File:/, "")
                     .replace(/\.[a-z]+$/i, "") };
        }
      });
      return best;
    },

    /* ---------------- rendering ---------------- */

    renderCard: function () {
      var big = $("gallery-big"), sub = $("gallery-sub");
      if (!big) return;
      var slot = this.slots[this.cur];
      big.textContent = NAMES[this.cur] || "—";
      sub.textContent = !WP.bridgeFetch.available() ? "needs the tablet"
        : !slot ? "fetching…"
        /* the tile says WHICH kind of failure, in two words, so a glance from across the
           room distinguishes "the wifi is out" from "they have not posted today" */
        : slot.err ? (/offline|failed to fetch|timed out|network|refused/i.test(slot.err)
            ? "no connection" : "nothing today")
        : "tap to view";
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("gallery");
      if (!panel) return;
      var slot = this.slots[this.cur];
      WP.qs("[data-sub]", panel).textContent =
        slot && slot.title ? slot.title : "One picture a day";

      var chips = '<div class="chip-row" role="radiogroup" aria-label="Source">'
        + ORDER.map(function (s) {
          if (s === "ai" && !aiEnabled()) return "";
          var on = s === gallery.cur;
          return '<button class="chip tappable' + (on ? " on" : "") + '" role="radio"'
            + ' aria-checked="' + (on ? "true" : "false") + '"'
            + ' data-ns="gallery" data-act="pick" data-arg="' + s + '">'
            + esc(NAMES[s]) + "</button>";
        }).join("") + "</div>";

      var main;
      /* a picture in hand beats every excuse: the fallbacks only speak when there is
         nothing to show */
      if (slot && slot.uri) {
        main = '<div class="page-wrap">'
          + '<img class="page-img" src="' + slot.uri + '" alt="' + esc(slot.title || "") + '">'
          + "</div>"
          + (slot.note ? '<div class="pic-note">' + esc(slot.note) + "</div>" : "");
      } else if (!WP.bridgeFetch.available()) {
        main = '<div class="muted">Pictures arrive through the app shell, which a browser '
          + "tab does not have.</div>";
      } else if (this.cur === "ai" && !aiEnabled() && !slot) {
        main = '<div class="muted">Generated pictures need an OpenAI key: add '
          + "<b>openai: { apiKey: … }</b> to config.js and rebuild. Nothing else on this "
          + "screen needs one.</div>";
      } else if (!slot) {
        main = '<div class="muted">Fetching…</div>';
      } else {
        /* Composed, not a line stranded at the top of a black screen: the reason, then
           what happens next, then the way out — the other sources are one tap away and
           the chips are right above this. */
        main = '<div class="pic-empty">'
          + '<div class="pic-empty-t">' + esc(humanError(slot.err, NAMES[this.cur])) + "</div>"
          + '<div class="pic-empty-s">It tries again on its own. '
          + (sources().length > 1 ? "The other sources are above." : "") + "</div>"
          + "</div>";
      }

      var regen = (this.cur === "ai" && aiEnabled())
        ? '<div class="btn-row"><button class="btn tappable" data-ns="gallery" data-act="regen">'
          + "New picture</button></div>"
        : "";

      WP.repaint(WP.qs("[data-body]", panel), chips + main + regen);
    }
  };

  /* every source's origin joins the allowlist at parse; boot() locks the list */
  ["https://xkcd.com", "https://imgs.xkcd.com",
   "https://commons.wikimedia.org", "https://upload.wikimedia.org",
   "https://api.nasa.gov", "https://apod.nasa.gov"]
    .concat(aiEnabled() ? ["https://api.openai.com"] : [])
    .forEach(function (o) {
      if (WP.fetchOrigins.indexOf(o) === -1) WP.fetchOrigins.push(o);
    });

  gallery.humanError = humanError;
  gallery.sources = sources;
  gallery.todaysSource = todaysSource;
  WP.register(gallery);
})();
