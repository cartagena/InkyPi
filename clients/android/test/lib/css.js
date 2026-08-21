/* A very small stylesheet reader, and a box model just large enough to answer one
   question: how tall is this control, in vh, as authored.

   Why this exists. The touch-target test used to work off a hand-written list of eight
   selectors, and a mutation that drove a Home Assistant tile's padding to zero survived
   because `.sensor` was not on the list. A list somebody maintains by hand is a list that
   goes stale the first time a widget gains a control — so the list now comes out of the
   rendered DOM (everything carrying `.tappable`) and the geometry comes out of the
   authored CSS, which means a new control is covered on the day it is added.

   What this is NOT: a CSS engine. There is no specificity, no inheritance beyond
   font-size, no percentages, no shorthand expansion beyond `padding`. It works because
   this stylesheet is deliberately flat — one rule per class, sizes exclusively off the vh
   ramp, `box-sizing: border-box` globally — and every one of those properties is itself
   asserted by design-system.test.js. If the stylesheet stops being flat, these numbers
   stop meaning anything, and the tests that pin flatness are what stand in the way.

   The landscape block is excluded from every lookup: the panel renders portrait (Samsung's
   large-screen policy ignores the manifest's orientation request) and the two ramps are
   deliberately different sizes. */

"use strict";

var fs = require("node:fs");
var path = require("node:path");

var SHEETS = ["style.css", "style-home.css", "style-panels.css", "style-widgets.css",
              "style-theme.css"];
var RAW = SHEETS.map(function (n) {
  return fs.readFileSync(path.join(__dirname, "..", "..", "assets", n), "utf8");
}).join("\n");

/* Comments first: this stylesheet's prose quotes plenty of old values, and a test that
   reads authored text must not mistake an explanation for a declaration. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

var CSS = stripComments(RAW);

/* Everything before the landscape @media — i.e. what the wall actually renders. */
var LANDSCAPE_AT = "@media (orientation: landscape)";
var PORTRAIT = CSS.indexOf(LANDSCAPE_AT) === -1 ? CSS : CSS.slice(0, CSS.indexOf(LANDSCAPE_AT));

function parse(css) {
  var out = [], re = /([^{}]+)\{([^{}]*)\}/g, m;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return out;
}

var PORTRAIT_RULES = parse(PORTRAIT);
var ALL_RULES = parse(CSS);

function decl(body, prop) {
  var m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(body);
  return m ? m[1].trim() : null;
}

/* ---------------- the type ramp ---------------- */

function rampFrom(block) {
  var out = {}, re = /--(fs-[a-z-]+)\s*:\s*([\d.]+)vh/g, m;
  while ((m = re.exec(block))) out[m[1]] = parseFloat(m[2]);
  return out;
}

function ramp() {
  var root = /:root\s*\{([\s\S]*?)\}/.exec(PORTRAIT);
  if (!root) throw new Error("no :root block");
  return rampFrom(root[1]);
}

function landscapeRamp() {
  var i = CSS.indexOf(LANDSCAPE_AT);
  if (i === -1) throw new Error("no landscape block");
  return rampFrom(CSS.slice(i));
}

var RAMP = ramp();

/* Every :root custom property whose value is a plain vh length — the type ramp and the
   control-padding scale together, since both are consumed the same way. */
function tokens() {
  var root = /:root\s*\{([\s\S]*?)\}/.exec(PORTRAIT);
  if (!root) throw new Error("no :root block");
  var out = {}, re = /--([a-z0-9-]+)\s*:\s*([\d.]+)vh\b/g, m;
  while ((m = re.exec(root[1]))) out[m[1]] = parseFloat(m[2]);
  return out;
}

var TOKENS = tokens();

/* A length in vh: a literal, a token, or calc(<token> * n) — the three forms this
   stylesheet uses. Anything else (a vw, a percentage, `auto`) returns null, and callers
   treat null as "this does not constrain the height". */
function vh(value) {
  if (value == null) return null;
  var v = String(value).trim();
  var lit = /^(-?[\d.]+)vh$/.exec(v);
  if (lit) return parseFloat(lit[1]);
  var token = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (token) return TOKENS[token[1]] == null ? null : TOKENS[token[1]];
  var calc = /^calc\(\s*var\(--([a-z0-9-]+)\)\s*\*\s*([\d.]+)\s*\)$/.exec(v);
  if (calc) return TOKENS[calc[1]] == null ? null : TOKENS[calc[1]] * parseFloat(calc[2]);
  return null;
}

/* ---------------- how big a size actually is, on the wall ----------------
   The unit the design brief is written in. This panel is 244.5 x 152.8 mm of active area at
   2560 x 1600, so 1 CSS px = 0.215 mm and 1vh = 11.38 CSS px; cap height is ~0.72 em; and a
   feature h mm tall subtends h / 3000 * 3438 arcminutes at 3 m, which is the distance the
   thing is read from. 20/20 acuity RESOLVES ~5' — the threshold at which a glyph stops
   being a smudge — and fluent glance-reading wants 12-18'.

   It exists because "is 1.85vh big enough" is not answerable and "is 3.7 arcminutes big
   enough" is: no. Every legibility floor in design-system.test.js is stated in arcminutes
   for that reason, so a later round cannot argue a step down is fine. */
var CSS_PX_PER_VH = 11.38;
var MM_PER_CSS_PX = 0.215;
var CAP_RATIO = 0.72;
var VIEWING_MM = 3000;

function arcmin(sizeVh) {
  if (sizeVh == null) return null;
  return sizeVh * CSS_PX_PER_VH * MM_PER_CSS_PX * CAP_RATIO / VIEWING_MM * 3437.75;
}

/* The value a property RESOLVES to for this element: its own rule, or the nearest ancestor
   that declares it. font-size and color both inherit, and the two questions the legibility
   tests ask are always about the pair together — a size means nothing without the contrast
   it is drawn at. */
function inherited(el, prop) {
  for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
    var v = styleOf(n, prop);
    if (v != null) return v;
  }
  return null;
}

/* The token NAME a declaration used, or null if it authored a literal. This is what the
   spacing-scale test asks about — the value alone cannot tell a 1.8vh that came off the
   scale from a 1.8vh somebody typed. */
function tokenName(value) {
  var m = /^var\(--([a-z0-9-]+)\)/.exec(String(value == null ? "" : value).trim());
  return m ? m[1] : null;
}

/* ---------------- matching a rule to an element ----------------
   Only the RIGHTMOST compound of each comma-separated part is considered, and it matches
   when every class it names is on the element (and its tag, if it names one). Ancestor
   constraints are ignored — an over-match, and a deliberate one: it can only make a
   control look SMALLER or equal here, never larger, so the touch-target floor stays a
   conservative claim. */
function compoundMatches(compound, el) {
  var classes = (compound.match(/\.[A-Za-z0-9_-]+/g) || []).map(function (c) { return c.slice(1); });
  var tag = /^[a-z][a-z0-9]*/.exec(compound);
  if (!classes.length && !tag) return false;
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  var own = (el.getAttribute("class") || "").split(/\s+/);
  return classes.every(function (c) { return own.indexOf(c) !== -1; });
}

function appliesTo(sel, el) {
  return sel.split(",").some(function (part) {
    var compounds = part.trim().split(/\s*[>+~]\s*|\s+/);
    return compoundMatches(compounds[compounds.length - 1], el);
  });
}

/* Last declaration wins — no specificity arithmetic, which is sound here because the
   stylesheet is authored flat and in cascade order. */
function styleOf(el, prop) {
  var found = null;
  PORTRAIT_RULES.forEach(function (r) {
    if (!appliesTo(r.sel, el)) return;
    var d = decl(r.body, prop);
    if (d != null) found = d;
  });
  return found;
}

/* ---------------- the box model ---------------- */

/* 16 CSS px is the browser's default font-size and nothing in this app overrides it at the
   root, so an element with no size anywhere up its chain lands here. 1vh = 11.38 CSS px on
   this panel. */
var ROOT_VH = 16 / 11.38;

function fontVh(el) {
  for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
    var f = vh(styleOf(n, "font-size"));
    if (f != null) return f;
  }
  return ROOT_VH;
}

function lineVh(el) {
  var lh = styleOf(el, "line-height");
  var factor = lh && /^[\d.]+$/.test(lh.trim()) ? parseFloat(lh) : 1.2;
  return fontVh(el) * factor;
}

function verticalPadding(el) {
  var p = styleOf(el, "padding");
  if (!p) return 0;
  var parts = p.split(/\s+/);
  var top = vh(parts[0]) || 0;
  var bottom = parts.length >= 3 ? (vh(parts[2]) || 0) : top;
  return top + bottom;
}

function rowGapVh(el) {
  var g = styleOf(el, "gap");
  if (!g) return 0;
  return vh(g.split(/\s+/)[0]) || 0;      // `gap: 1.2vh 2vw` -> the row gap
}

function isColumn(el) {
  return /column/.test(styleOf(el, "flex-direction") || "");
}

/* Height of the element's border box, in vh. `* { box-sizing: border-box }` is declared at
   the top of the stylesheet, so a declared height IS the box and nothing is added to it. */
function boxVh(el) {
  var fixed = vh(styleOf(el, "height"));
  if (fixed != null) return fixed;

  var kids = (el.children || []).filter(function (c) { return c.nodeType === 1; });
  var content;
  if (!kids.length) {
    content = lineVh(el);
  } else if (isColumn(el)) {
    content = kids.reduce(function (a, k) { return a + boxVh(k); }, 0)
      + rowGapVh(el) * (kids.length - 1);
  } else {
    content = kids.reduce(function (a, k) { return Math.max(a, boxVh(k)); }, 0);
  }
  return verticalPadding(el) + content;
}

module.exports = {
  RAW: RAW,
  CSS: CSS,
  PORTRAIT: PORTRAIT,
  stripComments: stripComments,
  rules: function () { return ALL_RULES; },
  portraitRules: function () { return PORTRAIT_RULES; },
  decl: decl,
  ramp: ramp,
  landscapeRamp: landscapeRamp,
  tokens: tokens,
  vh: vh,
  tokenName: tokenName,
  styleOf: styleOf,
  fontVh: fontVh,
  arcmin: arcmin,
  inherited: inherited,
  verticalPadding: verticalPadding,
  boxVh: boxVh
};
