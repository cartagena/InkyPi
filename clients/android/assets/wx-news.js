/* Wall panel dashboard — NEWS.

   Headlines from ordinary RSS/Atom feeds, fetched through the Java shell's bridge fetch
   (feeds almost never send CORS headers, so the page could not read them directly). No
   API key, no account: the defaults are two public broadcaster feeds, and config.js can
   replace them with `news: { feeds: ["https://…"], rotateSeconds: 12 }`.

   The card is a one-line ticker that rotates through the freshest headlines — text that
   changes every few seconds is also exactly what an AMOLED wants. The panel lists the
   merged, newest-first headlines with their source and age.

   parseFeed() is a small pure string parser rather than DOMParser, for one reason the
   rest of this file inherits from the test suite: everything here runs unmodified in
   node:vm, where DOMParser does not exist. It handles the three shapes real feeds use
   (RSS 2.0 <item>, Atom <entry>, CDATA-wrapped titles) and nothing more exotic.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows
   writes the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc;
  var section = WP.ui.section;

  var CACHE = "inky.news.v1";
  var DEFAULT_FEEDS = [
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://feeds.npr.org/1001/rss.xml"
  ];

  function feedList() {
    var cfg = C.news || {};
    var feeds = (cfg.feeds && cfg.feeds.length) ? cfg.feeds : DEFAULT_FEEDS;
    return feeds.slice(0, 6);          // a wall panel does not need a feed reader's inbox
  }

  /* ---------------- parsing ---------------- */

  function decodeEntities(t) {
    return String(t || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/<[^>]*>/g, "")         // any markup left inside a title is decoration
      .replace(/\s+/g, " ").trim();
  }

  function firstTag(block, names) {
    for (var i = 0; i < names.length; i++) {
      var m = new RegExp("<" + names[i] + "[^>]*>([\\s\\S]*?)</" + names[i] + ">", "i")
        .exec(block);
      if (m) return m[1];
    }
    return "";
  }

  /* A feed's <title> is written for a feed reader's sidebar, not for a wall: NPR's world
     feed calls itself "NPR Topics: News" and printed exactly that beside every headline.
     What belongs there is who said it, so everything after the first separator goes — that
     is the section, and the section is not news to anyone — and so does a trailing
     "Topics", which is a word about the feed rather than a word in the publisher's name.

     Deliberately NOT stripped: a trailing "News". "BBC News" is the name of the
     organisation, and a feed called "Example World News" is not the "Example World"
     anything. Cutting there was a rule that fixed one feed and renamed others.
     Anything that reduces to nothing keeps what it started with. */
  function sourceName(raw) {
    var s = String(raw || "").split(/\s+[-–—|]\s+|:\s+/)[0].trim();
    s = s.replace(/\s+topics$/i, "").trim();
    return s || String(raw || "").trim();
  }

  /* xml -> { source, items: [{title, at}] }, newest first. Bad input -> empty items. */
  function parseFeed(xml) {
    xml = String(xml || "");
    var isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
    var head = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i)[0];
    var source = sourceName(decodeEntities(firstTag(head, ["title"])));

    var blocks = xml.match(isAtom
      ? /<entry[\s>][\s\S]*?<\/entry>/gi
      : /<item[\s>][\s\S]*?<\/item>/gi) || [];

    var items = [];
    blocks.forEach(function (b) {
      var title = decodeEntities(firstTag(b, ["title"]));
      if (!title) return;
      var when = firstTag(b, ["pubDate", "published", "updated", "dc:date"]);
      var at = Date.parse(decodeEntities(when));
      items.push({ title: title, at: isNaN(at) ? 0 : at });
    });
    items.sort(function (a, b) { return b.at - a.at; });
    return { source: source, items: items };
  }

  /* newest-first merge across feeds, deduped by title, capped for the panel */
  function merge(feeds) {
    var seen = {}, out = [];
    var all = [];
    feeds.forEach(function (f) {
      f.items.forEach(function (it) {
        all.push({ title: it.title, at: it.at, source: f.source });
      });
    });
    all.sort(function (a, b) { return b.at - a.at; });
    all.forEach(function (it) {
      var k = it.title.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(it);
    });
    return out.slice(0, 24);
  }

  function ago(at) {
    if (!at) return "";
    var m = Math.floor((Date.now() - at) / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }

  var news = {
    name: "news",
    items: [],
    fetchedAt: 0,
    stale: false,
    idx: 0,
    panel: null,

    init: function () {
      var cached = WP.store.readJSON(CACHE, null);
      if (cached && cached.items) {
        this.items = cached.items;
        this.fetchedAt = cached.t || 0;
        this.stale = true;
      }
      this.renderCard();
      this.fetch();
      setInterval(this.fetch.bind(this), 20 * 60 * 1000);

      var rotate = Math.max(6, (C.news && C.news.rotateSeconds) || 12) * 1000;
      var self = this;
      setInterval(function () { self.advance(); }, rotate);
    },

    fetch: function () {
      if (!WP.bridgeFetch.available()) {
        /* browser/dev: feeds are CORS-blocked from a page, so say so instead of erroring
           forever. The demo strings double as the layout's fixture. */
        if (!this.items.length) {
          this.items = [
            { title: "Headlines appear here once the panel runs on the tablet", at: Date.now(), source: "News" },
            { title: "Feeds are fetched through the app shell, which a browser tab does not have", at: Date.now(), source: "News" }
          ];
          this.renderCard();
        }
        return;
      }
      var self = this;
      Promise.all(feedList().map(function (url) {
        return WP.bridgeFetch.get(url, { Accept: "application/rss+xml, application/xml, text/xml" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return parseFeed(r.text);
          })
          .catch(function () { return { source: "", items: [] }; })
      })).then(function (feeds) {
        var merged = merge(feeds);
        if (merged.length) {
          self.items = merged;
          self.fetchedAt = Date.now();
          self.stale = false;
          WP.store.writeJSON(CACHE, { items: merged, t: self.fetchedAt });
        } else if (self.items.length) {
          self.stale = true;           // keep showing what we have, marked old
        }
        self.idx = 0;
        self.renderCard();
        if (self.panel) self.paintPanel();
      });
    },

    advance: function () {
      if (this.items.length < 2 || WP.touching()) return;
      this.idx = (this.idx + 1) % Math.min(this.items.length, 12);
      this.renderCard();
    },

    renderCard: function () {
      var el = $("news-line");
      if (!el) return;
      if (!this.items.length) {
        el.innerHTML = '<span class="news-t muted">waiting for headlines…</span>';
        return;
      }
      var it = this.items[this.idx % this.items.length];
      el.innerHTML = '<span class="news-t">' + esc(it.title) + "</span>"
        + '<span class="news-meta">' + esc((it.source ? it.source + " · " : "") + ago(it.at))
        + (this.stale ? " · stale" : "") + "</span>";
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("news");
      if (!panel) return;
      WP.qs("[data-sub]", panel).textContent = this.fetchedAt
        ? "Updated " + WP.fmt.clock(new Date(this.fetchedAt), false) + (this.stale ? " · stale" : "")
        : "Headlines";
      var body = WP.qs("[data-body]", panel);
      if (!this.items.length) {
        body.innerHTML = '<div class="muted">No headlines yet.</div>';
        return;
      }
      /* SHOWN headlines, not all of them. Every merged item went into a scrollport that
         holds eight, so the panel always ended on a headline sliced through the middle of
         its own words ("…over Iran deal", fading out) — and nobody scrolls a wall panel, so
         the twenty-fourth story was never read by anyone. The ticker on the dashboard
         rotates through the first twelve; this is the same news, in the depth a glance from
         3 m can actually use. */
      /* SIX, not eight, and the rows share the panel between them.

         Eight headlines at ~23 CSS px — 4 arcminutes of cap height at 3 m — with 453 device
         px of black under the last one is the worst trade on the wall: the panel had the
         room to set the news at a size somebody on the sofa could read and it spent that
         room on nothing. Six at the section-heading tier fill the same screen, and a
         headline you can read from the sofa is the entire purpose of a news panel. */
      var SHOWN = 6;
      var shown = this.items.slice(0, SHOWN);
      /* When every headline on screen came from the same feed, the source moves INTO the
         heading and each row keeps only its age. It was printed on all six rows — "BBC News
         ·" six times down the left margin, the same eleven characters repeated at a 142 px
         pitch — which is a column that says the same thing in every row, i.e. texture and
         not data. The moment two feeds are actually merged the per-row source comes back,
         because then it is the thing that distinguishes one row from the next. */
      var one = shown.every(function (it) { return it.source === shown[0].source; })
        ? shown[0].source : "";
      var rows = shown.map(function (it) {
        var meta = (one || !it.source) ? ago(it.at) : it.source + " · " + ago(it.at);
        return '<div class="news-row">'
          + '<div class="news-row-t">' + esc(it.title) + "</div>"
          + '<div class="news-row-m">' + esc(meta) + "</div>"
          + "</div>";
      }).join("");
      WP.repaint(body, section(one ? "Latest · " + one : "Latest",
        '<div class="news-list">' + rows + "</div>"));
    }
  };

  /* the feed origins go on the shell's allowlist while the file parses; boot() locks it */
  feedList().forEach(function (url) {
    var o = WP.originOf(url);
    if (o && WP.fetchOrigins.indexOf(o) === -1) WP.fetchOrigins.push(o);
  });

  news.parseFeed = parseFeed;
  news.merge = merge;
  news.decodeEntities = decodeEntities;
  WP.register(news);
})();
