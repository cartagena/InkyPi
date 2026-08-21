# Inky OLED

A standalone **touch dashboard app** for the Galaxy Tab S6 kitchen panel.

Same idea as [InkyPi](https://github.com/fatihak/InkyPi) — plugin cards on a dashboard — but
**runs entirely on the tablet**. No Raspberry Pi, no server, no e-ink hardware. Rendered for a
colour AMOLED instead of e-paper, hence the name.

It is no longer a static repaint loop: every card opens a full-screen detail panel, the
stopwatch and timer really run, the Home Assistant tiles toggle, and the settings panel writes
preferences that survive a force-stop. **See [INTERACTIVE.md](INTERACTIVE.md)** for the widgets,
the gesture model, the JS bridge, the burn-in strategy and how to test it on a device.

Built and dogfooded in an Android 16 emulator configured to the Tab S6's exact panel:
**2560x1600 @ density 360** (what the device itself reports, and what the Device panel reads
back), then tuned against screenshots from the real tablet — which renders
**portrait** (1600x2560), because Samsung's large-screen policy ignores the manifest's
orientation request.

## Install

```bash
adb install -r inky-oled\inkyoled.apk
```

Open **Inky OLED** from the app drawer.

## Configure

Edit **`assets/config.js`**, then rebuild and reinstall.

**Location is currently a placeholder (Seattle).** Change it or you will get Seattle's weather:

```js
location: {
  name: "Kitchen",
  latitude:  47.6062,     // yours from https://www.latlong.net/
  longitude: -122.3321,
},
```

Set both to `null` to show a "set your location" notice instead.

Also configurable: `units` (fahrenheit/celsius), `clockHours` (12/24), `weatherRefreshMinutes`,
and `burnInProtection` (`enabled`, `intervalSeconds`, `maxShiftPx`).

`units`, `clockHours` and `burnInProtection.enabled` are only **defaults** now — the on-device
Settings panel owns them once the user touches it, and its choices persist. `plugins` is a
legacy starting hint; which widgets render is a per-widget switch in Settings.

## Build

```bash
powershell -File build.ps1                # shipping build
powershell -File build.ps1 -Debuggable    # + WebView devtools socket (see Security posture)
```

Uses **only the Android SDK build-tools** — aapt2 -> javac -> d8 -> zipalign -> apksigner.
No Gradle, no Maven, no network. Builds in seconds. Output ~73 KB.

The SDK is found via `ANDROID_SDK_ROOT`, then `ANDROID_HOME`, then
`%LOCALAPPDATA%\Android\Sdk`. Override any of it:

```bash
powershell -File build.ps1 -SdkRoot D:\android-sdk -BuildToolsVersion 36.0.0 -Platform android-36
```

A missing build-tool prints what the SDK *does* have and the `sdkmanager` line that would fix
it, rather than a bare path.

## Tests

```bash
cd inky-oled
npm test                              # or: node --test "test/**/*.test.js"
```

**No `npm install`.** The app has no dependencies and neither does the suite — it runs on
node's built-in `node:test` / `node:assert` (node 22+; developed on 26). `package.json` exists
only so `npm test` works.

The tests load the real `assets/index.html`, `app.js` and every `assets/wx-*.js` unmodified
(in the order `index.html` lists them, parsed out of the page so the harness cannot hold a
stale copy of that list), into a small
DOM stub with a virtual clock (`test/lib/minidom.js`, `test/lib/harness.js`) — plus a small
stylesheet reader and box model (`test/lib/css.js`) for the geometry assertions — and drive them by
dispatching real pointer events at real elements — so a control's label and the action behind
it cannot drift apart without something failing. Nothing in `assets/` is exported or
restructured for the tests' benefit; the only two seams added for them are `fmt.dayOfYear` /
`fmt.isoWeek` (calendar arithmetic moved out of a render closure into the formatter namespace
where the rest of it lives) and `weather.checkRollover()` (a named method instead of an
anonymous interval body).

Tests live outside `assets/`, so nothing ships inside the APK — and `assets.test.js` asserts
that, along with the flat-assets rule.

What the suite is for: **four of the five rounds of regressions on this panel were
self-inflicted by fixes**, and every one was a pure function or a small state machine. Each has
a test named `REGRESSION:` that fails when the bug is put back —

| Historical bug | Caught by |
|---|---|
| Post-alarm button did the opposite of its label | `timer.test.js` — after the alarm the primary button reads Start *and starts*; `stateKey` must move whenever a control's legality moves |
| Reset parked the countdown at 00:00 after a statement reorder | `timer.test.js` — Reset reloads the full duration, from a finished alarm and from a pause |
| Double-tap on close reopened the panel underneath | `panels.test.js` — with the tile rect explicitly laid under the close bar; close-then-tap-*elsewhere* at 100 ms must still open |
| Now card / hourly NOW chip desync after an hour rollover | `weather.test.js` — both are read from the DOM across a simulated 06:59 -> 07:00 crossing |
| Day-of-year one low between DST start and end | `dates.test.js` — every day of 2024 in `America/Los_Angeles` |

Also covered: countdown ceiling, lap-split reconciliation, duty cycle (time-weighted),
settings merge, WMO codes, the demo simulator's mean reversion, `esc()` including the live
Home Assistant feed, the growth cap and the `overflow=0` layout assertion, the bridge contract
and its degradation, the icon palette discipline, the CSP meta, and the poll cadences
(`polling.test.js` — see below).

### Coverage

```bash
node --test --experimental-test-coverage "test/**/*.test.js"
```

Currently **app.js ~98% of lines / ~88% of branches**, and the widget layer ~97% / ~81%. The
numbers only exist because `harness.js` hands `vm.runInContext` an *absolute* filename under
`assets/`; with a bare `"app.js"` node attributed the sources to nothing and printed a
100%-of-empty report. CI runs this and asserts that `app.js` and **every** `wx-*.js` appears in
the report — derived from the directory, not from a list in the workflow — for exactly that
reason.

Coverage is measured, not gated. A line being executed is not the same as its behaviour being
asserted, and this suite has been mutation-tested precisely because the percentage does not
prove much on its own; four surviving mutants found that way (a `<=` boundary, drift moving
under a finger, the burn-in default with no config block, and `ago()`'s rounding) have tests
now, and each was written by first reintroducing the mutation and watching it fail.

## Running it without the tablet

```bash
python sim/server.py      # then open http://localhost:8788/cockpit
```

The **cockpit** runs the real app — the same `assets/` the APK ships — inside a frame at
the tablet's true CSS viewport, with a stand-in for the Java bridge. It exists because a
wall panel is mostly its *states*, and almost none of them happen on a desk:

- **Weather scenes** — thunderstorm, snow, fog, 3am clear sky — rewritten into a real
  Open-Meteo payload, so the icons, the charts and the animated sky can all be checked
  against a storm without waiting for one.
- **Failure modes** — wifi down, Home Assistant refusing the token, HA unreachable, a
  news feed returning 503. These are the paths that decide whether the panel degrades
  honestly or lies, and they are otherwise nearly impossible to reach on purpose.
- **A live Home Assistant** that never existed: the sim answers `/api/states/…` with
  believable payloads, so live mode is exercisable with no HA box on the network.
- **`SIM.sweep()`** walks every screen and every control with real pointer events and
  returns what looked wrong — dead space, near-miss scrolling, stuck press states,
  stacked panels, unlabelled targets, raw JS values on screen, console errors.

Note that ordinary click automation cannot drive this app: a wall panel runs 1-second
tickers forever, so the page never reaches the idle state such tools wait for, and every
automated click times out. The harness dispatches the pointer events itself.

## What it shows

Eleven widgets, all interactive — tap a card for its full-screen detail panel, **swipe
left/right inside any panel** to slide between screens (wrap-around, position dots), and an
optional **Cycle screens** switch turns the whole panel into an InkyPi-style playlist that
slides through the content screens on a dwell timer and returns to the dashboard. The icons are
the app's own coloured SVG (no emoji fonts), and an animated **sky layer** behind the dashboard
draws what the weather is doing: stars on a clear night, rain, snow, fog, drifting cloud banks,
a dim flash in a storm. Portrait and landscape both render a full, dead-space-free layout.

- **Clock** — time, seconds, full date; panel adds time zone, day of year, ISO week, world clocks
- **Now** — temperature, conditions, feels-like, wind, humidity; panel adds pressure, dew point,
  visibility, UV, gusts, sunrise/sunset, precipitation
- **Next 24 hours** — scrollable hourly strip; tap an hour for its readout
- **Next days** — all 7 days; tap a day for its detail and an hour-by-hour chart
- **Home** — Home Assistant sensors: a labelled **demo simulator** by default, your own entities
  when a token is configured
- **Device** — real battery, storage, memory, network and uptime through a JS bridge
- **Timer** — stopwatch with laps, countdown with presets and a full-screen alarm
- **Moon** — live phase drawn as a disc, illumination, age, next full/new; computed locally
- **Air** — US AQI in the EPA's own colour bands, pollutant breakdown, 24 h forecast
  (Open-Meteo air-quality endpoint, keyless like the weather)
- **News** — a one-line rotating headline ticker (RSS/Atom through the app shell — feeds
  never need CORS), full list in its panel; defaults to BBC World + NPR, configurable
- **Paper** — today's actual front page (the Freedom Forum archive InkyPi itself uses);
  pick the paper with `newspaper: { code: "USAT" }`; walks back a day when today's is late
- **Picture** — one picture a day, rotating among XKCD, the Wikimedia Commons picture of
  the day, and NASA's APOD; add `openai: { apiKey: … }` and a fourth source generates one
  (`prompt`, `model`, `quality` configurable) — the only key anything here can use
- **Settings** — units, clock format, seconds, sky animation, screen cycling, burn-in,
  per-widget show/hide; persisted

Weather comes from **Open-Meteo — no API key, no account.**

There was a twelfth, **Date**: a locally-computed month grid. It was cut. With no account and
no sync in this product by design it had no events to show, so after three design rounds it was
still a grid restating a date the Clock card already prints in 63 CSS px of type — 3.2% of the
screen inked, on a wall panel read from 3 m. Its home tile was cut with it, because
`DATE 17 / Mon · Aug` was the same fact as `Monday, August 17` on the same screen. Eleven
screens that all say something beats twelve where one does not.

## Home Assistant sensors (optional)

Shows your own room sensors — e.g. ESP32/MQTT nodes — instead of only outdoor weather.

**Without a token the card is not empty:** it runs a labelled `DEMO` simulator — nine entities on
a time-of-day model, with switches that hold state and feed back into it (the lamp warms the
living room and adds watts). That is what ships, since the repo is public.

To use a real Home Assistant, in `assets/config.js`:

```js
homeAssistant: {
  enabled: true,
  baseUrl: "http://homeassistant.local:8123",
  token: "<long-lived access token>",
  entities: [
    { id: "sensor.living_room_temperature", label: "Living room", unit: "°F" },
  ],
},
```

Create the token in HA under **Profile → Security → Long-Lived Access Tokens**; entity ids are
under **Developer Tools → States**. With `enabled`, `baseUrl` and `token` all set, the badge on
the card flips from `DEMO` to `live` and the widget polls the REST API; anything missing and it
falls back to the simulator.

> **The token grants full API access to your Home Assistant** and is stored in plain text inside
> the APK. Only sideload this build onto your own device, and never commit a real token — the
> repo's pre-commit scanner blocks it. On this tablet's `userdebug` ROM the token is also
> readable through the WebView devtools socket; see
> [Residual risk](INTERACTIVE.md#residual-risk-the-devtools-socket).

### CORS no longer applies on the tablet

Earlier builds hit a wall here: the dashboard is a `file://` document, so its origin is
`null`, the `Authorization` header forces a CORS preflight, and a stock Home Assistant
never answers it — every request died before leaving the device, with a valid token.

Live traffic now goes through the **app shell's own fetch** (`Android.httpFetch` in
MainActivity), which is not subject to page CORS at all. No `cors_allowed_origins` entry
is needed. The shell only talks to origins derived from `config.js` — locked once at page
load, first caller wins — accepts only GET/POST over http(s), re-validates every redirect
hop, and caps responses at 1.5 MB. Running the page in a desktop browser (no shell) still
uses a plain `fetch`, where CORS is back on you; that path exists for development only.

## Poll cadences

A wall panel's normal state is nobody looking at it, so the idle cost *is* the cost. Every
repeating timer in the app is listed here with what it does and why it runs at that rate.
`test/polling.test.js` and `test/device-bridge.test.js` assert the numbers.

| # | Timer | Rate | Notes |
|---|---|---|---|
| 1 | clock tile tick | 1 Hz | Dirty-checked per node; `toLocaleDateString` is guarded by the calendar day |
| 2 | clock panel readout | 1 Hz, open only | Writes two nodes; a full rebuild happens on the minute |
| 3 | timer tick | **10 Hz** | Deliberately unchanged — tenths and tap latency. Paints are dirty-checked, so an idle tick writes nothing |
| 4 | weather fetch | 15 min | `weatherRefreshMinutes` |
| 5 | hour-rollover check | 15 s | **Deliberately unchanged** — this is the fix for the Now/NOW desync. Costs one `getHours()` |
| 6 | hourly strip re-anchor | 15 s | Redraws only when `nowIndex()` moves; the scan behind it is memoised to one per hour |
| 7 | hourly scroll snap-back | 5 s | One `scrollLeft` read; returns immediately unless the strip has been scrolled |
| 8 | HA sensors | 5 s demo / `refreshSeconds` live | The live poll is a network call and is floored at 5 s |
| 9 | Device bridge | 5 s open / **60 s closed** | See below |
| 10 | burn-in drift | 120 s | `burnInProtection.intervalSeconds` |
| 11 | layout heartbeat | 30 s | Backstop for a growth cap measured while a card was still empty. Two forced layouts a minute; kept |

Measured before and after the throttling work, with the dashboard idle on the home view:

| | before | after |
|---|---:|---:|
| clock tile DOM writes | 14,400 / h | 60 / h |
| `toLocaleDateString()` | 3,600 / h | 0 / h |
| clock panel rebuilds (panel open) | 600 / 10 min | 10 / 10 min |
| bridge `deviceInfo()` JNI calls | 720 / h | 60 / h |
| Device tile DOM writes | 1,440 / h | 0 / h |
| timer tile DOM writes | 7,200 / h | 0 / h |
| forecast timestamp reads | 2,400 / h | 10 / h |

Two principles behind all of it:

- **The timer keeps its rate; the work inside it is what backs off.** The Device widget's
  callback still fires every 5 s, so opening its panel gets a fresh reading within one tick
  rather than up to a minute later — what drops to 60 s is the JNI call and the render.
  Opening the panel also takes a reading immediately.
- **Dirty checks compare the rendered string, never the clock.** That is what keeps a 12/24h
  flip or a seconds toggle landing on the very tick it happens, rather than on the next minute.

## Auto-start after reboot

A `BootReceiver` relaunches the dashboard on `BOOT_COMPLETED`.

**Caveat that matters:** since Android 10, apps cannot start activities from the background, so
this is silently dropped unless the app is exempt. Grant the exemption with:

```bash
adb shell appops set com.justin.inkyoled SYSTEM_ALERT_WINDOW allow
```

(or Settings → Apps → Inky OLED → Display over other apps).

The always-works alternative is making this the HOME launcher — deliberately not done here, since
the tablet is also a handheld video player and a launcher with no app drawer gets in the way.

## Screen-on behaviour

The app holds `FLAG_KEEP_SCREEN_ON` while in the foreground, so the screen stays on while the
dashboard shows and normal sleep returns the moment you switch to another app. **No global
settings needed** — see `patches/D-kiosk-settings/README.md`.

It also calls `setShowWhenLocked(true)` and `setTurnScreenOn(true)`, so one press of the power
button no longer strands the panel behind the lock screen — the dashboard comes back by itself.
**The keyguard is not bypassed:** it stays armed and still gates everything outside this
activity. The trade-off is that whatever the dashboard displays is readable without unlocking.
Details in [INTERACTIVE.md](INTERACTIVE.md#wall-panel-posture).

## Kiosk behaviour

- Fullscreen immersive: no status bar, no navigation bar
- Back closes the top detail panel and nothing else — it can never leave the app
- `FLAG_KEEP_SCREEN_ON` while showing; shown over the lock screen, keyguard still armed
- Manifest asks for landscape; the device renders portrait and the CSS is tuned for it, with a
  landscape fallback

## Security posture

The WebView holds a JS bridge (`window.Android`), so what can run inside it matters.

**The app never asks for the devtools socket** — but on this tablet it gets one anyway.
`WebView.setWebContentsDebuggingEnabled` is gated on `ApplicationInfo.FLAG_DEBUGGABLE`.
Nothing sets that flag unless you pass `build.ps1 -Debuggable`, which adds aapt2's
`--debug-mode`. There is no switch to remember at release time, and CI fails the build if a
default-built APK ever comes out debuggable. The running build says which it is:

```
I InkyOLED: webview debugging off
```

That log line is the app's *request*, not the outcome, and on the wall panel the two do not
agree. Measured on the device, with the shipping (non-debuggable) APK installed:

```
ro.build.type = userdebug      ro.debuggable = 0      package flags: no DEBUGGABLE
/proc/net/unix → @webview_devtools_remote_<pid>     (pid = com.justin.inkyoled)
```

Chromium's WebView force-enables its devtools server on `userdebug` and `eng` builds
regardless of what the app passes to `setWebContentsDebuggingEnabled`. This tablet runs a
Magisk-patched `userdebug` ROM, so the socket is open, and an attached debugger gets script
execution inside the page **plus `window.Android`**. See
[Residual risk: the devtools socket](INTERACTIVE.md#residual-risk-the-devtools-socket) for
the blast radius and what would actually close it. There is no app-side fix; it is a property
of the ROM.

**Navigation is allowlisted to `file:///android_asset/`.** A bare `WebViewClient` blocks
external browser launches but permits in-WebView navigation anywhere — and the bridge is
attached to the *WebView*, not to a page, so any document that loaded would inherit it.
`shouldOverrideUrlLoading` now refuses everything else and logs scheme+host only (a blocked
URL is by definition something we did not author; its path and query never reach logcat):

```
W InkyOLED: blocked navigation to https://example.com/…
```

`window.open` / `target=_blank` are refused too, by `WebChromeClient`'s default
`onCreateWindow`. `setAllowFileAccess(false)` and `setAllowContentAccess(false)` take local
files and `content://` away from the page; assets and resources are explicitly exempt from
that setting, so the dashboard is unaffected.

The bridge itself is read-only apart from the SharedPreferences pair, needs no permission
beyond `ACCESS_NETWORK_STATE`, and deliberately avoids SSID/BSSID/signal (which would drag in
a location permission).

Deliberate and not a bug: the dashboard renders **over the lock screen**, so its contents are
readable without unlocking. The keyguard is not bypassed — see *Screen-on behaviour*.

## CI

`.github/workflows/build.yml`, alongside the existing secret-scan workflow (which it does not
touch):

- **tests** (`ubuntu-latest`) — runs `npm test` (the command the README documents, so the
  script cannot rot while CI stays green), asserts `package.json` still declares no
  dependencies, and then asserts the suite **actually ran**: `node --test <glob>` exits 0 when
  the glob matches nothing, so a rename of `test/` would otherwise turn this job into a green
  light over zero executed tests. It parses the runner's summary and requires a floor.
  Coverage is produced and checked for the presence of both app sources.
- **build-apk** (`windows-latest`) — pins JDK 17, resolves the Android SDK from
  `ANDROID_SDK_ROOT` / `ANDROID_HOME` and **fails loudly if there isn't one** rather than
  skipping, installs the pinned build-tools + platform with `sdkmanager` if they are missing,
  then runs `build.ps1`. It then checks the artefact: not debuggable, assets flat and
  complete, no test code packaged, and that `-Debuggable` still does set the flag. The SDK pin
  lives in one workflow-level `env:` and is passed to both `build.ps1` and the `aapt2` path,
  so the script and the checks cannot drift onto different build-tools.

The APK is **not** uploaded as an artifact: `build.ps1` bakes `assets/config.js` into it, and
on a public repo an artifact is a download link.

**House rule: every assertion must fail closed.** Two have already shipped here that did not —
`-notmatch` on an array (which filters rather than answering yes/no, so it was true whenever
any line differed), and `Select-String -Quiet` over an *empty* `$badging`, which printed
`ok: not debuggable` whenever `aapt2` failed to run at all. PowerShell does not throw on a
native command's exit code, so nothing else caught it. Both times it was the security-critical
check that silently passed. Concretely: check `$LASTEXITCODE` after every native command,
assert the output exists before asserting anything *about* it, and treat "zero results" as a
failure rather than as a clean bill of health.

## Why it looks like this

Tuned deliberately for an **AMOLED wall panel**:

- **Black background** — on OLED those pixels are genuinely off. Less power, far less burn-in risk
  than a bright dashboard.
- **Thin type, low coverage** — fewer lit pixels, still readable at 2-4 m.
- **Burn-in drift** — every layer that can be on screen for hours (dashboard, detail panels, the
  alarm overlay) shifts by the same few pixels every 2 minutes, so nothing sits on the same
  pixels. Skipped while a finger is down. See patch `I-burnin`.
- **Idle unwind** — an open panel returns to the dashboard after 90 s untouched, and a finished
  countdown's alarm clears itself after 60 s. Drift protects the pixels; this makes sure the
  dashboard is what is actually on them.

And deliberately as **one design system** rather than eight panels that each look fine alone:
a ten-step type ramp in `vh` that every size comes off (`--fs-caption` … `--fs-display-xl`, no
literal font sizes anywhere), a five-step control-padding scale every `.tappable` picks from
(`--pad-chip` … `--pad-control`), one recipe for every small-caps label, one hero block, one
on/off idiom (a switch row — segmented buttons are reserved for a genuine choice between two
*named* values), one labelled `Details ›` affordance on every card that opens a panel, and
five motion durations. Each panel has a declared vertical strategy, so none reads as
unfinished and none reads as content that failed to load. The tokens live in `style.css`,
the builders in `wx-ui.js`, the rationale in
[INTERACTIVE.md § The design system](INTERACTIVE.md#the-design-system), and
`test/design-system.test.js` fails when any of it starts to drift.

Three of those assertions are worth naming, because each replaced a check that could not fail:

- **The copy sweep** reads every rendered string in the home view and in all eight panel
  bodies, not just the panel subtitles, and rejects the machinery: entity ids, an epoch
  counter, a CSS viewport measurement, a kernel interface name, `undefined`. Pointed at
  subtitles alone it had passed for five rounds while the wall carried
  `sensor.living_room_temperature` twice and `UNIX TIME 1786999387`.
- **The touch-target floor** takes its subject list from the rendered DOM — every distinct
  class carrying `.tappable` — and computes each control's height from the authored CSS
  through a small box model (`test/lib/css.js`). The hand-written eight-selector allowlist it
  replaced did not name the Home Assistant tile, and a mutation that shrank that tile to
  nothing passed.
- **The padding scale** exists because the floor has ~2x slack on most controls: cutting a
  settings row's padding by 76% wrecks the panel's rhythm without ever breaching 88 px. Being
  off the scale is the failure, which is a property about the design rather than a minimum.

## Dogfooding notes (fixes already made)

Testing at real resolution caught things that looked fine on a small screen:

1. **~40% dead space.** `grid-template-rows: auto 1fr` stretched the forecast card to fill the
   column, marooning it in a huge empty box. Fixed with `auto auto` + `align-content: center`.
2. **Too small for distance viewing.** Sizes were tuned on a 640x320 emulator and were far too
   timid at 2560x1600. Clock went 21vh -> 27vh, weather and forecast scaled to match.

## Build gotchas worth remembering

- **Assets must stay FLAT** (no subdirectories). `aapt2` on Windows writes subdirectory separators
  as backslashes — `assets/dashboard\index.html` — which `file:///android_asset/` cannot resolve.
  Result is a silent black screen.
- **PowerShell array concat.** `$a + $b` on two single-element results concatenates *strings*.
  Use `@($a) + @($b)` or javac receives one fused filename.

## Adding a plugin

`assets/app.js` holds the shared plumbing (settings, panel stack, touch delegation, bridge,
formatting) and `assets/wx-ui.js` the shared panel builders (`WP.ui.statGrid`, `section`,
`hero`, `bar`, `btn`, `segmented`, `switchRow`). Each widget is one flat file,
`assets/wx-<name>.js`, holding an object with `init()` and optionally
`onOpen(panel, arg)` / `onClose()` for its detail panel.

1. Add `<section class="card tappable" data-widget="yourname" data-open="yourname">` to
   `index.html`, plus a `<section class="panel" data-panel="yourname">` shell in the panel layer
2. Add `assets/wx-yourname.js` with the object and `WP.register()` it, and a `<script src>`
   for it in `index.html` (after `wx-ui.js`; assets stay flat, so it is a sibling not a
   subdirectory). Build its panel out of `WP.ui` rather than authoring markup or sizes of
   your own — that is what keeps the eight panels one design system
3. Add `"yourname"` to `WIDGETS` / `WIDGET_LABELS` in `app.js` so Settings can show and hide it

Controls inside a panel are markup, not listeners: `data-act="verb"` (with `data-arg` /
`data-ns`) is dispatched to your `WP.onAction` handler, and `data-close` pops the panel. Don't
attach your own click handler — it will not survive a long press. See
[INTERACTIVE.md](INTERACTIVE.md#interaction-model).

Two invariants are easy to break by accident and are written down as contracts: the **toast band**
(the toast takes over the status line on the dashboard and the panel subtitle inside a panel, and
never covers a control or a datum — [contract](INTERACTIVE.md#toast-placement)), and the **close
shadow** (a close tap suppresses only the `data-open` rect directly under it, for 600 ms — never a
blanket cooldown, which would re-break close-then-tap — [details](INTERACTIVE.md#panels)).

Sensible next cards: photo rotation, transit times, NAS status — or the Pi's InkyPi
output if you ever want the two linked.

## Not done yet

Auto-start on boot and screen pinning — patch-backlog items rather than app features. The
on-device settings UI is now built (widget #8).

Untested against reality: a **real** Home Assistant instance (the live REST path is exercised
by the suite against stubbed responses, but has never talked to an actual HA box), and the
offline/stale badge on device (verifying it means toggling the tablet's Wi-Fi, which drops the
adb transport — the suite covers the code path).
