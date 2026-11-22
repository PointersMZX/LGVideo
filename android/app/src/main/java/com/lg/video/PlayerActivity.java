package com.lg.video;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 独立播放器页（对应桌面播放器独立窗口）：
 * WebView 载 player-window.html（WebViewAssetLoader 域名），本地视频经 MediaServer
 * （127.0.0.1 随机端口，原生 Range 支持）流式供给。
 *
 * 不用 shouldInterceptRequest 拦截媒体的原因见 MediaServer 头注释（2MB 拦截硬限制）。
 *
 * 桥：注入 playerAPI shim（AndroidPlayerBridge @JavascriptInterface + 回调 evaluateJavascript），
 * 页面内 player.js 与桌面窗口形态完全同构；播放进度记忆键 = 原始文件 URI（由 shim 转换）。
 */
public class PlayerActivity extends Activity {

    public static final String MEDIA_HOST = "appassets.androidplatform.net";

    private WebView webView;
    private JsonStore store;
    private final Map<String, String> mediaSources = new HashMap<>();
    private MediaServer mediaServer;
    private int mediaPort = -1;
    private String origFile = "";
    private String payloadJson = "{}";
    private boolean payloadSent = false;

    // 全屏视频
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;
    private FrameLayout root;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new JsonStore(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);
        setContentView(root);

        final Intent intent = getIntent();
        payloadJson = intent.getStringExtra(VoidBridgePlugin.EXTRA_PLAYER_PAYLOAD);
        if (payloadJson == null) payloadJson = "{}";

        mediaServer = new MediaServer(this, mediaSources::get);
        mediaPort = mediaServer.start();

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF000000);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        final WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        // https 页面拉 http://127.0.0.1 媒体流：混合内容走兼容模式（NSC 已对回环放行明文）
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        webView.addJavascriptInterface(new PlayerBridge(), "AndroidPlayerBridge");
        webView.setWebViewClient(new PlayerWebViewClient(loader));
        webView.setWebChromeClient(new PlayerWebChromeClient());

        final String url = "https://" + MEDIA_HOST + "/assets/public/player-window.html";
        webView.loadUrl(url);
    }

    /** 主进程装载指令等价物：页面就绪后把 payload 交给 player.js（file 已映射为媒体流地址） */
    private void sendPayload() {
        if (payloadSent) return;
        payloadSent = true;
        try {
            final JSONObject p = new JSONObject(payloadJson);
            origFile = p.optString("file", "");
            final String mediaUrl = registerMedia(origFile);
            if (mediaUrl != null) p.put("file", mediaUrl);
            final String js = "window.__LG_ORIG_FILE=" + jsString(origFile) + ";"
                    + "window.__playerOnLoad&&window.__playerOnLoad(" + p.toString() + ")";
            webView.evaluateJavascript(js, null);
        } catch (Exception ignored) {
        }
    }


    private String registerMedia(String source) {
        if (source == null || source.isEmpty() || mediaPort < 0) return null;
        final String id = String.valueOf(mediaSources.size());
        mediaSources.put(id, source);
        return "http://127.0.0.1:" + mediaPort + "/media/" + id;
    }

    // ───────────────────────── JS 桥 ─────────────────────────

    private class PlayerBridge {
        @JavascriptInterface
        public void call(String id, String method, String argJson) {
            final String result = dispatch(method, argJson);
            runOnUiThread(() -> webView.evaluateJavascript(
                    "window.__playerBridgeResolve&&window.__playerBridgeResolve("
                            + id + "," + jsString(result == null ? "null" : result) + ")", null));
        }
    }

    private String dispatch(String method, String argJson) {
        try {
            if ("close".equals(method)) {
                runOnUiThread(this::finish);
                return "null";
            }
            if ("toggleFullScreen".equals(method)) {
                runOnUiThread(() -> {
                    if (customView == null) {
                        webView.evaluateJavascript(
                                "document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()", null);
                    } else {
                        exitFullscreen();
                    }
                });
                return "null";
            }
            if ("getPosition".equals(method) || "setPosition".equals(method) || "clearPosition".equals(method)) {
                final Object arg = new org.json.JSONArray(argJson.isEmpty() ? "[null]" : argJson).opt(0);
                final String file = arg instanceof String ? (String) arg : null;
                if (file == null) return "null";
                if ("getPosition".equals(method)) {
                    final Object pos = store.readObject("positions.json", new JSONObject()).opt(file);
                    return pos == null ? "null" : pos.toString();
                }
                if ("setPosition".equals(method)) {
                    final org.json.JSONArray pair = new org.json.JSONArray(argJson);
                    final JSONObject positions = store.readObject("positions.json", new JSONObject());
                    positions.put(file, pair.opt(1));
                    store.write("positions.json", positions.toString());
                    return "null";
                }
                final JSONObject positions = store.readObject("positions.json", new JSONObject());
                positions.remove(file);
                store.write("positions.json", positions.toString());
                return "null";
            }
        } catch (Exception ignored) {
        }
        return "null";
    }

    // ───────────────────────── WebViewClient：资产 + HTML 注入 ─────────────────────────

    private class PlayerWebViewClient extends WebViewClient {

        private final WebViewAssetLoader loader;

        PlayerWebViewClient(WebViewAssetLoader loader) {
            this.loader = loader;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // 媒体流走 MediaServer（127.0.0.1），这里只服务页面与静态资产
            final WebResourceResponse resp = loader.shouldInterceptRequest(request.getUrl());
            if (resp != null && request.getUrl().getPath() != null
                    && request.getUrl().getPath().endsWith("player-window.html")) {
                return injectShim(resp);
            }
            return resp;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            sendPayload();
        }
    }

    private WebResourceResponse injectShim(WebResourceResponse resp) {
        try {
            final java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            final byte[] buf = new byte[8192];
            final InputStream in = resp.getData();
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            final String html = new String(bos.toByteArray(), StandardCharsets.UTF_8);
            final String shim = "<script>" + SHIM_JS + "</script>";
            final String out = html.contains("<head>")
                    ? html.replaceFirst("<head>", "<head>" + shim)
                    : shim + html;
            return new WebResourceResponse("text/html", "utf-8",
                    new ByteArrayInputStream(out.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return resp;
        }
    }

    private static String jsString(String raw) {
        final StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < raw.length(); i++) {
            final char ch = raw.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '<': sb.append("\\u003c"); break;
                case '>': sb.append("\\u003e"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
                    else sb.append(ch);
            }
        }
        return sb.append('"').toString();
    }

    // ───────────────────────── WebChromeClient（全屏视频） ─────────────────────────

    private class PlayerWebChromeClient extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreenContainer = new FrameLayout(PlayerActivity.this);
            fullscreenContainer.setBackgroundColor(Color.BLACK);
            fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.setVisibility(View.GONE);
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(0);
        setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (fullscreenContainer != null) {
            fullscreenContainer.removeAllViews();
            root.removeView(fullscreenContainer);
            fullscreenContainer = null;
        }
        if (customViewCallback != null) {
            try { customViewCallback.onCustomViewHidden(); } catch (Exception ignored) {}
            customViewCallback = null;
        }
        customView = null;
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { exitFullscreen(); return; }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        exitFullscreen();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.removeAllViews();
            webView.destroy();
            webView = null;
        }
        if (mediaServer != null) mediaServer.stop();
        super.onDestroy();
    }

    /** playerAPI shim：桌面窗口形态同构；进度记忆键转换为原始文件 URI */
    private static final String SHIM_JS =
        "(function(){" +
        "var pending=new Map(),seq=0;" +
        "function call(method,arg){return new Promise(function(resolve){var id=String(++seq);" +
        "pending.set(id,resolve);" +
        "try{window.AndroidPlayerBridge.call(id,method,JSON.stringify(arg===undefined?null:arg));}" +
        "catch(e){pending.delete(id);resolve(null);}});}" +
        "window.__playerBridgeResolve=function(id,resultJson){var r=pending.get(id);if(!r)return;" +
        "pending.delete(id);try{r(JSON.parse(resultJson));}catch(e){r(null);}};" +
        "function origKey(file){if(typeof file==='string'&&file.indexOf('127.0.0.1/media/')>=0)" +
        "return window.__LG_ORIG_FILE||file;return file;}" +
        "window.playerAPI={" +
        "onPlayerLoad:function(cb){window.__playerOnLoad=cb;}," +
        "close:function(){call('close');}," +
        "minimize:function(){}," +
        "maximize:function(){}," +
        "toggleFullScreen:function(){call('toggleFullScreen');}," +
        "getPosition:function(file){return call('getPosition',origKey(file));}," +
        "setPosition:function(file,pos){return call('setPosition',[origKey(file),pos]);}," +
        "clearPosition:function(file){return call('clearPosition',origKey(file));}" +
        "};" +
        "})();";
}
