package com.safefeed.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Safe Feed: the real Facebook mobile site inside a WebView.
 * - Reels are hidden (assets/sg/filter.js + the address check below).
 * - Every picture/video stays blurred until the hidden face-check page (assets/ml) says no woman's face is in it.
 * - Nothing about pictures leaves the phone. Login happens on Facebook's own page; the app never sees the password.
 */
public class MainActivity extends Activity implements Pipeline.Host {

    private static final String HOME = "https://m.facebook.com/";
    private static final String ML_URL = "https://appassets.androidplatform.net/assets/ml/index.html";
    private static final int REQ_FILE = 7001;

    private WebView web;
    private WebView ml;
    private Pipeline pipeline;
    private ValueCallback<Uri[]> fileCallback;
    private String filterJs = "";
    private boolean docStart = false; // true when the document-start script was accepted

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        pipeline = new Pipeline(this);
        filterJs = readAsset("sg/filter.js");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        // Hidden face-check page: 1 pixel big but alive, so the graphics chip keeps working for it.
        ml = new WebView(this);
        setupMl();
        root.addView(ml, new FrameLayout.LayoutParams(1, 1));

        web = new WebView(this);
        setupWeb();
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        root.addView(buildMenuButton());
        setContentView(root);

        ml.loadUrl(ML_URL);
        if (state == null || web.restoreState(state) == null) {
            web.loadUrl(HOME);
        }
    }

    // ------------------------------------------------------------------ Facebook page

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(true); // no auto-playing videos
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);

        // Look like normal mobile Chrome so Facebook shows its normal mobile site.
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", "");
            s.setUserAgentString(ua);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new PageBridge(), "SgBridge");
        web.setWebViewClient(new FbClient());
        web.setWebChromeClient(new FbChrome());

        // The blur must be in place before the page draws anything, so the filter is added as a
        // document-start script. It is also injected again when the page starts (harmless: it runs once).
        if (filterJs.length() == 0) {
            pipeline.note("filter.js is missing from the app");
        } else if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                Set<String> origins = new HashSet<String>();
                origins.add("https://*.facebook.com");
                origins.add("https://facebook.com");
                WebViewCompat.addDocumentStartJavaScript(web, filterJs, origins);
                docStart = true;
            } catch (RuntimeException e) {
                pipeline.note("document-start script not available: " + e);
            }
        }
    }

    private void injectFilter(WebView view) {
        if (filterJs.length() > 0) {
            view.evaluateJavascript(filterJs, null);
        }
    }

    private final class FbClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return route(view, request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            injectFilter(view);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            injectFilter(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            injectFilter(view);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                Toast.makeText(MainActivity.this, R.string.load_failed, Toast.LENGTH_LONG).show();
            }
        }
    }

    private final class FbChrome extends WebChromeClient {
        // Full-screen video is deliberately NOT supported: a full-screen video is drawn by the system
        // and would skip the blur.

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Decides where a tapped address goes. Returns true when the app handled it. */
    private boolean route(WebView view, Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        if (scheme.equals("http") || scheme.equals("https")) {
            if (isFacebook(host)) {
                if (scheme.equals("http")) {
                    view.loadUrl(u.buildUpon().scheme("https").build().toString());
                    return true;
                }
                String path = u.getPath() == null ? "" : u.getPath().toLowerCase(Locale.ROOT);
                if (path.startsWith("/reel")) { // /reel/..., /reels/...
                    view.loadUrl(HOME);
                    return true;
                }
                return false;
            }
            openOutside(u);
            return true;
        }
        if (scheme.equals("tel") || scheme.equals("mailto") || scheme.equals("sms") || scheme.equals("geo")) {
            openOutside(u);
            return true;
        }
        return true; // fb://, intent:// and other app links are blocked
    }

    private static boolean isFacebook(String host) {
        return host.equals("facebook.com") || host.endsWith(".facebook.com")
                || host.equals("fb.com") || host.endsWith(".fb.com")
                || host.equals("fb.me") || host.equals("fb.watch");
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            // nothing can open it
        }
    }

    /** What the Facebook page can call. Every input is checked. */
    private final class PageBridge {
        @JavascriptInterface
        public void check(String token, int id, String url) {
            pipeline.check(token, id, url);
        }

        @JavascriptInterface
        public void frame(String token, int id, String base64) {
            pipeline.frame(token, id, base64);
        }

        @JavascriptInterface
        public void log(String msg) {
            pipeline.note("page: " + msg);
        }
    }

    // ------------------------------------------------------------------ hidden face-check page

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupMl() {
        WebSettings s = ml.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        ml.addJavascriptInterface(new MlBridge(), "MlBridge");
        ml.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    pipeline.note("ml-js: " + m.message() + " @" + m.lineNumber());
                }
                return true;
            }
        });
        ml.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("/job".equals(u.getPath())) {
                    return jobResponse(u);
                }
                return loader.shouldInterceptRequest(u);
            }
        });
    }

    private WebResourceResponse jobResponse(Uri u) {
        try {
            int id = Integer.parseInt(u.getQueryParameter("id"));
            byte[] data = pipeline.takeJob(id);
            if (data != null) {
                Map<String, String> headers = new HashMap<String, String>();
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse("image/jpeg", null, 200, "OK", headers,
                        new ByteArrayInputStream(data));
            }
        } catch (Exception e) {
            // falls through to 404
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    /** What the hidden face-check page can call. */
    private final class MlBridge {
        @JavascriptInterface
        public void ready(String info) {
            pipeline.onMlReady(info);
        }

        @JavascriptInterface
        public void fail(String why) {
            pipeline.onMlFail(why);
        }

        @JavascriptInterface
        public void result(int jobId, int verdict, String info) {
            pipeline.onMlResult(jobId, verdict, info);
        }

        @JavascriptInterface
        public void log(String msg) {
            pipeline.note("ml: " + msg);
        }
    }

    // ------------------------------------------------------------------ Pipeline.Host

    @Override
    public void runMl(final int jobId) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (ml != null && !isDestroyed()) {
                    ml.evaluateJavascript("window.mlRun&&window.mlRun(" + jobId + ")", null);
                }
            }
        });
    }

    @Override
    public void deliver(final String token, final int id, final int verdict) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null && !isDestroyed()) {
                    web.evaluateJavascript("window.__sgResult&&window.__sgResult('" + token + "',"
                            + id + "," + verdict + ")", null);
                }
            }
        });
    }

    // ------------------------------------------------------------------ small menu

    private View buildMenuButton() {
        TextView t = new TextView(this);
        t.setText("\u22EE");
        t.setTextColor(Color.WHITE);
        t.setTextSize(22f);
        t.setGravity(Gravity.CENTER);
        t.setBackgroundColor(0xAA000000);
        t.setAlpha(0.55f);
        int size = dp(40);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(size, size, Gravity.BOTTOM | Gravity.START);
        lp.leftMargin = dp(4);
        lp.bottomMargin = dp(4);
        t.setLayoutParams(lp);
        t.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showMenu();
            }
        });
        return t;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void showMenu() {
        final String[] items = {
                getString(R.string.menu_reload),
                getString(R.string.menu_home),
                getString(R.string.menu_status)
        };
        new AlertDialog.Builder(this).setItems(items, new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                if (which == 0) {
                    web.reload();
                } else if (which == 1) {
                    web.loadUrl(HOME);
                } else {
                    showStatus();
                }
            }
        }).show();
    }

    private void showStatus() {
        final String js = "(function(){try{return window.__sg?window.__sg.dump():"
                + "'filter script is not running on this page';}catch(e){return 'error '+e;}})()";
        web.evaluateJavascript(js, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                String page = value == null ? "null" : value;
                if (page.length() > 1 && page.startsWith("\"") && page.endsWith("\"")) {
                    page = page.substring(1, page.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
                }
                TextView tv = new TextView(MainActivity.this);
                tv.setText(pipeline.statusText() + "\nPAGE: " + page);
                tv.setTextSize(12f);
                tv.setTypeface(Typeface.MONOSPACE);
                tv.setTextIsSelectable(true);
                tv.setPadding(dp(14), dp(10), dp(14), dp(10));
                ScrollView sv = new ScrollView(MainActivity.this);
                sv.addView(tv);
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.status_title)
                        .setView(sv)
                        .setPositiveButton(R.string.close, null)
                        .show();
            }
        });
    }

    // ------------------------------------------------------------------ life cycle

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) {
            web.saveState(out);
        }
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (pipeline != null) {
            pipeline.shutdown();
        }
        destroyWeb(web);
        destroyWeb(ml);
        web = null;
        ml = null;
        super.onDestroy();
    }

    private static void destroyWeb(WebView w) {
        if (w == null) {
            return;
        }
        if (w.getParent() instanceof ViewGroup) {
            ((ViewGroup) w.getParent()).removeView(w);
        }
        w.destroy();
    }

    private String readAsset(String name) {
        InputStream in = null;
        try {
            in = getAssets().open(name);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return out.toString("UTF-8");
        } catch (IOException e) {
            return "";
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
            }
        }
    }
}
