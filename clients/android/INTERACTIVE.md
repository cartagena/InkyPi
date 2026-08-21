# The interactive layer

Inky OLED started as a static dashboard that repainted itself and ignored touch. It is now a
touch-driven app: every card opens a full-screen detail panel, the stopwatch and timer really
run, Home Assistant toggles hold state, and the settings panel writes preferences that survive
a force-stop.

This document covers what each widget does, how touch is wired, what is persisted and where,
the Android JS bridge, and the two behaviours that exist purely because the device is screwed
to a wall: burn-in drift and the idle unwind.

Files: `assets/index.html` (panel shells), `assets/app.js` (shared plumbing),
`assets/wx-ui.js` (the shared panel builders) and one `assets/wx-<widget>.js` per widget,
`assets/style.css`, `src/com/justin/inkyoled/MainActivity.java` (kiosk shell + bridge).

`assets/` is flat by necessity — aapt2 on Windows writes a subdirectory separator as a
backslash and `file:///android_asset/` cannot resolve it — so "one file per widget" means
nine files rather than a directory. `index.html` pins their load order and
`test/assets.test.js` asserts it: `wx-ui.js` before every widget, `wx-weather.js` before
`wx-hourly.js` / `wx-daily.js` (they read its payload out of `WP.registry`), and
`wx-sensors.js` before `wx-settings.js`.

---

## The 500-line file budget

No shipped source file exceeds 500 lines (enforced by a test). The seams: `app.js`
(bridge, settings, store) → `app-view.js` (formatting, layout, drift) → `app-touch.js`
(panels, gestures, idle, boot); `wx-sensors-demo.js` (simulator) → `wx-sensors.js`
(state + live feed) → `wx-sensors-panel.js` (detail panel); four stylesheets
(`style.css` tokens+base, `-home`, `-panels`, `-theme`); `MainActivity.java` +
`BridgeFetch.java`.

## The eleven widgets

Every widget is a plugin object registered with `WP.register()`: `init()` at boot with its own
refresh cadence, `onOpen(panel, arg)` to fill its detail panel, `onClose()` to tear down
whatever the panel started.

Two of them are new since the colour redesign and cost no API key: **Moon** (phase computed
locally from the mean synodic month; the disc in the tile and the panel share one crescent
path with the icon set) and **Air** (Open-Meteo's air-quality endpoint, same CORS posture as
the weather fetch; the AQI number wears the EPA band colours and the strip under it says which
of the six bands today is in).

A third, **Date**, was cut: a month grid computed locally, with no events, because this product
has no account and no sync by design. See the note in README — a screen that restates the Clock
card's date is not a screen.

## Screens, swipes and the playlist

Every panel doubles as a full screen. A horizontal swipe inside one slides to its
neighbour (`WP.panels.swap`: the outgoing screen exits sideways while the incoming one
enters from the opposite edge, and the stack is REPLACED, so Android back always returns
to the dashboard). Wrap-around at both ends, position dots that fade after a moment, and
swipes that begin inside a horizontally scrollable strip belong to that strip.

The optional **Cycle screens** switch is InkyPi's playlist on glass: every dwell (config
`cycle: { seconds: … }`, clamped 8–60 s, default 20) the panel slides to the next content
screen — tools (Settings, Device, Timer) are never cycled into — and after the last one
it returns to the dashboard. Any touch pauses the playlist for 45 s, a ringing alarm
blocks it entirely, and a tool screen opened by hand is never taken away.

## The bridge fetch and the News widget

`Android.httpFetch` (MainActivity) is the shell doing the page's networking: base64 payloads
come back through `WP.bridgeFetch` as promises. It exists because the page's `file://` origin
made CORS fatal for anything with an auth header (Home Assistant) and anything that never
sends CORS headers (every RSS feed). It is deliberately narrow:

- the **origin allowlist** is registered once at boot from config-derived origins
  (`WP.fetchOrigins`) and is first-write-wins on the Java side, so nothing that attaches to
  the page later — the userdebug devtools socket included — can widen it;
- GET/POST only, http(s) only, every redirect hop re-validated against the allowlist;
- responses capped at 1.5 MB, request bodies at 8 KB, 8 s per hop, three redirects;
- only `Authorization`, `Accept` and `Content-Type` headers cross the boundary.

**News** is the first widget that only exists because of it: RSS/Atom headlines (defaults:
BBC World + NPR, override with `news: { feeds: […] }` in config.js), parsed by a small pure
parser, deduped and merged newest-first. The home card is a one-line ticker rotating every
12 s — moving text is also burn-in-friendly — and the panel lists the merged headlines with
source and age. In a browser (no shell) the ticker explains itself instead of failing.

## The colour layer and the sky

The panel used to be monochrome because Android's emoji font rendered any colour-capable
codepoint as an uncontrollable sprite. The weather icons are now the app's own SVG
(`wx-icons.js`), so colour is deliberate: every colour is a `--ic-*` / `--temp-*` / `--aqi-*`
token in `style.css` (a hex literal inside the icon file is a test failure), warm things are
warm, rain is blue, and temperature charts run a hot-to-cold gradient in user space so peaks
literally read warm.

Behind the dashboard, `wx-sky.js` draws the current conditions on a full-screen canvas: stars
that twinkle on a clear night, a wandering sun/moon glow, drifting cloud banks, angled rain,
swaying snow, sliding fog bands, and a dim (≤0.25 alpha) flash every few seconds in a storm.
It subscribes to the same Open-Meteo payload the cards render from, runs at ~30 fps, stops
entirely when the app is hidden or the "Weather in the background" switch in Settings is off,
and every element moves so it cannot burn in.

### 1. Clock — real device time

**Card:** time in 12- or 24-hour form, optional seconds, meridiem, long date. Seconds sit
directly against the digits and the meridiem follows, so the row reads `2:33:01 AM`. Both stay
on the digits' baseline — stacking them costs ~59 device px the column budget does not have.

**Panel:** live readout with seconds, full date, and two sections — *This device* (time zone,
UTC offset, day of year, ISO week, epoch seconds, clock format) and *World clocks* (nine zones
computed with `Intl.DateTimeFormat`, so no network and no key). Repaints at 1 Hz while open.

### 2. Stopwatch & Timer — real elapsed time

Timekeeping is done from `Date.now()` deltas, not by counting ticks, so it stays correct when
the WebView throttles timers with the panel closed.

**Card:** whichever is interesting — a running countdown, a paused countdown, the stopwatch, a
quiet `finished 4m ago` trace for 30 minutes after an alarm, or `tap to open`.

**Panel:** a segmented Stopwatch / Timer switch, and one pinned control cluster under the
header so the readout and buttons never scroll away.

- *Stopwatch:* Start / Stop, Lap (up to 30), Reset. Each lap shows the total and the split;
  splits are differences of the **displayed** totals, so the two columns always reconcile.
- *Timer:* countdown display with a progress bar, Start / Pause, +1 min, −1 min, Reset, and
  eight presets (1–60 min) where the loaded one is highlighted. Remaining time is rounded up,
  so a one-minute countdown reads 01:00 → 00:59 → … → 00:01 → alarm.

**When a countdown ends** a full-screen overlay appears (`Timer finished`, pulsing) with a
three-chirp WebAudio beep. One `AudioContext` is created the first time an alarm actually
sounds and reused for the rest of the page's life, so a wall panel that has rung a hundred
times still holds one audio client instead of a hundred, and a run that never rings never opens
audio at all. Dismiss by pressing the button *or* tapping anywhere on the overlay, and it clears
itself after 60 s unattended — see [Idle unwind](#idle-unwind).

Expect 4–5 lines of `AS.AudioService: Uncaught exception` in logcat per ring. Measured across
three consecutive alarms with the audio session id unchanged, so it is not context creation:
this ROM dumps `AudioService` and throws inside `system_server` while doing it. It is not the
app's exception, and the chirp plays. Reusing the context does **not** suppress it — an earlier
note here claimed it did.

### 3. Weather now — real Open-Meteo, no API key

One fetch feeds this card, the hourly strip and the daily row. The last good payload is cached
in `localStorage`, so a failed refresh shows the previous reading with a `stale` badge and the
age of it, never a blank card.

**Card:** condition glyph, temperature, description, feels-like / wind / humidity, and a meta
line with the configured location name, today's high and low, and the current UV index.

**Panel:** *Air* (humidity, dew point, pressure, cloud cover, visibility, UV index with its WHO
band), *Wind* (speed, gusts, compass direction with degrees, an arrow pointing where it is
blowing), *Sun* (sunrise, sunset, daylight duration) and *Rain* (right now, chance next hour,
today's maximum chance, today's total). Location, freshness and the Open-Meteo attribution are
in the subtitle rather than in a section at the bottom of a screen you had to scroll to reach:
the panel used to measure ~111vh against an ~81vh scrollport, so two of its five sections were
always below the fold. It now fits in one screenful — row hero, three-column stat grids, no
source section — with no data dropped except *Now: Daytime / Night*, which restated the sun or
moon glyph two lines above it.

### 4. Hourly forecast — real Open-Meteo

**Card:** a horizontally scrollable, snapping 24-hour strip starting at the current hour. The
current hour is badged `NOW`. Three behaviours keep it honest: it re-anchors to `NOW` after
45 s of no interaction (a panel swiped forward on Tuesday used to still show that window on
Thursday), it relabels immediately on a 12/24-hour change, and it redraws when the hour rolls
over instead of waiting up to 15 minutes for the next fetch.

**Panel:** a readout for the selected hour (rain chance, precipitation, humidity, dew point,
wind with compass, UV, cloud cover, visibility) above all 24 hours as a list with inline
temperature bars. Tapping a row re-selects without scrolling the list out from under you; the
selected row is scrolled into view when the panel opens.

### 5. Daily forecast — real Open-Meteo

**Card:** all seven days the API returns, each tappable.

**Panel:** day chips across the top, a hi/lo readout, a *Day* grid (feels-like high and low,
rain chance, precipitation total, maximum wind with the dominant direction, maximum gusts,
maximum UV, daylight, sunrise, sunset) and an hour-by-hour temperature bar chart for that day
built from the same hourly array.

> Open-Meteo sometimes returns `wind_gusts_10m_max` **below** `wind_speed_10m_max`. The panel
> is faithful to its source rather than quietly correcting it.

### 6. Home Assistant — a real simulator by default

No token is bundled (the repo is public), so the default is a genuine simulator badged **DEMO**,
with nine entities: three temperatures, humidity, CO₂, household power, a lamp, an office fan
and a front door.

- Numeric entities are mean-reverting random walks around a time-of-day sinusoid. Each has its
  own time constant — a room takes about a quarter of an hour to react, household power follows
  the load in seconds — and its own noise size, so a living room jitters by about ±0.1 °F
  instead of ±1 °F.
- Switch state feeds back into the model: the lamp warms the living room and adds watts, the
  fan cools the bedroom and adds more, an open door drops CO₂ and lifts humidity.
- Two hours of history exist the instant the app boots, and it is a synthetic *past*, not a copy
  of the present: switches are walked backwards in randomised dwell runs and the numerics are
  integrated forward along that same timeline, seeded deterministically per entity id.
- The simulation steps every **5 s**, and that number is a tuning constant, not a preference:
  each entity's random kick is sized against it (it scales as `sqrt(dt)` like any diffusion, so
  the 30 s seed step and the 5 s forward step yield the same statistics, so the trace has no
  seam where the synthetic past hands over to the running present).
  `homeAssistant.refreshSeconds` is a *network poll* interval and deliberately does not touch
  it — moving the simulation step would silently re-tune the noise.

**Card:** five tiles across, two rows. Toggle-type entities switch on tap (with a toast);
read-only entities open the panel. On/off entities draw a filled glyph when energised and a
hollow one when not — legible at 2–4 m in a way a colour shift is not.

**Panel:** entity chips, a one-line note (the simulator, or the reason a live feed has stopped
answering), a hero glyph and value, a Turn on / Turn off button for switches, *Last 2 hours* as
a sparkline with min/max/mean/samples (or time-weighted duty cycle and last change for on/off
entities), and the entity's id, domain, source and update age.

**Freshness (live mode).** A long-lived token expires, an HA box reboots, a LAN moves — and
every one of those used to leave the last good numbers on the wall with nothing to say they
were hours old. An overnight token expiry produced a dashboard full of plausible, wrong
readings that looked exactly like a working one. So the live path now tracks per-entity
freshness, and the card badge beside HOME has three states rather than two: **demo**, **live**,
**stale**. On a failure the reading is *kept* — blanking it destroys the last thing that was
true — and marked instead: the badge flips to `stale`, the failing tiles drop their value to
label brightness with a warm border, the status line says what happened (a 401 is named as a
refused token, because that is the failure that happens silently months after setup), and the
panel dates the last answer. A failed `turn_on` / `turn_off` marks the entity the same way,
since the tile flipped optimistically and is now showing something untrue. The next successful
poll clears all of it. Covered by `test/ha-stale.test.js`.

**Switching to a real Home Assistant:** set `homeAssistant.enabled`, `baseUrl`, `token` and
`entities` in `assets/config.js`, then rebuild. With all three present the widget uses the REST
API instead — `GET /api/states/<entity_id>` per entity every `refreshSeconds` (default 60,
floored at 5 so a mistyped `0` cannot become a request loop), and
`POST /api/services/<domain>/turn_on|turn_off` for toggles — the badge flips to **live**, and
the panel subtitle says how long ago the readings last arrived. Failures badge the card `stale`
and mark the affected tiles (see *Freshness* above) rather than silently passing off old
numbers as current. Create the token in Home Assistant under
**Profile → Security → Long-Lived Access Tokens**; entity ids are under
**Developer Tools → States**.

> A long-lived token grants full API access to your Home Assistant and would sit in plain text
> inside the APK. Keep the committed `config.js` on placeholders — this repo is public and a
> pre-commit secret scanner runs.

### 7. Device — real values through the JS bridge

Refreshes every 5 s from a single bridge call.

**Card:** battery percentage with a charging mark, and free storage / uptime / network
transport.

**Panel:** *Battery* (level, charging, status, plugged, temperature in the chosen unit, voltage,
health, technology), *Storage* and *Memory* (each with a fill bar and free/used/total/percent),
*Network* (transport, whether the link validated, metered, interface, reported link speeds), and
*Uptime & device* (uptime including deep sleep, awake time excluding it, model, manufacturer,
Android version and API level, screen size, density, brightness).

If the bridge is missing — running the page in a plain browser, or an older APK — the panel says
so and everything else keeps working.

### 8. Settings — real, persisted, applied immediately

- **Units:** °F / mph / inHg or °C / km/h / hPa. Changing this re-requests the forecast in the
  new units rather than converting locally, so every derived field stays consistent.
- **Clock:** 12- or 24-hour, seconds shown or hidden. Applies to the clock, the hourly labels,
  the status line and every formatted time in the panels.
- **Burn-in protection:** drift on or off, with the current interval and shift printed.
- **Widgets:** a switch per widget. Hidden cards keep their DOM and refresh loops, so
  re-enabling one is instant. The column reflows (see [Layout budget](#layout-budget)).
- **Maintenance:** a two-step *Reset to defaults* — the first tap arms it, the second confirms,
  and it disarms itself after 5 s or as soon as any other control is touched. Below it, a
  diagnostics line: bridge attached, Home Assistant mode, viewport and device pixel ratio.

---

## Interaction model

### One delegated listener

There is a single set of pointer handlers on `document`, and three data attributes drive
everything:

| Attribute | Meaning |
|---|---|
| `data-open="name"` (+ optional `data-arg`) | open that panel, passing the argument to `onOpen` |
| `data-close` | pop the top panel |
| `data-act="verb"` (+ `data-arg`, `data-ns`) | dispatch to the plugin that owns the panel, or to `data-ns` |

`data-close` beats `data-act` beats `data-open`, resolved with `closest()` from the touched
node. Nothing in the app carries its own click listener: a control that is not reachable through
this path silently behaves differently from every other control, so **boot logs a warning
naming any `button` or `.tappable` in the static DOM that no `data-*` attribute resolves** —
the expected count is zero. (This guard exists because the alarm's Dismiss button was on a
hand-rolled listener and was, for exactly that reason, the one control in the app that ignored a
press-and-hold.)

### Activation is on the pointer, not on `click`

A deliberate 600–700 ms press — how people actually use a panel on a wall — makes Chrome treat
the gesture as a long press and swallow the `click` entirely. So activation happens on
`pointerup`, or on `pointercancel` once the gesture has been claimed:

- `pointerup` tolerates 14 CSS px of movement (finger wobble on release).
- `pointercancel` tolerates only 6 px, which separates "long press, never moved" from "a
  scroller took over".
- A `scroll` event, or `touchmove` past the slop, cancels activation outright — so dragging the
  hourly strip or a panel body never fires a tap.
- The release must still be over the element the press started on.
- `click` remains wired as a fallback for a mouse or hardware keyboard, and is ignored for
  700 ms after a pointer activation so nothing runs twice.

Press feedback is applied from JS (`.tappable.is-press`) because CSS `:active` is unreliable
inside a WebView scroll container. Touch targets are all ≥ 88 device px in the 1600×2560 frame;
the smallest measured is 93 px.

### Panels

Panel shells are authored in `index.html`, one per widget, and their bodies are filled by the
owning plugin. Opening pushes onto a stack, so a panel could open another and still return to
the right place. Details that matter in use:

- Fade and slide over 200 ms, with a forced reflow between "mounted" and "open" so the
  transition actually runs.
- `pointer-events` is tied to the *open* class, not the *mounted* one, so a closing panel hands
  touch back to the dashboard immediately instead of eating taps for the 240 ms of its fade-out.
  Verified: closing a panel and tapping a card 81 ms later opens that card.
- **The close shadow.** The close ✕ sits on top of something tappable — it covers the topbar
  gear — so once touch is handed back immediately, the second tap of a human double-tap on it
  landed on whatever was underneath and re-opened a panel (the ✕ silently opened Settings).
  This used to be true of a second close control as well, the full-width `← Dashboard` bar over
  the DEVICE / TIMER / SETTINGS tile row; that bar is gone (it cost 113 CSS px on every panel
  for an action already in the header), so the ✕ is the only exit and the only shadow. A close tap
  therefore leaves a 600 ms *shadow* at the point it landed, and a `data-open` element is refused
  only while its current rect still contains that point. Note what this deliberately is **not**:
  a post-close cooldown, which would put back exactly the dead window the line above removed. A
  different tile, a different card, or the same tile after 600 ms all open normally. The live rect
  is read at the second tap rather than the coordinates compared, because burn-in drift may have
  moved the layer in between and the question is where that element is *now*.
- The body's scroll offset is reset when a panel opens. Panels are reused, and reopening
  Settings still scrolled to MAINTENANCE put the widget switches where the reader expected the
  units and clock rows.
- Panels that repaint on a timer (device, sensors) and panels rebuilt by a tap (settings, timer,
  hourly, daily) go through a scroll-preserving repaint, so a value updating or a lap being
  taken never yanks the reader to the top.
- Two close affordances on every panel: the ✕ in the header and a full-width bar at the bottom.
- Android's back button closes the top panel and nothing else — see
  [Wall-panel posture](#wall-panel-posture).

### Idle unwind

A wall panel is walked away from, not closed. Anything parked on top of the dashboard therefore
has to take itself back down, or the panel stops being a dashboard. Every such layer registers
with one idle timer and its own patience:

| Layer | Patience | On expiry |
|---|---|---|
| Panel stack | 90 s | unwinds to the dashboard, with a toast |
| Countdown alarm overlay | 60 s | clears the overlay; the TIMER tile keeps a quiet `finished Nm ago` note for 30 min |

Any `pointerdown` anywhere restarts every open layer's countdown, so a panel being read is never
yanked away, and a nudge is never taken from under a finger. The alarm gets less patience than a
panel because it covers everything and captures every tap; auto-clearing it is what keeps one
laundry timer from making the whole wall panel unusable until a human walks over.

### Toast placement

A contract, not a style choice. It has been moved onto content twice and put back twice, so it is
written down here rather than left to the stylesheet to defend. **A toast never covers a control
or a datum. It takes over the one line of throwaway text in whichever context it appears, and
that line gets out of its way.**

Both screens are full layouts with no spare band, so a floating toast is always over *something*
and the only real question is what. Two earlier positions both chose content: `5.5vh` printed
through the panel subtitle, and `11.5vh` cleared the header only to land on the first content row
— in the Home Assistant panel that is the entity chip row the user had just tapped, and in
Settings it is the `WIDGETS` label.

| Context | Toast sits at | Band it occupies | Line it takes over |
|---|---|---|---|
| Dashboard | `.toast { top: 0.9vh }` | 0.9–5.5 vh, inside the 4.2 vh topbar (the clock starts at ~5.95 vh) | `#status` — "Updated 3:41 PM" |
| Panel open | `body.panel-open .toast { top: 6vh }` | 6.0–10.6 vh, the subtitle line plus the body's top padding (content starts at ~11.9 vh) | that panel's `.panel-sub` |

Both lines are re-rendered from state, so nothing is lost by hiding one for the 1.8 s the toast
is up. `max-width: 76vw` keeps a long message clear of the gear button and the panel's ✕.

The hiding is the other half of the contract, and its timing is not incidental: `body.toasting`
sets the underlying line to `opacity: 0` with **`transition: none`** so it vanishes in the same
frame the toast starts fading in, and it only fades back afterwards (`transition: opacity .25s
ease .15s`). If it faded out over the same 200 ms the toast fades in, every frame in between
would show one legible through the other — which is the exact collision this position exists to
avoid.

If you are tempted to move the toast: the constraint is the band, not the number. Any new
position must land on a line that is (a) regenerated from state, (b) not a control, and (c)
hideable with no transition.

### Layout budget

The home column is a fixed height budget: 100 vh has to hold eleven widgets with nothing clipped — the six small tiles share
two half-width rows on one line in portrait, and landscape is a real two-column grid
(clock and tiles left, the weather trio right, Home Assistant across the base).
Every card carries `flex-grow`, so spare height is handed back to the cards as internal
breathing room rather than collecting in the gaps.

That needs a ceiling. With three widgets hidden, uncapped growth made the weather card ~800
device px tall with ~250 px of dead black above its content and as much below, which at 2–4 m
reads as a card that failed to load. So each card may grow to at most **1.3× its own intrinsic
height**, measured on the device, and the remainder is left over once below the last card. At
one or two hidden the cap never binds and the column looks exactly as it did.

The measurement is logged, and it is the honest way to check the column still fits:

```
[inky] layout: home overflow=0 slack=34px cards=6
```

`overflow` must stay 0 — anything else means a card grew and the bottom tile row is being
clipped. `slack` is the headroom a downward burn-in nudge eats into. The line is printed 12 s
after boot (once the payload has landed and the cards are at full size) and again 1.5 s after
any settings change, so all four 12/24-hour × seconds combinations can be checked from logcat.
An overflow above zero is logged as a warning.

If every widget is switched off, an empty state takes over and points back at Settings — a black
rectangle is indistinguishable from a crashed app.

---

## The design system

Eight panels only read as one app if they are drawn from one vocabulary. All of it lives in
`assets/style.css` (the tokens) and `assets/wx-ui.js` (the builders that use them); no widget
file authors a font size, a duration or a piece of markup structure of its own, and
`test/design-system.test.js` fails if one starts to.

**Type ramp.** Ten steps, `--fs-caption` … `--fs-display-xl`, in `vh` because this panel has
exactly one viewport and the home column is a height budget. A ~1.16 ratio through the seven
text tiers, then three larger jumps for the tiers that are read as shapes rather than as text.
Adding a size means picking the nearest step; there is no eleventh.

| token | vh | used for |
|---|---|---|
| `--fs-caption` | 1.4 | units, badges, tile sub-lines, chart ticks |
| `--fs-label` | 1.6 | letter-spaced small caps: field and card labels |
| `--fs-note` | 1.85 | section headings, panel subtitles, secondary prose |
| `--fs-body` | 2.15 | list rows, chips, the toast |
| `--fs-body-lg` | 2.45 | things a finger aims at: buttons, switch rows |
| `--fs-title-sm` | 2.9 | stat values, tile glyphs, world-clock times |
| `--fs-title` | 3.4 | panel titles, tile headline numbers |
| `--fs-hero` | 5.2 | the home weather hero, the alarm title |
| `--fs-display` | 7.6 | the clock, and a panel's one big readout |
| `--fs-display-xl` | 10.5 | the stopwatch — the whole point of its own screen |

Before this there were **30 distinct font sizes** across the eight panels, five of them inside
0.2vh of each other (1.5 / 1.6 / 1.65 / 1.7 / 1.75), which is a difference of 5 device px: four
"different" sizes that are really one, and no hierarchy anywhere. Landscape restates the same
ten tokens at ~1.75x rather than overriding nine elements at nine different multipliers.

**One idiom per concept.** A *segmented control* is reserved for a genuine either/or between
two named values — °F/°C, 12-hour/24-hour. Anything that is merely on or off is a *switch row*
(`WP.ui.switchRow`), full width, `role="switch"`, knob animated. Settings used to carry both
idioms 20 cm apart on one screen: `Hide seconds | Show seconds` and `Drift on | Drift off` as
paired buttons, then the widget list as switches — all four of them the same boolean.

**Label recipe.** Every letter-spaced small-caps label comes off one rule, so `UNITS` in
Settings, `AIR` in Conditions, `BATTERY` in Device and `NOW` on the home card are the same
object. Exactly two tiers, and the difference between them *is* the hierarchy: a section
heading (`.psec-t`) is one ramp step up and one shade brighter than the field labels under it.
They were 1.7vh and 1.6vh of the same colour, which is not a hierarchy, it is a rounding error.

**Hero block.** Every panel opens with the same object — glyph, the one number the screen is
about, a line of context — laid out as a row (`WP.ui.hero`). The stacked version spent ~8vh on
a line carrying nothing the words underneath did not, and it is the home Now card's layout, so
a panel reads as a magnification of the card that opened it.

**Vertical strategy.** Each panel has a declared one rather than whatever its content happened
to measure. Timer: the readout is the largest type in the app and the lap list takes the whole
remainder, with its empty-state line centred in that space (it used to be ~55% dead black below
one sentence, with a readout optically *smaller* than the home clock). Conditions: row hero,
three-column stat grids and no source section, which took it from ~111vh to one screenful.

**Motion.** Four durations and one easing, and nothing animates on a number that is not one of
them: `--dur-press` 0.12s (finger feedback), `--dur-ui` 0.2s (panels, switch knobs, badges),
`--dur-fill` 0.3s (a bar sweeping to a new width), `--dur-drift` 4s (the burn-in nudge, slow
enough never to be seen moving). Two deliberate exceptions, both documented where they occur:
the line beneath the toast vanishes instantly so the two are never legible through each other,
and the alarm's pulse never fades below 0.6 so it stays readable in any single frame.

**Accessibility.** Generated controls carry their own names and states: switch rows and HA
toggle tiles are `role="switch"` with live `aria-checked`, single-choice button rows are
`role="radiogroup"` / `role="radio"`, icon-only buttons and glyph-carrying chips get an
`aria-label` that reads as one sentence, and every decorative glyph is `aria-hidden` so it is
not spoken as a symbol beside the words that already say it. None of it changed a touch target:
the smallest control in the app is the `Details ›` link at ~95 device px, against a floor of 88.

## Settings and where they persist

`localStorage` is the source of truth, but a wall panel gets force-stopped and wiped more than a
phone browser does, so every write is mirrored into Android `SharedPreferences` through the
bridge and used as a fallback when `localStorage` comes back empty.

| Key | Holds |
|---|---|
| `inky.settings.v2` | units, clock hours, seconds, burn-in flag, per-widget visibility |
| `inky.wx.v2` | last good Open-Meteo payload, its timestamp and the units it was fetched in |
| `inky.ha.v1` | demo-mode switch states, so the lamp is still on after a restart |

SharedPreferences file: `inky_panel` (app-private). One setter (`WP.settings.set`) does write,
persist and notify, so "saved" and "applied immediately" can never drift apart.

`assets/config.js` holds the build-time configuration and is **not** a user setting:
`location` (`name`, `latitude`, `longitude`), `units`, `clockHours`, `weatherRefreshMinutes`,
`plugins` (a legacy starting hint — the Settings panel is the real control),
`burnInProtection` (`enabled`, `intervalSeconds`, `maxShiftPx`) and `homeAssistant`
(`enabled`, `baseUrl`, `token`, `refreshSeconds` — the live REST poll interval in seconds,
default 60, floored at 5; it does not affect the demo simulator's 5 s step — and `entities`).
Set both coordinates to `null` to
get a "set your location" notice instead of somebody else's weather. Keep the committed copy on
placeholders.

---

## The JS bridge

`MainActivity` attaches a small interface as `window.Android` before the page loads, and the
page wraps every call so it still runs in a plain browser with the bridge simply absent
(`WP.bridge.present()` / `WP.bridge.json()`). Bridge methods run on the WebView's private
`JavaBridge` thread, never the UI thread, and return JSON so one call carries a whole snapshot
instead of a dozen round-trips.

| Method | Returns |
|---|---|
| `deviceInfo()` | JSON: `battery`, `storage`, `memory`, `network`, `device`, `uptimeMs`, `awakeMs`, `brightness`, `now` |
| `getPref(key)` | the mirrored preference string, or `null` |
| `setPref(key, value)` | writes it to `SharedPreferences` |

Everything is read-only apart from that preference pair. Why each field needs no permission:

| Field | Source | Permission |
|---|---|---|
| battery level, status, plugged, health, technology, voltage, temperature | sticky `ACTION_BATTERY_CHANGED` broadcast, read with `registerReceiver(null, filter)` | none |
| storage total / free / block size, app-private free | `StatFs` on the data directory and on `getFilesDir()` | none — our own partition |
| memory total / available / low-memory / threshold | `ActivityManager.MemoryInfo` | none |
| uptime, awake time | `SystemClock.elapsedRealtime()` / `uptimeMillis()` | none |
| model, manufacturer, Android release, SDK level, screen size, density | `Build.*`, `DisplayMetrics` | none |
| brightness | `Settings.System.SCREEN_BRIGHTNESS`, read only | none — *writing* would need the `WRITE_SETTINGS` special permission |
| network transport, validated, metered, interface, link speeds | `ConnectivityManager` / `NetworkCapabilities` | `ACCESS_NETWORK_STATE`, already declared for the weather fetch |

The network snapshot deliberately does **not** read SSID, BSSID or signal level, all of which
would drag in a location permission on Android 10+ for a wall panel that has no use for one.

Manifest permissions, in full: `INTERNET` (the Open-Meteo fetch), `ACCESS_NETWORK_STATE` (the
row above), `RECEIVE_BOOT_COMPLETED` (relaunch after a power cut). Nothing else.

The page also exports `WP.onAndroidBack()`, which `MainActivity.onBackPressed()` calls.

### Who is allowed to hold the bridge

`addJavascriptInterface` attaches `window.Android` to the **WebView**, not to a page. Any
document that manages to load in it inherits the bridge — which is why two things are locked
down around it.

**Navigation allowlist.** `shouldOverrideUrlLoading` permits `file:///android_asset/` and
refuses everything else, returning `true` (handled, do not load) without firing an Intent, so
a link or a redirect can neither hand a remote origin the bridge nor bounce the wall panel
into a browser. The refusal is logged as scheme + host only:

```
W InkyOLED: blocked navigation to https://example.com/…
```

A blocked URL is by definition something the app did not author, and logcat is readable by
anything holding `READ_LOGS`, so the path and query — where a token or session id would sit —
are never written out. `window.open` / `target=_blank` are refused separately by
`WebChromeClient`'s default `onCreateWindow`. `setAllowFileAccess(false)` and
`setAllowContentAccess(false)` remove local-file and `content://` reads from the page;
`file:///android_asset` and `file:///android_res` are explicitly exempt from that setting, so
the dashboard itself is unaffected.

**The app never asks for the debug socket.** `WebView.setWebContentsDebuggingEnabled` opens a
devtools socket that any local app can attach to, with full script execution — and therefore
full use of `window.Android`. It is gated on `ApplicationInfo.FLAG_DEBUGGABLE`, which only
`build.ps1 -Debuggable` sets (via aapt2's `--debug-mode`). Boot logs which one you are
running:

```
I InkyOLED: webview debugging off
```

To debug the page, rebuild with `-Debuggable` and attach `chrome://inspect`. CI fails the
build if a default-built APK ever comes out debuggable.

**On this tablet the socket is open anyway. Read the next section before trusting that log
line.**

### Residual risk: the devtools socket

This was previously written up here as "the debug socket is off in the shipping build", on
the strength of the `webview debugging off` log line. That claim was wrong on this device, and
the log line is not evidence for it — it records what the app *asked for*, not what the
platform did.

**What is actually true.** With the shipping, non-debuggable APK installed and running:

```
$ adb shell getprop ro.build.type        →  userdebug
$ adb shell getprop ro.debuggable        →  0
$ adb shell dumpsys package com.justin.inkyoled | grep -i flags   →  no DEBUGGABLE
$ adb logcat -d | grep InkyOLED          →  I InkyOLED: webview debugging off
$ adb shell cat /proc/net/unix | grep devtools
                                         →  @webview_devtools_remote_<pid>
$ adb shell pidof com.justin.inkyoled    →  <pid>   (the same one)
```

The socket belongs to this app's process. Forwarding it and speaking CDP to it yields the
page (`file:///android_asset/index.html`), `Runtime.evaluate` on it, and
`typeof window.Android.deviceInfo === "function"` → `true`.

**Cause.** Chromium's WebView force-enables its devtools server whenever `ro.build.type` is
`userdebug` or `eng`, regardless of the value passed to `setWebContentsDebuggingEnabled`. This
tablet runs a Magisk-patched `userdebug` ROM. **This is a property of the ROM, not a defect in
the app** — the gate in `MainActivity` is correct, CI enforces it, and on a retail `user`
build the same APK would have no socket. (That last part is *unverified here*: there is no
retail-ROM device to test it on.)

**Blast radius.** Anything that can reach the abstract socket — i.e. any app on the tablet, or
anyone with adb — gets:

- script execution in the dashboard page, and
- the `window.Android` bridge, which exposes exactly three methods: `deviceInfo()` (battery,
  storage, memory, network, uptime, model), `getPref(key)` and `setPref(key, value)` against
  this app's own `SharedPreferences`.

It does **not** expose a shell, the filesystem, other apps' data, or any credential. The
`config.js` baked into the APK is readable from the page — so if you ever enable Home
Assistant, the long-lived token is readable through this socket. That, not the telemetry, is
the reason this matters.

**What would close it**, in descending order of realism:

1. Flash a retail `user` ROM. This is the only thing that shuts the socket.
2. Do not put a Home Assistant token on a `userdebug` device — treat the token, not the
   socket, as the thing being protected.
3. Keep the bridge as small as it is. Every method added to `@JavascriptInterface` is added to
   the list above.

Accepting the risk is reasonable for a wall panel on a private LAN with no token in it. It is
recorded here so the decision is a decision, and not an artefact of a log line that was read
as a result.

---

## Home Assistant live path verification

The live Home Assistant path is 495 lines that, until this was done, had **never executed** —
every run on this panel had been the demo simulator. It has now been exercised on the device
against a local mock HA that serves the two endpoints the app uses (`GET /api/states/<id>`,
`POST /api/services/<domain>/turn_on|turn_off`).

**Setup, and why there is no LAN address in any of this.** The mock listened on the *host's*
`127.0.0.1:8123` and the tablet reached it through `adb reverse tcp:8123 tcp:8123`, so the
configured `baseUrl` was `http://127.0.0.1:8123` — the device's own loopback. No LAN IP existed
to leak. The temporary `config.js` was restored byte-for-byte afterwards (checksum verified),
`git status` is clean for it, and its `--skip-worktree` bit is intact.

### The finding: it does not work against a stock Home Assistant

**This is the reason the exercise was worth doing.** On the first run, with a correct
`baseUrl` and a valid token, *every single request was blocked before it left the device*:

```
console[ERROR] Access to fetch at 'http://127.0.0.1:8123/api/states/sensor.…'
  from origin 'null' has been blocked by CORS policy: Response to preflight request
  doesn't pass access control check: No 'Access-Control-Allow-Origin' header…
```

The page is a `file://` document, so its origin is `null`; the `Authorization` header makes
each call a non-simple cross-origin request; Chromium sends a preflight `OPTIONS` first. That
is not a property of the mock — a stock Home Assistant answers CORS preflights only for origins
listed in `http.cors_allowed_origins`, and `"null"` is not one of them by default. **Anybody
enabling this feature on day one got six dashes and "check baseUrl/token", with a baseUrl and
a token that are both correct.**

**Resolved since: live traffic rides the shell.** `wx-sensors.haFetch()` prefers
`WP.bridgeFetch` — MainActivity's native fetch — whenever the app shell is present, and the
page's CORS rules simply do not apply to it. The finding above is kept because it explains
WHY the bridge fetch exists, and because the plain-`fetch` fallback (browser development)
still behaves exactly as described.

With the mock answering the preflight (`Access-Control-Allow-Headers: authorization,
content-type`), everything below worked on the first poll.

### What was verified, on device

| | Result |
|---|---|
| Mode detection | Badge flipped `DEMO` → `LIVE`; `initLive` built tiles from `config.entities` |
| Tiles populate | `72.5 °F` and `41.0 %` read from `GET /api/states/…` |
| Units from HA | Neither entity declared a `unit` in config; both took it from `attributes.unit_of_measurement` |
| Auth on every read | 66 GETs, all carrying `Authorization: Bearer …` — asserted from the server's own log |
| Toggle → service call | One tap produced exactly `POST /api/services/switch/turn_on`, `Content-Type: application/json`, body `{"entity_id":"switch.mock_fan"}`, bearer token present. Domain was derived correctly from the entity id |
| Toggle round trip | Server state became `on`; subsequent polls read `on` back, so the optimistic flip and the confirmed state agreed |
| `unavailable` state | Tile shows `--`, and is **not** counted as an error — correct: the entity answered |
| Malformed JSON body | Caught; tile `--`; counted as an entity error; no uncaught exception |
| HTTP 404 (entity gone) | Caught; tile `--`; counted as an entity error |
| HTTP 401 (bad token) | All six entities error; status line escalates to `6 entity error(s) — check baseUrl/token` |
| Host unreachable | Fresh start with nothing listening: all tiles `--`, status warns, **zero console errors** |
| Blast radius | In every failure mode the weather, clock, timer and device cards were untouched, and `overflow=0 slack=34px cards=6` still held |

### Still not verifiable without a real instance

- Whether a real Home Assistant's payloads differ in shape from the mock's (extra attributes,
  `state` types, `context`) in a way that matters. The mock was written from HA's documented
  response shape, not from a capture of one.
- Long-run behaviour: token expiry, HA restarting under the poll, `502` from a reverse proxy.
- HTTPS with a self-signed certificate, which is how many people expose HA — the WebView's
  certificate handling is untested here.
- Whether adding `"null"` to `cors_allowed_origins` is sufficient on every HA version, or
  whether some releases refuse the `null` origin regardless.
- Rate behaviour against a real box at the configured `refreshSeconds` over days.

### One honest weakness observed

Under a 401, the tiles kept displaying their last successful values with no visual marker;
only the status line said anything was wrong. Weather solves the same problem with an explicit
"stale" badge. The HA tiles do not, so a token that expires overnight leaves plausible-looking
numbers on the wall.

---

## Burn-in strategy

The panel is AMOLED, and on a wall panel "nothing moved for hours" is the normal case — nobody
is watching it at 3 a.m. Three things address it.

**A dark, low-coverage design.** Black background (those pixels are genuinely off), thin type,
no large bright fills. This is the main defence and the reason the layout looks the way it does.

**Drift.** Every layer that can be on screen for hours takes the *same* transform on the same
slow cycle — the home wrapper, the panel layer and the alarm overlay — nudging up to
`maxShiftPx` (12 CSS px by default) every `intervalSeconds` (120 s), eased over 4 s so the step
is invisible in use. Moving every layer by an identical offset keeps them registered with each
other, so there is no visible seam. Two rules: a nudge is **skipped while a pointer is down**,
so a control never slides out from under a finger, and drift is **never paused** for an open
panel — a detail panel left up overnight used to be eight hours of perfectly static pixels with
protection silently disabled.

Each cycle picks a **fresh uniform random offset** in ±`maxShiftPx` on both axes independently —
it is not a fixed path or a repeating pattern, so consecutive cycles move by an arbitrary amount
up to 2·`maxShiftPx` (54 device px per axis at the 12 CSS px default and this panel's 2.25x
ratio) and the long-run average position is the centre. Any single measured hop is therefore one
random draw and says nothing about the next: two observed cycles moved 22/31 and 41/12 device
px. What matters for verification is that consecutive screenshots differ and stay inside the
bound, not that they differ by any particular amount.

**The idle unwind.** Drift alone protects the pixels; it does not stop a panel from covering the
dashboard all night. The 90 s panel timeout and the 60 s alarm timeout are the other half — see
[Idle unwind](#idle-unwind).

Drift can be switched off from the Settings panel or defaulted off in `config.js`.

---

## Wall-panel posture

These are deliberate choices, not oversights.

**Screen stays on.** `FLAG_KEEP_SCREEN_ON` while the activity is showing. No global settings
changes; normal sleep behaviour returns as soon as you switch to another app.

**Shown over the lock screen, with the keyguard still armed.** `FLAG_KEEP_SCREEN_ON` alone is
not enough: one press of the power button turns the screen off, and when it comes back a secure
keyguard is in front of the dashboard indefinitely — on a device screwed to a wall with no
keyboard, that means the panel is gone until a human walks over and types a PIN. So
`onCreate` calls `setShowWhenLocked(true)` and `setTurnScreenOn(true)` (API 27+; `minSdk` is 29
here), which draw this activity above the keyguard and let it wake the display.

It deliberately does **not** call `KeyguardManager.requestDismissKeyguard()` or anything else
that would unlock the device. The keyguard stays armed and still gates everything outside this
activity — verified with `dumpsys window policy` (`showing=true`, `secure=true`) and
`dumpsys trust` (`deviceLocked=1`, `trustState=UNTRUSTED`) while the dashboard was on screen.

The trade-off is explicit: whatever the dashboard displays — weather, device stats, the Home
Assistant tiles — is readable without unlocking the tablet. That is correct for a wall panel and
worth knowing before mounting one somewhere public.

**Back closes a panel, never the app.** `onBackPressed` evaluates `WP.onAndroidBack()` in the
page, which pops the top panel and reports whether it consumed the press. It never calls
`super`, so the activity cannot finish. Nothing in the UI requires the back button: every panel
has two visible close affordances.

**Fullscreen immersive.** No status bar, no navigation bar, re-applied on focus change because
Android restores them.

**Layout pinned to the real viewport.** `setTextZoom(100)` and zoom disabled, because the layout
is expressed in `vh`/`vw` against a known viewport and system font scaling would silently break
it. The manifest asks for landscape, but Samsung's large-screen policy ignores fixed orientation
requests on this device, so the real render is **portrait**: 711 × 1138 CSS px at device pixel
ratio 2.25, i.e. 1600 × 2560 physical. The CSS is tuned for that, with a two-column landscape
fallback so a rotation never looks broken.

**Assets stay flat.** No subdirectories under `assets/`. `aapt2` on Windows writes subdirectory
separators as backslashes, which `file:///android_asset/` cannot resolve — the symptom is a
silent black screen.

---

## How to test

Two layers, and they are not interchangeable. The suite catches the class of bug that has
actually bitten this project — pure functions and small state machines silently inverted by a
fix — in about a second and a half. The device catches everything the suite structurally
cannot: real layout, real glyph rendering, real touch, real Open-Meteo, the real bridge.

### Off device

```bash
cd inky-oled
npm test                              # or: node --test "test/**/*.test.js"
```

No `npm install` — node's built-in test runner, no dependencies (see
[README](README.md#tests)). The suite loads the real `index.html`, `app.js` and every
`wx-*.js` — in the order `index.html` itself lists them, read out of the page rather than
restated in the harness — into a DOM stub with a virtual clock, and drives them with real
pointer events, so it exercises the same delegation path a finger does.

Every historical regression named in this document has a test that fails when the bug is put
back. If you are about to "simplify" something in a `wx-*.js`, run the suite first and after.

### On device

Two transports are usually attached, so pass the serial explicitly (`adb devices` to find it).

```bash
# build (SDK build-tools only: aapt2 -> javac -> d8 -> zipalign -> apksigner)
powershell -File build.ps1

# install and launch
adb -s <serial> install -r inkyoled.apk
adb -s <serial> shell monkey -p com.justin.inkyoled -c android.intent.category.LAUNCHER 1

# what the page is saying
adb -s <serial> logcat -c
adb -s <serial> logcat -d | grep -iE "chromium|console|InkyOLED"

# screenshot: the frame is 1600x2560 and `input tap` uses the same coordinate space,
# so tap targets can be read straight off the image
adb -s <serial> exec-out screencap -p > shot.png

# touch
adb -s <serial> shell input tap X Y
adb -s <serial> shell input swipe X1 Y1 X2 Y2 300

# a long press is a zero-distance swipe — this is how to check that a control
# still activates when Chrome swallows the click
adb -s <serial> shell input swipe X Y X Y 700

# persistence
adb -s <serial> shell am force-stop com.justin.inkyoled
```

Four log lines are worth watching for:

```
InkyOLED: webview debugging off
[inky] booted; bridge=true viewport=711x1138 dpr=2.25
[inky] layout: home overflow=0 slack=34px cards=6
```

plus a warning listing any tappable that is not on the pointer delegation — which should never
appear. `overflow` above 0 means the column no longer fits. `webview debugging off` says the
shipping build did not *ask* for the devtools socket; a build made with `-Debuggable` says so
instead. It does **not** mean the socket is closed — on this `userdebug` ROM it is open
regardless, and `cat /proc/net/unix | grep devtools` is the only line that answers that
question. See [Residual risk: the devtools socket](#residual-risk-the-devtools-socket).

Behaviours worth exercising by hand, because the suite cannot reach them:

- **Long press.** Hold any card for 700 ms. It must open, not just light up.
- **Close then immediately tap.** Tap the header ✕, then tap a card within ~100 ms. It must
  open; the closing panel must not eat the tap.
- **Finished countdown, unattended.** Timer → 1 min → Start → walk away. The alarm fires, and
  about a minute later the dashboard is back by itself with `done 1m ago` on the TIMER tile.
- **Idle panel.** Open any panel and leave it. Gone in 90 s. Tap it every 20 s instead and it
  stays — the timeout must not fire mid-read.
- **Power cycle.** `input keyevent KEYCODE_POWER` twice. The dashboard comes back on its own,
  with the keyguard still armed.
- **Force-stop.** Settings must come back exactly as they were.

Do not `adb root` on this device — it drops both USB and wireless debugging.
