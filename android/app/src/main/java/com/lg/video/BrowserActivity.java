package com.lg.video;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URL;

/**
 * Android 原生内嵌浏览器（解析模式核心）：对应桌面 webview 标签多标签页。
 *
 * 流畅适配要点（用户点名重点）：
 * 1. 多标签条 + 每标签独立 WebView，CookieManager 全局保登录态，标签回切恢复 URL；
 * 2. 解析按钮 = loadURL(解析接口 + 当前视频链接)，接口判定/地址栏回显逻辑与桌面 onNavigated 一致；
 * 3. 全屏视频 onShowCustomView/onHideCustomView：沉浸 + 横屏，退出还原；
 * 4. UA 默认伪装桌面 Chrome（站点出完整网页），一键切手机版；
 * 5. onCreateWindow（target=_blank/window.open）→ 本页打开；DownloadManager 接管文件下载；
 * 6. 站点 CSS（主题变量/顽固弹窗隐藏）由主页面组好后经 intent 传入 onPageFinished 注入；
 * 7. singleTask + onNewIntent：重复唤起不重复压栈，直接开新标签；
 * 8. 转屏/锁屏不重建（configChanges），返回键逐级关标签。
 */
public class BrowserActivity extends Activity {

    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    private BrowserSession session;
    private FrameLayout root;
    private FrameLayout stack;
    private LinearLayout tabStrip;
    private HorizontalScrollView tabScroll;
    private EditText addressBar;
    private ProgressBar progressBar;
    private TextView uaBtn;
    private WebView activeWebView;
    private String injectCss = "";
    private String startUrl = "https://v.qq.com";
    private String mode = "parse";
    private JSONArray apiList = new JSONArray();
    private String apiValue = "";
    private String currentVideoUrl = "";
    /** 当前处于解析 API 页（地址栏回显原视频链接，与桌面 onNavigated 同步） */
    private boolean onApiPage = false;
    private boolean desktopUa = true;

    // 全屏视频
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        session = BrowserSession.get();
        buildUi();
        applyPayload(getIntent());
        if (session.tabs.isEmpty()) {
            final String first = firstUrl();
            session.tabs.add(new BrowserSession.Tab(first, hostOf(first)));
            session.activeIndex = 0;
        }
        mountTab(session.activeIndex, true);
        renderTabs();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        final int tabsBefore = session.tabs.size();
        applyPayload(intent);
        if (session.tabs.isEmpty()) {
            final String first = firstUrl();
            session.tabs.add(new BrowserSession.Tab(first, hostOf(first)));
            session.activeIndex = 0;
            mountTab(0, true);
        } else if (intent != null && intent.getBooleanExtra("newTab", false)) {
            // 我的影视/页面跳转语义 = 新标签打开（与桌面 openUrl 一致）
            final String url = firstUrl();
            session.tabs.add(new BrowserSession.Tab(url, hostOf(url)));
            session.activeIndex = session.tabs.size() - 1;
            mountTab(session.activeIndex, true);
        } else {
            // resume 语义 = 恢复既有会话：不跳页，保留当前标签/页内状态直接回到前台；
            // 平台选择/导航站点语义 = 当前标签换页（与桌面 navigate 一致）
            final boolean resume = session.lastPayload != null && session.lastPayload.optBoolean("resume", false);
            if (!resume) {
                final String url = firstUrl();
                loadInActive(url);
            }
        }
        if (session.tabs.size() != tabsBefore || !isFinishing()) renderTabs();
    }

    private void applyPayload(Intent intent) {
        if (intent == null) return;
        final String raw = intent.getStringExtra(VoidBridgePlugin.EXTRA_BROWSER_PAYLOAD);
        if (raw == null) return;
        try {
            final JSONObject p = new JSONObject(raw);
            session.lastPayload = p;
            injectCss = p.optString("css", "");
            startUrl = p.optString("url", p.optString("startUrl", "https://v.qq.com"));
            final String m = p.optString("mode", "parse");
            if (!m.isEmpty()) mode = m;
            apiList = p.optJSONArray("apiList") == null ? new JSONArray() : p.optJSONArray("apiList");
            final String av = p.optString("apiValue", "");
            if (!av.isEmpty()) apiValue = av;
            else if (apiList.length() > 0) apiValue = apiList.getJSONObject(0).optString("value", "");
        } catch (Exception ignored) {
        }
    }

    private String firstUrl() {
        return session.lastPayload != null && session.lastPayload.has("url")
                ? session.lastPayload.optString("url", startUrl) : startUrl;
    }

    // ───────────────────────── 界面构建（纯代码，无 XML 布局） ─────────────────────────

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        final LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 标签条
        tabScroll = new HorizontalScrollView(this);
        tabScroll.setHorizontalScrollBarEnabled(false);
        tabScroll.setBackgroundColor(0xFF160d24);
        tabStrip = new LinearLayout(this);
        tabStrip.setOrientation(LinearLayout.HORIZONTAL);
        tabStrip.setGravity(Gravity.CENTER_VERTICAL);
        tabStrip.setPadding(dp(6), dp(4), dp(6), dp(4));
        tabScroll.addView(tabStrip, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        column.addView(tabScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(40)));

        // 工具栏
        final LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(4), dp(6), dp(4));
        bar.setBackgroundColor(0xFF1a1226);

        final LinearLayout.LayoutParams chipParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        chipParams.setMargins(dp(3), 0, dp(3), 0);

        mkBtn(bar, "←", v -> { if (activeWebView != null && activeWebView.canGoBack()) activeWebView.goBack(); }, chipParams);
        mkBtn(bar, "→", v -> { if (activeWebView != null && activeWebView.canGoForward()) activeWebView.goForward(); }, chipParams);
        mkBtn(bar, "⟳", v -> { if (activeWebView != null) activeWebView.reload(); }, chipParams);
        mkBtn(bar, "🏠", v -> loadInActive(startUrl), chipParams);
        uaBtn = mkBtn(bar, "桌面", v -> toggleUa(), chipParams);

        addressBar = new EditText(this);
        addressBar.setSingleLine(true);
        addressBar.setTextSize(13f);
        addressBar.setTextColor(0xFFEEEEEE);
        addressBar.setHintTextColor(0xFF777777);
        addressBar.setBackgroundColor(0xFF2a1e3d);
        addressBar.setPadding(dp(10), dp(6), dp(10), dp(6));
        addressBar.setImeOptions(EditorInfo.IME_ACTION_GO);
        addressBar.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO) { go(); return true; }
            return false;
        });
        final LinearLayout.LayoutParams addrParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        addrParams.setMargins(dp(6), 0, dp(6), 0);
        bar.addView(addressBar, addrParams);

        mkBtn(bar, "解析", v -> triggerParse(), chipParams);
        // 切出：临时离开回主界面（BrowserSession 保留标签与页内状态，主界面「打开浏览器」恢复）
        mkBtn(bar, "切出", v -> finish(), chipParams);
        column.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 进度发丝线
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.getProgressDrawable().setColorFilter(0xFFe8c98a, android.graphics.PorterDuff.Mode.SRC_IN);
        progressBar.setMax(100);
        column.addView(progressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        // WebView 容器
        stack = new FrameLayout(this);
        column.addView(stack, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private TextView mkBtn(LinearLayout bar, String label, View.OnClickListener onClick,
                           LinearLayout.LayoutParams params) {
        final TextView b = new TextView(this);
        b.setText(label);
        b.setTextSize(label.length() > 1 ? 13f : 16f);
        b.setTextColor(0xFFFFFFFF);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(10), dp(6), dp(10), dp(6));
        b.setOnClickListener(onClick);
        bar.addView(b, params);
        return b;
    }

    // ───────────────────────── 标签 ─────────────────────────

    private void renderTabs() {
        tabStrip.removeAllViews();
        final LinearLayout.LayoutParams chipParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(30));
        chipParams.setMargins(dp(3), 0, dp(3), 0);
        for (int i = 0; i < session.tabs.size(); i++) {
            final int idx = i;
            final BrowserSession.Tab t = session.tabs.get(i);
            final LinearLayout chip = new LinearLayout(this);
            chip.setOrientation(LinearLayout.HORIZONTAL);
            chip.setGravity(Gravity.CENTER_VERTICAL);
            chip.setPadding(dp(10), 0, dp(6), 0);
            chip.setBackground(roundedBg(idx == session.activeIndex ? 0xFF141414 : 0xFF0F0F0F,
                    idx == session.activeIndex ? 0xFFe8c98a : 0xFF1E1E1E));
            final TextView title = new TextView(this);
            title.setText(t.title == null || t.title.isEmpty() ? hostOf(t.url) : t.title);
            title.setTextSize(12f);
            title.setTextColor(0xFFEEEEEE);
            title.setMaxWidth(dp(110));
            title.setSingleLine(true);
            chip.addView(title);
            final TextView close = new TextView(this);
            close.setText("×");
            close.setTextSize(14f);
            close.setTextColor(0xFFBBBBBB);
            close.setPadding(dp(6), 0, dp(2), 0);
            close.setOnClickListener(v -> closeTab(idx));
            chip.addView(close);
            chip.setOnClickListener(v -> {
                if (idx != session.activeIndex) {
                    session.activeIndex = idx;
                    mountTab(idx, false);
                    renderTabs();
                }
            });
            tabStrip.addView(chip, chipParams);
        }
        final LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(
                dp(32), dp(30));
        addParams.setMargins(dp(3), 0, dp(3), 0);
        final TextView add = new TextView(this);
        add.setText("+");
        add.setTextSize(16f);
        add.setTextColor(0xFFFFFFFF);
        add.setGravity(Gravity.CENTER);
        add.setBackground(roundedBg(0xFF0F0F0F, 0xFF1E1E1E));
        add.setOnClickListener(v -> newTab());
        tabStrip.addView(add, addParams);
        tabScroll.post(() -> tabScroll.smoothScrollTo(Integer.MAX_VALUE, 0));
    }

    private android.graphics.drawable.Drawable roundedBg(int fill, int stroke) {
        final android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(14));
        d.setStroke(dp(1), stroke);
        return d;
    }

    private void newTab() {
        final BrowserSession.Tab t = new BrowserSession.Tab(startUrl, hostOf(startUrl));
        session.tabs.add(t);
        session.activeIndex = session.tabs.size() - 1;
        mountTab(session.activeIndex, true);
        renderTabs();
    }

    private void closeTab(int idx) {
        if (idx < 0 || idx >= session.tabs.size()) return;
        if (idx == session.activeIndex && activeWebView != null) {
            activeWebView.loadUrl("about:blank");
            activeWebView.removeAllViews();
            activeWebView.destroy();
            stack.removeView(activeWebView);
            activeWebView = null;
        }
        session.tabs.remove(idx);
        if (session.tabs.isEmpty()) {
            session.activeIndex = -1;
            finish();
            return;
        }
        if (session.activeIndex >= session.tabs.size()) session.activeIndex = session.tabs.size() - 1;
        else if (session.activeIndex > idx) session.activeIndex--;
        else if (session.activeIndex == idx) mountTab(session.activeIndex, false);
        renderTabs();
    }

    /** 挂载当前标签的 WebView（每标签独立实例，切标签重建，登录态由全局 Cookie 保持） */
    @SuppressLint("SetJavaScriptEnabled")
    private void mountTab(int idx, boolean load) {
        final BrowserSession.Tab t = session.tabs.get(idx);
        // 卸载旧 WebView
        if (activeWebView != null) {
            final String lastUrl = activeWebView.getUrl();
            if (lastUrl != null) t.url = lastUrl;
            activeWebView.onPause();
            stack.removeView(activeWebView);
            activeWebView = null;
        }
        final WebView wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        wv.setBackgroundColor(0xFF000000);
        stack.addView(wv);
        activeWebView = wv;
        configureWebView(wv);
        final String target = load ? t.url : (t.url == null ? startUrl : t.url);
        wv.loadUrl(target);
        addressBar.setText(target);
        currentVideoUrl = onApiPageOf(target) ? currentVideoUrl : target;
        onApiPage = onApiPageOf(target);
        // 站点 CSS 注入
        injectCss(wv);
    }

    // ───────────────────────── WebView 配置 ─────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView wv) {
        final WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        applyUa(s);
        // 桌面 UA 下按视口宽度对齐桌面理想宽度（与桌面 updateZoomFactor w/1400 同思路）
        final int w = getResources().getDisplayMetrics().widthPixels;
        if (desktopUa && w > 0) wv.setInitialScale(Math.max(33, Math.min(100, Math.round(w / 1400f * 100))));

        final CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        try {
            cm.setAcceptThirdPartyCookies(wv, true);
        } catch (Exception ignored) {
        }

        wv.setWebViewClient(new LgvWebViewClient());
        wv.setWebChromeClient(new LgvWebChromeClient());
        wv.setDownloadListener(new DownloadHandler());
    }

    private void applyUa(WebSettings s) {
        s.setUserAgentString(desktopUa ? DESKTOP_UA : null);
    }

    private void toggleUa() {
        desktopUa = !desktopUa;
        uaBtn.setText(desktopUa ? "桌面" : "手机");
        if (activeWebView != null) {
            applyUa(activeWebView.getSettings());
            final int w = getResources().getDisplayMetrics().widthPixels;
            if (desktopUa && w > 0) {
                activeWebView.setInitialScale(Math.max(33, Math.min(100, Math.round(w / 1400f * 100))));
            } else {
                activeWebView.setInitialScale(0);
            }
            activeWebView.reload();
        }
    }

    private void injectCss(WebView wv) {
        if (injectCss == null || injectCss.isEmpty()) return;
        final String js = "(function(){var s=document.createElement('style');s.textContent="
                + jsString(injectCss) + ";document.head.appendChild(s);})()";
        wv.evaluateJavascript(js, null);
    }

    // ───────────────────────── 导航 / 解析 ─────────────────────────

    private boolean onApiPageOf(String url) {
        if (url == null) return false;
        for (int i = 0; i < apiList.length(); i++) {
            final String v = apiList.optJSONObject(i) == null ? ""
                    : apiList.optJSONObject(i).optString("value", "");
            if (!v.isEmpty() && url.startsWith(v)) return true;
        }
        return false;
    }

    private void loadInActive(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
        if (activeWebView != null) activeWebView.loadUrl(url);
    }

    private void go() {
        String input = addressBar.getText().toString().trim();
        if (input.isEmpty()) { loadInActive(startUrl); return; }
        // 地址栏回显原视频链接时（解析 API 页），直接按普通导航处理
        if (!input.startsWith("http://") && !input.startsWith("https://")) {
            input = "https://" + input;
        }
        loadInActive(input);
    }

    /** 解析 = loadURL(接口 + 当前视频链接)，与桌面 triggerParse 等价 */
    private void triggerParse() {
        if (currentVideoUrl == null || currentVideoUrl.isEmpty()) {
            Toast.makeText(this, "请先打开具体视频页面，再点击解析。", Toast.LENGTH_SHORT).show();
            return;
        }
        String api = apiValue;
        if ((api == null || api.isEmpty()) && apiList.length() > 0) {
            api = apiList.optJSONObject(0).optString("value", "");
        }
        if (api == null || api.isEmpty()) {
            Toast.makeText(this, "未配置解析接口，请前往设置页添加。", Toast.LENGTH_SHORT).show();
            return;
        }
        onApiPage = true;
        if (activeWebView != null) activeWebView.loadUrl(api + currentVideoUrl);
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "无法打开该链接", Toast.LENGTH_LONG).show();
        }
    }

    // ───────────────────────── WebViewClient ─────────────────────────

    private class LgvWebViewClient extends WebViewClient {
        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url.startsWith("http://") || url.startsWith("https://")) return false;
            openExternal(url);
            return true;
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            injectCss(view);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (url == null || "about:blank".equals(url)) return;
            final int idx = session.activeIndex;
            if (idx >= 0 && idx < session.tabs.size()) session.tabs.get(idx).url = url;
            // 解析 API 页地址栏回显原视频链接（与桌面 onNavigated 一致）
            if (onApiPageOf(url)) {
                addressBar.setText(currentVideoUrl);
            } else {
                addressBar.setText(url);
                currentVideoUrl = url;
                onApiPage = false;
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                Toast.makeText(BrowserActivity.this, "页面加载失败，请检查网络后重试", Toast.LENGTH_LONG).show();
            }
        }
    }

    // ───────────────────────── WebChromeClient ─────────────────────────

    private class LgvWebChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            final int idx = session.activeIndex;
            if (idx >= 0 && idx < session.tabs.size() && title != null && !title.isEmpty()) {
                session.tabs.get(idx).title = title;
                renderTabs();
            }
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(BrowserActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(BrowserActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                  final android.webkit.JsPromptResult result) {
            final EditText input = new EditText(BrowserActivity.this);
            input.setText(defaultValue);
            new AlertDialog.Builder(BrowserActivity.this)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("确定", (d, w) -> result.confirm(input.getText().toString()))
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        /** target=_blank / window.open → 本页打开（与桌面 NAV_OVERRIDE_SCRIPT 同效） */
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                      Message resultMsg) {
            final WebView temp = new WebView(view.getContext());
            temp.setWebViewClient(new WebViewClient() {
                @SuppressWarnings("deprecation")
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    if (url.startsWith("http://") || url.startsWith("https://")) loadInActive(url);
                    else openExternal(url);
                    return true;
                }
            });
            final WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(temp);
            resultMsg.sendToTarget();
            return true;
        }

        // ── 全屏视频（流畅适配核心）：沉浸 + 横屏 ──
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreenContainer = new FrameLayout(BrowserActivity.this);
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

    // ───────────────────────── 下载接管 ─────────────────────────

    private class DownloadHandler implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                Toast.makeText(BrowserActivity.this,
                        "该文件为页面内生成数据，请在网页内直接播放或换用系统浏览器", Toast.LENGTH_LONG).show();
                return;
            }
            try {
                final String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                final DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                final String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) req.addRequestHeader("Cookie", cookie);
                if (userAgent != null && !userAgent.isEmpty()) req.addRequestHeader("User-Agent", userAgent);
                final String referer = activeWebView != null ? activeWebView.getUrl() : null;
                if (referer != null) req.addRequestHeader("Referer", referer);
                if (mimeType != null && !mimeType.isEmpty()) req.setMimeType(mimeType);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                req.setTitle(name);
                final DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(req);
                Toast.makeText(BrowserActivity.this, "开始下载：" + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(BrowserActivity.this,
                        "下载失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()), Toast.LENGTH_LONG).show();
            }
        }
    }

    /** JSON 字符串字面量（含引号），安全内联进 evaluateJavascript */
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

    private static String hostOf(String url) {
        try {
            return new URL(url).getHost();
        } catch (Exception e) {
            return url == null ? "" : url;
        }
    }

    // ───────────────────────── 生命周期 ─────────────────────────

    @Override
    public void onBackPressed() {
        if (customView != null) { exitFullscreen(); return; }
        if (activeWebView != null && activeWebView.canGoBack()) { activeWebView.goBack(); return; }
        if (session.tabs.size() > 1) { closeTab(session.activeIndex); return; }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (activeWebView != null && customView == null) activeWebView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        if (activeWebView != null) activeWebView.onResume();
        super.onResume();
    }

    @Override
    protected void onDestroy() {
        exitFullscreen();
        if (activeWebView != null) {
            activeWebView.loadUrl("about:blank");
            activeWebView.removeAllViews();
            activeWebView.destroy();
            activeWebView = null;
        }
        if (stack != null) stack.removeAllViews();
        super.onDestroy();
    }
}
