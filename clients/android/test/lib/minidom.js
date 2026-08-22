/* minidom — just enough DOM to run the dashboard's real source under node:test.
   Zero dependencies (node's stdlib only), because the app itself has none.

   Why a DOM at all, rather than exporting the app's internals: the four regressions this
   suite exists to catch live in gesture delegation, panel state and re-render timing, and
   the only honest way to reach those is to parse the real index.html, load the real
   app.js / widgets.js, and dispatch real pointer events at real elements. Nothing in
   assets/ is modified to suit the tests.

   Deliberately NOT implemented: layout (every rect is (0,0,0,0) unless a test sets one),
   CSS, and anything the app does not touch. If a test needs geometry it says so out loud
   by calling el.setRect(). */

"use strict";

var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
             link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
var RAWTEXT = { script: 1, style: 1 };

var ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", rsaquo: "›", lsaquo: "‹", larr: "←",
  rarr: "→", uarr: "↑", middot: "·", deg: "°",
  minus: "−", times: "×", mdash: "—", ndash: "–",
  copy: "©", eacute: "é"
};

function decodeEntities(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, g) {
    if (g.charAt(0) === "#") {
      var n = (g.charAt(1) === "x" || g.charAt(1) === "X")
        ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return isNaN(n) ? m : String.fromCodePoint(n);
    }
    return ENTITIES[g] !== undefined ? ENTITIES[g] : m;
  });
}

/* ---------------- nodes ---------------- */

function TextNode(data) {
  this.nodeType = 3;
  this.data = data;
  this.parentNode = null;
}
Object.defineProperty(TextNode.prototype, "textContent", {
  get: function () { return this.data; },
  set: function (v) { this.data = String(v); }
});

function Element(tag, doc) {
  this.nodeType = 1;
  this.tagName = String(tag).toUpperCase();
  this.attributes = Object.create(null);
  this.children = [];              // element + text children, in document order
  this.parentNode = null;
  this.ownerDocument = doc || null;
  this.style = {};
  this.listeners = Object.create(null);
  this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  this.scrollTop = 0;
  this.scrollLeft = 0;
  this.offsetHeight = 0;
  this.offsetWidth = 0;
  this.clientHeight = 0;
  this.clientWidth = 0;
  this.scrollHeight = 0;
  this.scrollWidth = 0;
  var self = this;
  this.classList = {
    contains: function (c) { return self._classes().indexOf(c) !== -1; },
    add: function () {
      var cs = self._classes();
      for (var i = 0; i < arguments.length; i++) {
        if (cs.indexOf(arguments[i]) === -1) cs.push(arguments[i]);
      }
      self.className = cs.join(" ");
    },
    remove: function () {
      var drop = Array.prototype.slice.call(arguments);
      self.className = self._classes().filter(function (c) {
        return drop.indexOf(c) === -1;
      }).join(" ");
    },
    toggle: function (c, force) {
      var on = (force === undefined) ? !self.classList.contains(c) : !!force;
      if (on) self.classList.add(c); else self.classList.remove(c);
      return on;
    }
  };
}

Element.prototype._classes = function () {
  var v = this.attributes["class"];
  return v ? String(v).split(/\s+/).filter(Boolean) : [];
};

Object.defineProperty(Element.prototype, "className", {
  get: function () { return this.attributes["class"] || ""; },
  set: function (v) { this.attributes["class"] = String(v); }
});
Object.defineProperty(Element.prototype, "id", {
  get: function () { return this.attributes.id || ""; },
  set: function (v) { this.attributes.id = String(v); }
});
Object.defineProperty(Element.prototype, "hidden", {
  get: function () { return this.attributes.hidden !== undefined; },
  set: function (v) {
    if (v) this.attributes.hidden = "";
    else delete this.attributes.hidden;
  }
});
Object.defineProperty(Element.prototype, "childNodes", {
  get: function () { return this.children; }
});
Object.defineProperty(Element.prototype, "firstChild", {
  get: function () { return this.children[0] || null; }
});

Object.defineProperty(Element.prototype, "textContent", {
  get: function () {
    return this.children.map(function (c) {
      return c.nodeType === 3 ? c.data : c.textContent;
    }).join("");
  },
  set: function (v) {
    this.children = [];
    var t = new TextNode(String(v));
    t.parentNode = this;
    this.children.push(t);
  }
});

Object.defineProperty(Element.prototype, "innerHTML", {
  get: function () { return serialize(this); },
  set: function (html) {
    this.children = [];
    parseInto(this, String(html), this.ownerDocument);
  }
});

Element.prototype.getAttribute = function (n) {
  var v = this.attributes[n];
  return v === undefined ? null : v;
};
Element.prototype.setAttribute = function (n, v) { this.attributes[n] = String(v); };
Element.prototype.hasAttribute = function (n) { return this.attributes[n] !== undefined; };
Element.prototype.removeAttribute = function (n) { delete this.attributes[n]; };

Element.prototype.appendChild = function (node) {
  node.parentNode = this;
  this.children.push(node);
  return node;
};
Element.prototype.removeChild = function (node) {
  var i = this.children.indexOf(node);
  if (i !== -1) this.children.splice(i, 1);
  node.parentNode = null;
  return node;
};

Element.prototype.getBoundingClientRect = function () { return this._rect; };
/* Test-facing: geometry only exists where a test explicitly puts it. */
Element.prototype.setRect = function (r) {
  this._rect = {
    left: r.left, top: r.top,
    right: r.right !== undefined ? r.right : r.left + (r.width || 0),
    bottom: r.bottom !== undefined ? r.bottom : r.top + (r.height || 0),
    width: r.width !== undefined ? r.width : r.right - r.left,
    height: r.height !== undefined ? r.height : r.bottom - r.top
  };
  return this;
};
Element.prototype.scrollTo = function (opt) {
  if (opt && typeof opt === "object") {
    if (opt.left != null) this.scrollLeft = opt.left;
    if (opt.top != null) this.scrollTop = opt.top;
  }
};
Element.prototype.focus = function () {};
Element.prototype.blur = function () {};

/* ---------------- selectors ---------------- */

function parseCompound(str) {
  var c = { tag: null, id: null, classes: [], attrs: [] };
  var i = 0;
  while (i < str.length) {
    var ch = str.charAt(i);
    if (ch === "*" || ch === " ") { i++; continue; }
    if (ch === "#" || ch === ".") {
      var j = i + 1;
      while (j < str.length && /[\w-]/.test(str.charAt(j))) j++;
      if (ch === "#") c.id = str.slice(i + 1, j); else c.classes.push(str.slice(i + 1, j));
      i = j; continue;
    }
    if (ch === "[") {
      var end = str.indexOf("]", i);
      if (end === -1) break;
      var body = str.slice(i + 1, end);
      var m = body.match(/^\s*([\w-]+)\s*(?:=\s*(.*?)\s*)?$/);
      if (m) {
        var val = m[2];
        if (val != null) val = val.replace(/^['"]/, "").replace(/['"]$/, "");
        c.attrs.push({ name: m[1], value: val === undefined ? null : val });
      }
      i = end + 1; continue;
    }
    var k = i;
    while (k < str.length && /[\w-]/.test(str.charAt(k))) k++;
    if (k > i) { c.tag = str.slice(i, k).toLowerCase(); i = k; continue; }
    i++;
  }
  return c;
}

/* one group -> ordered steps, each carrying the combinator that joins it to the previous */
function parseGroup(sel) {
  var parts = sel.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  var steps = [];
  var comb = null;
  parts.forEach(function (p) {
    if (p === ">") { comb = ">"; return; }
    steps.push({ comb: steps.length === 0 ? null : (comb || " "), c: parseCompound(p) });
    comb = null;
  });
  return steps;
}

function parseSelector(sel) {
  return String(sel).split(",").map(function (s) { return parseGroup(s); });
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag.toUpperCase()) return false;
  if (c.id && el.id !== c.id) return false;
  for (var i = 0; i < c.classes.length; i++) {
    if (!el.classList.contains(c.classes[i])) return false;
  }
  for (var j = 0; j < c.attrs.length; j++) {
    var a = c.attrs[j];
    var v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

function matchGroup(el, steps) {
  var idx = steps.length - 1;
  if (!matchCompound(el, steps[idx].c)) return false;
  var node = el;
  for (var k = idx; k > 0; k--) {
    var comb = steps[k].comb;
    var want = steps[k - 1].c;
    node = node.parentNode;
    if (comb === ">") {
      if (!node || !matchCompound(node, want)) return false;
    } else {
      var ok = false;
      while (node && node.nodeType === 1) {
        if (matchCompound(node, want)) { ok = true; break; }
        node = node.parentNode;
      }
      if (!ok) return false;
    }
  }
  return true;
}

function matches(el, sel) {
  var groups = parseSelector(sel);
  for (var i = 0; i < groups.length; i++) if (matchGroup(el, groups[i])) return true;
  return false;
}

function walk(root, fn) {
  (root.children || []).forEach(function (c) {
    if (c.nodeType !== 1) return;
    fn(c);
    walk(c, fn);
  });
}

function queryAll(root, sel) {
  var groups = parseSelector(sel);
  var out = [];
  walk(root, function (el) {
    for (var i = 0; i < groups.length; i++) {
      if (matchGroup(el, groups[i])) { out.push(el); return; }
    }
  });
  return out;
}

Element.prototype.matches = function (sel) { return matches(this, sel); };
Element.prototype.querySelector = function (sel) { return queryAll(this, sel)[0] || null; };
Element.prototype.querySelectorAll = function (sel) { return queryAll(this, sel); };
Element.prototype.closest = function (sel) {
  var node = this;
  while (node && node.nodeType === 1) {
    if (matches(node, sel)) return node;
    node = node.parentNode;
  }
  return null;
};

/* ---------------- events ---------------- */

function addListener(target, type, fn, opts) {
  var capture = (opts === true) || (opts && opts.capture === true);
  (target.listeners[type] || (target.listeners[type] = []))
    .push({ fn: fn, capture: capture });
}
function removeListener(target, type, fn) {
  var l = target.listeners[type];
  if (!l) return;
  target.listeners[type] = l.filter(function (e) { return e.fn !== fn; });
}

Element.prototype.addEventListener = function (t, f, o) { addListener(this, t, f, o); };
Element.prototype.removeEventListener = function (t, f) { removeListener(this, t, f); };

/* Dispatch with a real capture -> target -> bubble order. The app puts almost every
   listener on `document` with capture:true and one on `document` bubbling (click), and
   the ordering between those two is exactly what the gesture code depends on. */
function dispatch(doc, target, type, props) {
  var ev = { type: type, target: target, currentTarget: null, defaultPrevented: false };
  Object.keys(props || {}).forEach(function (k) { ev[k] = props[k]; });
  ev.preventDefault = function () { ev.defaultPrevented = true; };
  ev.stopPropagation = function () { ev._stopped = true; };

  var path = [];
  var n = target;
  while (n && n.nodeType === 1) { path.push(n); n = n.parentNode; }
  path.push(doc);

  var i, entry, list;
  for (i = path.length - 1; i >= 0 && !ev._stopped; i--) {       // capture
    list = (path[i].listeners[type] || []).slice();
    for (var a = 0; a < list.length; a++) {
      entry = list[a];
      if (!entry.capture) continue;
      ev.currentTarget = path[i];
      entry.fn.call(path[i], ev);
    }
  }
  for (i = 0; i < path.length && !ev._stopped; i++) {            // bubble
    list = (path[i].listeners[type] || []).slice();
    for (var b = 0; b < list.length; b++) {
      entry = list[b];
      if (entry.capture) continue;
      ev.currentTarget = path[i];
      entry.fn.call(path[i], ev);
    }
  }
  return ev;
}

/* ---------------- parser ---------------- */

function parseInto(parent, html, doc) {
  var stack = [parent];
  var i = 0;
  function top() { return stack[stack.length - 1]; }

  while (i < html.length) {
    var lt = html.indexOf("<", i);
    if (lt === -1) { addText(top(), html.slice(i), doc); break; }
    if (lt > i) addText(top(), html.slice(i, lt), doc);

    if (html.substr(lt, 4) === "<!--") {
      var ce = html.indexOf("-->", lt);
      i = ce === -1 ? html.length : ce + 3;
      continue;
    }
    if (html.substr(lt, 2) === "<!") {
      var de = html.indexOf(">", lt);
      i = de === -1 ? html.length : de + 1;
      continue;
    }
    if (html.substr(lt, 2) === "</") {
      var te = html.indexOf(">", lt);
      var name = html.slice(lt + 2, te).trim().toLowerCase();
      for (var s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName === name.toUpperCase()) { stack.length = s; break; }
      }
      i = te === -1 ? html.length : te + 1;
      continue;
    }

    var gt = findTagEnd(html, lt);
    var raw = html.slice(lt + 1, gt);
    var selfClose = /\/$/.test(raw.trim());
    if (selfClose) raw = raw.trim().slice(0, -1);
    var sp = raw.search(/[\s/]/);
    var tag = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase();
    var el = new Element(tag, doc);
    parseAttrs(el, sp === -1 ? "" : raw.slice(sp));
    top().appendChild(el);
    i = gt + 1;

    if (RAWTEXT[tag]) {
      var close = html.toLowerCase().indexOf("</" + tag, i);
      if (close === -1) close = html.length;
      var body = html.slice(i, close);
      if (body) addText(el, body, doc, true);
      var after = html.indexOf(">", close);
      i = after === -1 ? html.length : after + 1;
      continue;
    }
    if (!VOID[tag] && !selfClose) stack.push(el);
  }
  return parent;
}

/* attribute values can contain ">" (inline styles, transforms) — respect quoting */
function findTagEnd(html, start) {
  var q = null;
  for (var i = start + 1; i < html.length; i++) {
    var ch = html.charAt(i);
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ">") return i;
  }
  return html.length;
}

function parseAttrs(el, str) {
  var re = /([\w:@.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  var m;
  while ((m = re.exec(str))) {
    var name = m[1];
    var val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ""));
    el.attributes[name] = decodeEntities(val);
  }
}

function addText(parent, text, doc, raw) {
  var t = new TextNode(raw ? text : decodeEntities(text));
  t.parentNode = parent;
  parent.children.push(t);
}

function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serialize(el) {
  return el.children.map(function (c) {
    if (c.nodeType === 3) return escapeText(c.data);
    var attrs = Object.keys(c.attributes).map(function (k) {
      return " " + k + '="' + String(c.attributes[k]).replace(/"/g, "&quot;") + '"';
    }).join("");
    var tag = c.tagName.toLowerCase();
    if (VOID[tag]) return "<" + tag + attrs + ">";
    return "<" + tag + attrs + ">" + serialize(c) + "</" + tag + ">";
  }).join("");
}

/* ---------------- document ---------------- */

function createDocument(html) {
  var doc = {
    nodeType: 9,
    children: [],
    listeners: Object.create(null),
    readyState: "loading",
    parentNode: null
  };
  doc.createElement = function (tag) { return new Element(tag, doc); };
  doc.createTextNode = function (t) { return new TextNode(String(t)); };
  doc.querySelector = function (sel) { return queryAll(doc, sel)[0] || null; };
  doc.querySelectorAll = function (sel) { return queryAll(doc, sel); };
  doc.getElementById = function (id) {
    var found = null;
    walk(doc, function (el) { if (!found && el.id === id) found = el; });
    return found;
  };
  doc.addEventListener = function (t, f, o) { addListener(doc, t, f, o); };
  doc.removeEventListener = function (t, f) { removeListener(doc, t, f); };
  doc.dispatch = function (target, type, props) { return dispatch(doc, target, type, props); };
  doc.appendChild = function (n) { n.parentNode = doc; doc.children.push(n); return n; };

  parseInto(doc, html || "<html><head></head><body></body></html>", doc);
  doc.documentElement = doc.querySelector("html") || doc.children[0];
  doc.body = doc.querySelector("body");
  if (!doc.body) {
    doc.body = new Element("body", doc);
    (doc.documentElement || doc).appendChild(doc.body);
  }
  doc.head = doc.querySelector("head");
  return doc;
}

module.exports = {
  createDocument: createDocument,
  Element: Element,
  decodeEntities: decodeEntities,
  matches: matches,
  queryAll: queryAll
};
