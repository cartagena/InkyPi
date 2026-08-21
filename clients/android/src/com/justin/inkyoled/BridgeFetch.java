package com.justin.inkyoled;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Network fetch on behalf of the page.
 *
 * The page is file:// so its origin is null: any request that carries an auth header dies
 * in a CORS preflight the target never answers (Home Assistant), and most RSS feeds send
 * no CORS headers at all. This does the request natively — which is exactly why it is
 * fenced:
 *
 *   - the ORIGIN ALLOWLIST is fixed once per page load, first call wins. app.js registers
 *     the origins derived from config.js at boot; anything attaching later (the userdebug
 *     devtools socket is open on this ROM) cannot widen it.
 *   - GET and POST only, http(s) only, and every redirect hop is re-checked against the
 *     allowlist before it is followed.
 *   - response capped at 1.5 MB, request body at 8 KB, 8 s per hop, three redirects.
 *   - only Authorization / Accept / Content-Type headers pass through.
 *
 * Results go back asynchronously via evaluateJavascript into WP.bridgeFetch — a
 * synchronous bridge call would park the page's JS thread on the network. Payloads ride
 * as base64 so nothing in a response body can escape the string literal it lands in.
 */
class BridgeFetch {

    private static final String TAG = "InkyOLED";

    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Set<String> allowedOrigins = null;   // null until the page locks it
    private final WebViewSupplier webView;

    /** MainActivity's WebView field is not final; fetch completions read it late. */
    interface WebViewSupplier { WebView get(); }

    BridgeFetch(WebViewSupplier webView) {
        this.webView = webView;
    }

    void shutdown() {
        pool.shutdownNow();
    }

    /** First write wins: boot registers, nothing after boot can widen. */
    boolean lockOrigins(String originsJson) {
        if (allowedOrigins != null) return false;
        Set<String> set = new HashSet<>();
        try {
            JSONArray a = new JSONArray(originsJson);
            for (int i = 0; i < a.length(); i++) {
                String o = a.optString(i, "").toLowerCase();
                if (o.startsWith("http://") || o.startsWith("https://")) set.add(o);
            }
        } catch (Exception e) {
            Log.w(TAG, "fetchOrigins rejected: " + e);
            return false;
        }
        allowedOrigins = set;
        Log.i(TAG, "bridge fetch origins locked: " + set.size());
        return true;
    }

    void enqueue(final String id, final String url, final String headersJson,
                 final String method, final String body) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,32}")) return;
        pool.execute(new Runnable() {
            @Override
            public void run() {
                doFetch(id, url, headersJson, method, body);
            }
        });
    }

    private static String originOf(URL u) {
        int port = u.getPort();
        String o = u.getProtocol().toLowerCase() + "://" + u.getHost().toLowerCase();
        if (port != -1 && port != u.getDefaultPort()) o += ":" + port;
        return o;
    }

    /** Runs on the pool. Validates every hop, then posts the result into the page. */
    private void doFetch(String id, String url, String headersJson, String method, String body) {
        int status = -1;
        String errText = null;
        byte[] payload = null;
        try {
            Set<String> allowed = allowedOrigins;
            if (allowed == null) throw new Exception("no origins registered");
            boolean post = "POST".equalsIgnoreCase(method);
            String target = url;
            for (int hop = 0; hop < 4; hop++) {
                URL u = new URL(target);
                String proto = u.getProtocol().toLowerCase();
                if (!proto.equals("http") && !proto.equals("https"))
                    throw new Exception("scheme not allowed");
                if (!allowed.contains(originOf(u)))
                    throw new Exception("origin not allowed: " + originOf(u));

                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(false);       // hops are validated by hand
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestMethod(post ? "POST" : "GET");
                JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                    String k = it.next();
                    String kl = k.toLowerCase();
                    if (kl.equals("authorization") || kl.equals("accept")
                            || kl.equals("content-type"))
                        c.setRequestProperty(k, h.optString(k, ""));
                }
                if (post) {
                    byte[] out = (body == null ? "" : body).getBytes("UTF-8");
                    if (out.length > 8192) throw new Exception("body too large");
                    c.setDoOutput(true);
                    c.getOutputStream().write(out);
                }
                status = c.getResponseCode();
                if (status >= 300 && status < 400) {
                    String loc = c.getHeaderField("Location");
                    c.disconnect();
                    if (loc == null) throw new Exception("redirect without location");
                    target = new URL(u, loc).toString();
                    continue;                              // re-validated at loop top
                }
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] chunk = new byte[16384];
                    int n, total = 0;
                    while ((n = in.read(chunk)) != -1) {
                        total += n;
                        if (total > 1536 * 1024) throw new Exception("response too large");
                        buf.write(chunk, 0, n);
                    }
                    in.close();
                }
                c.disconnect();
                payload = buf.toByteArray();
                break;
            }
            if (payload == null) throw new Exception("too many redirects");
        } catch (Exception e) {
            errText = String.valueOf(e.getMessage()).replaceAll("[^\\w .:/-]", " ");
        }

        final String js;
        if (errText != null) {
            js = "window.WP&&WP.bridgeFetch&&WP.bridgeFetch._reject('" + id + "','"
                    + errText + "')";
        } else {
            String b64 = Base64.encodeToString(payload, Base64.NO_WRAP);
            js = "window.WP&&WP.bridgeFetch&&WP.bridgeFetch._resolve('" + id + "',"
                    + status + ",'" + b64 + "')";
        }
        main.post(new Runnable() {
            @Override
            public void run() {
                WebView web = webView.get();
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }
}
