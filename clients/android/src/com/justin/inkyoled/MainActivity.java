package com.justin.inkyoled;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;

/**
 * Fullscreen kiosk shell for the wall panel dashboard.
 *
 * Everything the dashboard needs is bundled in assets/ — it runs standalone with no
 * Raspberry Pi and no local server. The only network call is the weather fetch, which the
 * dashboard makes directly to Open-Meteo (no API key).
 *
 * The shell also injects a small JS bridge (window.Android) so the "Device" widget can
 * show real battery / storage / memory / network / uptime instead of placeholders, and so
 * settings survive a wipe of the WebView's localStorage. Every method the bridge exposes
 * is read-only apart from the SharedPreferences pair; none of them need a permission
 * beyond ACCESS_NETWORK_STATE, which the manifest already declared for the weather fetch.
 */
public class MainActivity extends Activity {

    private static final String TAG = "InkyOLED";
    private static final String PREFS = "inky_panel";

    /**
     * The ONLY origin this WebView is allowed to navigate to. The dashboard is entirely
     * local: three scripts, one stylesheet, one page, all under assets/. Anything else —
     * a link, a redirect, a meta refresh, a window.location assignment — is refused.
     *
     * This matters because of addJavascriptInterface below: window.Android is attached to
     * the WebView, not to a page, so any document that manages to load in this WebView
     * inherits the bridge. Pinning navigation to file:///android_asset/ is what guarantees
     * only our own page can ever hold it.
     */
    private static final String ALLOWED_PREFIX = "file:///android_asset/";

    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        // A wall panel should never sleep while it is showing.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        /* Wall-panel lock-screen posture (API 27+; minSdk here is 29, so no legacy branch).
         *
         * FLAG_KEEP_SCREEN_ON alone is not enough: one press of the power button turns the
         * screen off, and when it comes back the secure keyguard is in front of the
         * dashboard indefinitely. For a device screwed to a wall with no keyboard that means
         * the panel is simply gone until a human walks over and types a PIN.
         *
         * setShowWhenLocked() draws this activity ABOVE the keyguard and setTurnScreenOn()
         * lets it wake the display when it is (re)started, so the dashboard comes back by
         * itself.
         *
         * DELIBERATE SECURITY POSTURE, not an oversight: this shows the dashboard over the
         * lock screen, so whatever the dashboard displays (weather, device stats, HA demo
         * tiles) is readable without unlocking. That is the correct trade for a wall panel.
         * We deliberately do NOT call KeyguardManager.requestDismissKeyguard() or any other
         * bypass — the keyguard stays armed and still gates everything outside this activity.
         * On a secure device requestDismissKeyguard would only prompt for credentials anyway.
         */
        setShowWhenLocked(true);
        setTurnScreenOn(true);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // assets are local; allow the page to fetch the weather API
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The layout is tuned in vh/vw against a known viewport. System font scaling would
        // silently break that, so pin the text zoom and disable pinch zoom entirely.
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        /* Nothing on this panel reads the filesystem or a content provider. Assets and
         * resources are explicitly exempt from setAllowFileAccess (file:///android_asset
         * and file:///android_res keep working), so switching both off costs the dashboard
         * nothing and takes local-file and content:// reads away from the page entirely.
         *
         * setAllowFileAccessFromFileURLs / setAllowUniversalAccessFromFileURLs are NOT
         * called: both are deprecated as of API 30 and both already default to false, and
         * build.ps1 fails on javac's deprecation note. targetSdk is 36, so the defaults
         * apply — a file:// page here cannot XHR another file:// URL or claim a universal
         * origin. */
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);          // the location comes from config.js, not the OS

        /* Navigation allowlist. A bare WebViewClient blocks external browser launches but
         * permits in-WebView navigation anywhere, which would hand a remote origin the
         * window.Android bridge. Only the local page may load; everything else is refused
         * and logged, and no Intent is fired, so a wall panel can never end up showing a
         * web page nobody asked for. */
        web.setWebViewClient(new WebViewClient() {
            /* Only the WebResourceRequest overload is implemented: it is the one the
             * framework calls from API 24 up and minSdk here is 29, so the deprecated
             * String overload is unreachable on every device this can install on. */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return blocked(req.getUrl() == null ? null : req.getUrl().toString());
            }

            /** true == "we handled it", i.e. the WebView must not load it. */
            private boolean blocked(String url) {
                if (url != null && url.startsWith(ALLOWED_PREFIX)) return false;
                Log.w(TAG, "blocked navigation to " + describe(url));
                return true;
            }
        });
        web.setBackgroundColor(0xFF000000);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // Mirror page console output into logcat so `adb logcat | grep InkyOLED` is enough
        // to debug the dashboard without attaching devtools. (WebChromeClient's default
        // onCreateWindow already refuses target=_blank / window.open, so no popup can
        // escape the allowlist above by opening a second WebView.)
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, "console[" + cm.messageLevel() + "] " + cm.message()
                        + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
                return true;
            }
        });

        /* Remote debugging opens a devtools socket that ANY local app (or anything reaching
         * the device over adb) can attach to, with full script execution in this WebView —
         * which means full use of window.Android. It used to be switched on unconditionally.
         *
         * The gate is FLAG_DEBUGGABLE, i.e. android:debuggable in the linked manifest. The
         * shipping build never sets it; `build.ps1 -Debuggable` passes aapt2's --debug-mode,
         * which sets the flag, and only that build asks for the socket. Nothing to remember
         * at release time, no way to ship it on by accident, and CI fails if a default-built
         * APK ever comes out debuggable.
         *
         * IMPORTANT — this gate controls what the app REQUESTS, not what the device does.
         * Chromium's WebView force-enables its devtools server on userdebug/eng ROMs
         * whatever value it is handed here, and the target tablet is a Magisk-patched
         * userdebug build: @webview_devtools_remote_<pid> exists for this process even
         * though ro.debuggable=0 and the line below logs "off". Do not read that log line as
         * proof the socket is closed. Nothing here can close it; see "Residual risk: the
         * devtools socket" in INTERACTIVE.md for the blast radius and the only real fix
         * (a retail `user` ROM).
         *
         * The line below is logged either way so the running build says which it is. */
        boolean debuggable =
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        Log.i(TAG, "webview debugging " + (debuggable ? "ENABLED (debuggable build)" : "off"));

        // must be attached before the page loads so window.Android exists at first script
        web.addJavascriptInterface(new Bridge(), "Android");

        setContentView(web);
        // NOTE: assets are kept FLAT (no subdirectory). aapt2 on Windows writes subdirectory
        // separators as backslashes ("assets/dashboard\index.html"), which android_asset URLs
        // cannot resolve. Keeping everything at the assets root sidesteps that entirely.
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /** Immersive: no status bar, no nav bar. Re-applied on focus because Android restores them.
     *  The pre-R branch uses the old SYSTEM_UI_FLAG_* constants on purpose — they are the only
     *  thing that works below API 30. Warnings are suppressed because build.ps1 runs javac
     *  through a strict PowerShell pipeline where any stderr note aborts the build. */
    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    /**
     * Back must never leave the dashboard. It is now wired to the panel stack instead:
     * if a detail panel is open the page closes the top one, otherwise nothing happens.
     * We deliberately do not call super, so the activity can never finish.
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){try{return !!(window.WP && WP.onAndroidBack());}"
                            + "catch(e){return false;}})()", null);
        }
    }

    @Override
    protected void onDestroy() {
        bridgeFetch.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /**
     * Scheme + host only, for the blocked-navigation log line. A refused URL is by
     * definition something we did not author, and logcat on this device is readable by
     * anything holding READ_LOGS — so the path and query string, which are where a token
     * or a session id would be, never get written out.
     */
    private static String describe(String url) {
        if (url == null) return "(null)";
        int scheme = url.indexOf(':');
        if (scheme < 0) return "(malformed)";
        String head = url.substring(0, scheme + 1);
        if (!url.startsWith(head + "//")) return head + "…";
        int host = url.indexOf('/', scheme + 3);
        return (host < 0 ? url : url.substring(0, host)) + "/…";
    }

    /** The page's network access, fenced; see BridgeFetch. */
    private final BridgeFetch bridgeFetch = new BridgeFetch(new BridgeFetch.WebViewSupplier() {
        @Override
        public WebView get() { return web; }
    });

    /* ====================================================================================
       JS BRIDGE
       Methods here run on the WebView's private "JavaBridge" thread, never the UI thread,
       so they must not touch views. They only read system services and return JSON, which
       keeps one call per refresh instead of a dozen round-trips across the boundary.
       ==================================================================================== */
    private class Bridge {

        /** Everything the Device widget shows, in one JSON snapshot. */
        @JavascriptInterface
        public String deviceInfo() {
            JSONObject root = new JSONObject();
            try {
                root.put("battery", battery());
                root.put("storage", storage());
                root.put("memory", memory());
                root.put("network", network());
                root.put("device", device());
                root.put("uptimeMs", SystemClock.elapsedRealtime());   // includes deep sleep
                root.put("awakeMs", SystemClock.uptimeMillis());       // excludes deep sleep
                root.put("brightness", brightness());
                root.put("now", System.currentTimeMillis());
            } catch (Exception e) {
                Log.w(TAG, "deviceInfo failed: " + e);
            }
            return root.toString();
        }

        /** Persistence backstop: the page keeps settings in localStorage and mirrors here. */
        @JavascriptInterface
        public String getPref(String key) {
            SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return p.getString(key, null);
        }

        @JavascriptInterface
        public void setPref(String key, String value) {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(key, value).apply();
        }

        /* Network through the shell — the machinery, the fencing and the WHY live in
           BridgeFetch.java; these two are the @JavascriptInterface surface only. */
        @JavascriptInterface
        public boolean fetchOrigins(String originsJson) {
            return bridgeFetch.lockOrigins(originsJson);
        }

        @JavascriptInterface
        public void httpFetch(String id, String url, String headersJson,
                              String method, String body) {
            bridgeFetch.enqueue(id, url, headersJson, method, body);
        }

    /* ---- battery: sticky ACTION_BATTERY_CHANGED needs no permission ---- */
        private JSONObject battery() throws Exception {
            JSONObject o = new JSONObject();
            Intent i = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (i == null) return o;

            int level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            int status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int plugged = i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
            int health = i.getIntExtra(BatteryManager.EXTRA_HEALTH, -1);

            o.put("level", (level >= 0 && scale > 0) ? Math.round(level * 100f / scale) : -1);
            o.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL);
            o.put("status", statusName(status));
            o.put("plugged", pluggedName(plugged));
            o.put("health", healthName(health));
            o.put("technology", i.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY));
            o.put("voltageMv", i.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1));
            // reported in tenths of a degree C
            int t = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
            o.put("tempC", t > 0 ? t / 10.0 : JSONObject.NULL);
            return o;
        }

        private String statusName(int s) {
            switch (s) {
                case BatteryManager.BATTERY_STATUS_CHARGING:     return "Charging";
                case BatteryManager.BATTERY_STATUS_DISCHARGING:  return "Discharging";
                case BatteryManager.BATTERY_STATUS_FULL:         return "Full";
                case BatteryManager.BATTERY_STATUS_NOT_CHARGING: return "Not charging";
                default:                                         return "Unknown";
            }
        }

        private String pluggedName(int p) {
            switch (p) {
                case BatteryManager.BATTERY_PLUGGED_AC:       return "AC";
                case BatteryManager.BATTERY_PLUGGED_USB:      return "USB";
                case BatteryManager.BATTERY_PLUGGED_WIRELESS: return "Wireless";
                case 0:                                       return "";
                default:                                      return "Other";
            }
        }

        private String healthName(int h) {
            switch (h) {
                case BatteryManager.BATTERY_HEALTH_GOOD:            return "Good";
                case BatteryManager.BATTERY_HEALTH_OVERHEAT:        return "Overheat";
                case BatteryManager.BATTERY_HEALTH_DEAD:            return "Dead";
                case BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE:    return "Over voltage";
                case BatteryManager.BATTERY_HEALTH_COLD:            return "Cold";
                case BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE: return "Failure";
                default:                                            return "Unknown";
            }
        }

        /* ---- storage: StatFs on the data partition, no permission needed.
               Deliberately not Environment.getExternalStorageDirectory() — it is deprecated
               (and build.ps1 treats javac's deprecation note as a hard failure); on this
               device shared storage lives on the same partition anyway. ---- */
        private JSONObject storage() throws Exception {
            JSONObject o = new JSONObject();
            StatFs fs = new StatFs(Environment.getDataDirectory().getPath());
            o.put("total", fs.getTotalBytes());
            o.put("free", fs.getAvailableBytes());
            o.put("blockSize", fs.getBlockSizeLong());
            File files = getFilesDir();
            if (files != null) {
                StatFs app = new StatFs(files.getPath());
                o.put("appFree", app.getAvailableBytes());
            }
            return o;
        }

        private JSONObject memory() throws Exception {
            JSONObject o = new JSONObject();
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return o;
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            o.put("total", mi.totalMem);
            o.put("free", mi.availMem);
            o.put("low", mi.lowMemory);
            o.put("threshold", mi.threshold);
            return o;
        }

        /* ---- network: needs ACCESS_NETWORK_STATE, already declared for the weather fetch.
               Deliberately avoids anything (SSID, BSSID, signal level) that would drag in
               a location permission on Android 10+. ---- */
        private JSONObject network() throws Exception {
            JSONObject o = new JSONObject();
            o.put("type", "none");
            ConnectivityManager cm =
                    (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return o;

            Network n = cm.getActiveNetwork();
            if (n == null) return o;
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c == null) return o;

            String type = "unknown";
            if (c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) type = "Wi-Fi";
            else if (c.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) type = "Cellular";
            else if (c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) type = "Ethernet";
            else if (c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) type = "VPN";

            o.put("type", type);
            o.put("validated", c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            o.put("metered", !c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
            o.put("downKbps", c.getLinkDownstreamBandwidthKbps());
            o.put("upKbps", c.getLinkUpstreamBandwidthKbps());

            LinkProperties lp = cm.getLinkProperties(n);
            if (lp != null) o.put("iface", lp.getInterfaceName());
            return o;
        }

        private JSONObject device() throws Exception {
            JSONObject o = new JSONObject();
            o.put("model", Build.MODEL);
            o.put("manufacturer", Build.MANUFACTURER);
            o.put("android", Build.VERSION.RELEASE);
            o.put("sdk", Build.VERSION.SDK_INT);
            DisplayMetrics dm = getResources().getDisplayMetrics();
            o.put("screen", dm.widthPixels + "x" + dm.heightPixels);
            o.put("density", dm.densityDpi);
            return o;
        }

        /** Read-only; changing brightness would need the WRITE_SETTINGS special permission. */
        private Object brightness() {
            try {
                return Settings.System.getInt(getContentResolver(),
                        Settings.System.SCREEN_BRIGHTNESS);
            } catch (Exception e) {
                return JSONObject.NULL;
            }
        }
    }
}
