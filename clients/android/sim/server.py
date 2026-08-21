# Inky OLED simulator server.
#
# Serves the REAL app straight out of the repo's assets/ directory (so a source edit
# shows on the next reload), plus two things a browser tab cannot do on its own:
#
# Run:  python sim/server.py    then open http://localhost:8788/cockpit
#
#   /sim-bridge.js  a stand-in for MainActivity's window.Android, injected into
#                   index.html before config.js so the app boots believing it is on
#                   the tablet (fake device snapshot, localStorage prefs, and a
#                   bridge fetch that rides the proxy below).
#   /__proxy?u=     server-side fetch, because the page's CORS rules would block the
#                   news feeds and Home Assistant exactly as they would on the wall
#                   without the Java shell. GET/POST, http(s) only, localhost only.

import http.server
import os
import re
import time
import urllib.parse
import urllib.request

SIM = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(SIM), "assets")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ASSETS, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        # The whole point of this server is that a source edit shows on the next reload.
        # Static assets went out of SimpleHTTPRequestHandler with only Last-Modified on
        # them, so Chrome heuristically cached wx-*.js and went on running the previous
        # version of a widget after the file on disk had changed — a measurement loop that
        # silently measures the old build is worse than no measurement loop.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/__proxy"):
            return self.proxy("GET")
        if self.path.split("?")[0] in ("/", "/index.html"):
            return self.send_index()
        if self.path.startswith("/cockpit"):
            return self.send_file(os.path.join(SIM, "cockpit.html"), "text/html; charset=utf-8")
        if self.path.split("?")[0] in ("/sim-bridge.js", "/sim-harness.js"):
            return self.send_file(os.path.join(SIM, self.path.split("?")[0].lstrip("/")),
                                  "text/javascript")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__proxy"):
            return self.proxy("POST")
        self.send_error(405)

    def send_bytes(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        with open(path, "rb") as f:
            self.send_bytes(200, f.read(), ctype)

    def send_index(self):
        with open(os.path.join(ASSETS, "index.html"), encoding="utf-8") as f:
            html = f.read()
        # Cache-Control: no-store on the assets themselves was not enough — a reload with
        # the pane still open kept serving the previous wx-*.js out of the memory cache, so
        # a measurement was of the build before the edit. Stamp every asset URL with the
        # page's load time and the question cannot arise.
        html = html.replace(
            '<script src="config.js"></script>',
            '<script src="/sim-bridge.js"></script>\n<script src="config.js"></script>')
        html = html.replace("</body>", '<script src="/sim-harness.js"></script>\n</body>')
        # ...and the stamp goes on last, so the two injections above are still matching
        # the markup as authored rather than a URL this function has already rewritten.
        stamp = str(int(time.time()))
        html = re.sub(r'(<script src="|<link rel="stylesheet" href=")([^"?]+)"',
                      lambda m: '%s%s?v=%s"' % (m.group(1), m.group(2), stamp), html)
        self.send_bytes(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def proxy(self, method):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (q.get("u") or [None])[0]
        if not url or not url.startswith(("http://", "https://")):
            return self.send_error(400)
        body = None
        if method == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("User-Agent", "InkyOLED-sim")
        for h in ("Authorization", "Accept", "Content-Type"):
            v = self.headers.get("X-Sim-" + h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data = r.read(1536 * 1024)
                code = r.status
        except urllib.error.HTTPError as e:
            data = e.read(1536 * 1024) if e.fp else b""
            code = e.code
        except Exception as e:
            return self.send_bytes(502, str(e).encode(), "text/plain")
        self.send_bytes(code, data, "application/octet-stream")


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", 8788), Handler).serve_forever()
