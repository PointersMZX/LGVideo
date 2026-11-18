package com.lg.video;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 内嵌浏览器标签状态（Application 级单例）：
 * WebView 随 Activity 生命周期销毁重建，标签 URL/标题由这里持有，
 * 登录态靠全局 CookieManager + WebStorage 保持——与桌面「标签休眠回原地址」同体验。
 */
public class BrowserSession {

    public static class Tab {
        public String url;
        public String title;
        public Tab(String url, String title) {
            this.url = url;
            this.title = title;
        }
    }

    private static BrowserSession instance;

    public static BrowserSession get() {
        if (instance == null) instance = new BrowserSession();
        return instance;
    }

    public final List<Tab> tabs = new ArrayList<>();
    public int activeIndex = -1;

    /** 最近一次唤起参数（解析接口列表 / 站点 CSS 等，随 openBrowser 刷新） */
    public JSONObject lastPayload = null;

    public synchronized void reset() {
        tabs.clear();
        activeIndex = -1;
        lastPayload = null;
    }

    public synchronized Tab activeTab() {
        if (activeIndex >= 0 && activeIndex < tabs.size()) return tabs.get(activeIndex);
        return null;
    }

    public synchronized JSONArray toJson() {
        final JSONArray arr = new JSONArray();
        for (Tab t : tabs) {
            try {
                final JSONObject o = new JSONObject();
                o.put("url", t.url);
                o.put("title", t.title);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr;
    }
}
