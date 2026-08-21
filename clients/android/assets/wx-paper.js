/* Wall panel dashboard — FRONT PAGE.

   InkyPi's newspaper plugin, on glass: today's actual front page from the Freedom Forum's
   daily archive (the source InkyPi itself uses). No key, no account. Which paper is
   config: `newspaper: { code: "USAT" }` — the codes are the Freedom Forum's own
   (USAT, NY_NYT, WSJ, CA_LAT, CA_SDUT, DC_WP, …).

   The image rides the bridge fetch and lands as a data: URI — the CSP allows img-src
   data: and nothing remote, so this is the one road a remote image has into the page,
   and it keeps the allowlist in charge of where images may come from.

   The CDN shelves each day under /dfp/jpg{day-of-month}/. Around midnight, and for the
   handful of papers that skip a day, today's shelf 404s — so the fetch walks back up to
   three days rather than leaving yesterday's reader a blank card. The page shown is
   always labelled with the shelf it actually came from.

   One widget, one flat file (assets/ cannot hold subdirectories — aapt2 on Windows
   writes the separator as a backslash and file:///android_asset/ cannot resolve it).
*/

(function () {
  "use strict";

  var C = WP.C;
  var $ = WP.$, esc = WP.esc, fmt = WP.fmt;

  var CDN = "https://cdn.freedomforum.org";

  function code() {
    return ((C.newspaper && C.newspaper.code) || "USAT").toUpperCase();
  }

  /* day -> the URL of that day's shelf. Pure and exported for the tests. */
  function urlFor(dayOfMonth, paperCode) {
    return CDN + "/dfp/jpg" + dayOfMonth + "/lg/" + paperCode + ".jpg";
  }

  var paper = {
    name: "paper",
    uri: null,           // data: URI of the page being shown
    problem: null,       // why the last attempt gave up, in the tile's words
    shownDay: 0,         // which shelf it actually came from
    fetchedAt: 0,
    panel: null,

    init: function () {
      this.renderCard();
      this.fetch();
      /* Front pages change once a day; the extra checks catch the late upload. */
      setInterval(this.fetch.bind(this), 6 * 3600 * 1000);
    },

    fetch: function () {
      if (!WP.bridgeFetch.available()) {
        this.renderCard("needs the tablet");
        return;
      }
      var self = this;
      var today = new Date().getDate();
      /* today's shelf, then up to three days back — labelled, never silently stale */
      var tries = [0, 1, 2, 3].map(function (back) {
        var d = new Date(Date.now() - back * 86400000).getDate();
        return { day: d };
      });

      var offline = false;
      (function attempt(i) {
        if (i >= tries.length) {
          /* "no page found" read as "this paper does not exist" when the truth was a dead
             wifi. The shelf walk records WHY it gave up. */
          self.problem = offline ? "no connection" : "not published yet";
          self.renderCard(self.problem);
          if (self.panel) self.paintPanel();
          return;
        }
        WP.bridgeFetch.get(urlFor(tries[i].day, code()), { Accept: "image/jpeg" })
          .then(function (r) {
            if (!r.ok || !r.b64) throw new Error("HTTP " + r.status);
            self.uri = r.dataUri("image/jpeg");
            self.shownDay = tries[i].day;
            self.fetchedAt = Date.now();
            self.renderCard();
            if (self.panel) self.paintPanel();
          })
          .catch(function (e) {
            if (/offline|failed to fetch|timed out|network|refused/i.test(String(e && e.message))) {
              offline = true;
            }
            attempt(i + 1);
          });
      })(0);
    },

    renderCard: function (problem) {
      var big = $("paper-big"), sub = $("paper-sub");
      if (!big) return;
      big.textContent = code().replace(/^[A-Z]{2}_/, "");
      if (problem) { sub.textContent = problem; return; }
      if (!this.uri) { sub.textContent = "fetching…"; return; }
      var today = new Date().getDate();
      sub.textContent = this.shownDay === today ? "today's page"
        : "page of the " + fmt.ordinal(this.shownDay);
    },

    onOpen: function (panel) { this.panel = panel; this.paintPanel(); },
    onClose: function () { this.panel = null; },

    paintPanel: function () {
      var panel = this.panel || WP.panels.el("paper");
      if (!panel) return;
      var today = new Date().getDate();
      WP.qs("[data-sub]", panel).textContent = this.uri
        ? (this.shownDay === today
            ? "Today's front page"
            : "Front page of the " + fmt.ordinal(this.shownDay) + " — today's is not up yet")
        : "Front page";
      var body = WP.qs("[data-body]", panel);
      if (!this.uri) {
        var why = !WP.bridgeFetch.available()
          ? ["Front pages arrive through the app shell.",
             "A browser tab does not have one; the tablet does."]
          : this.problem === "no connection"
          ? ["No connection to the newspaper archive.",
             "It tries again on its own, and shows the last page it managed to fetch."]
          : this.problem
          ? ["Today's front page is not up yet.",
             "The archive posts through the morning; this checks again on its own."]
          : ["Fetching today's front page…", ""];
        body.innerHTML = '<div class="pic-empty"><div class="pic-empty-t">' + esc(why[0])
          + '</div><div class="pic-empty-s">' + esc(why[1]) + "</div></div>";
        return;
      }
      /* The page IS the screen: letterboxed on black, no chrome competing with it.
         alt text, not a caption — the page carries its own headlines. */
      body.innerHTML = '<div class="page-wrap">'
        + '<img class="page-img" src="' + this.uri + '" alt="' + esc(code()) + ' front page">'
        + "</div>";
    }
  };

  /* the CDN goes on the shell's allowlist while the file parses; boot() locks it */
  if (WP.originOf(CDN) && WP.fetchOrigins.indexOf(WP.originOf(CDN)) === -1) {
    WP.fetchOrigins.push(WP.originOf(CDN));
  }

  paper.urlFor = urlFor;
  paper.code = code;
  WP.register(paper);
})();
