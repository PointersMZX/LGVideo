package com.lg.video;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 双渠道更新检查（GitHub 官方 / Gitee 镜像），端点与桌面更新器一致。
 * Android 只做「发现新版本 → 外部浏览器拉 APK」，不做应用内下载安装。
 */
public final class UpdateChecker {

    private static final String GITHUB_API =
            "https://api.github.com/repos/PointersMZX/LGVideo/releases/latest";
    private static final String GITEE_API =
            "https://gitee.com/api/v5/repos/PointersMZX/LGVideo/releases/latest";

    private UpdateChecker() {}

    /** 拉取最新 release JSON；失败返回 null */
    public static JSONObject fetchLatest(String channel) {
        try {
            final String url = "gitee".equals(channel) ? GITEE_API : GITHUB_API;
            final String body = httpGet(url);
            return body == null ? null : new JSONObject(body);
        } catch (Exception e) {
            return null;
        }
    }

    /** 语义化版本比较：latest > current 才算有新版本（tag 允许带 v 前缀） */
    public static boolean isNewer(String latestTag, String current) {
        final int[] l = parseVersion(latestTag);
        final int[] c = parseVersion(current);
        for (int i = 0; i < 3; i++) {
            if (l[i] != c[i]) return l[i] > c[i];
        }
        return false;
    }

    /** 在 release assets 里找安卓安装包直链（universal / 任意 apk） */
    public static String findApkUrl(JSONObject release, String channel) {
        try {
            final JSONArray assets = release.optJSONArray("assets");
            if (assets == null) return null;
            String fallback = null;
            for (int i = 0; i < assets.length(); i++) {
                final JSONObject a = assets.getJSONObject(i);
                final String name = a.optString("name", "").toLowerCase();
                final String url = "gitee".equals(channel)
                        ? a.optString("browser_download_url", "")
                        : a.optString("browser_download_url", "");
                if (!name.endsWith(".apk")) continue;
                if (name.contains("universal")) return url;
                if (fallback == null) fallback = url;
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    public static String stripV(String tag) {
        return tag == null ? "" : tag.replaceFirst("^v", "");
    }

    private static int[] parseVersion(String raw) {
        final int[] out = new int[]{0, 0, 0};
        if (raw == null) return out;
        final String v = stripV(raw.trim()).replaceFirst("[+~-].*$", "");
        final String[] parts = v.split("\\.");
        for (int i = 0; i < Math.min(3, parts.length); i++) {
            try {
                out[i] = Integer.parseInt(parts[i].trim());
            } catch (Exception e) {
                final StringBuilder digits = new StringBuilder();
                for (char ch : parts[i].toCharArray()) {
                    if (Character.isDigit(ch)) digits.append(ch);
                    else break;
                }
                if (digits.length() > 0) {
                    try { out[i] = Integer.parseInt(digits.toString()); } catch (Exception ignored) {}
                }
            }
        }
        return out;
    }

    private static String httpGet(String urlStr) {
        HttpURLConnection conn = null;
        try {
            final URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            // GitHub API 要求 UA
            conn.setRequestProperty("User-Agent", "LGVideo-Android/" + "1.2.0");
            final int code = conn.getResponseCode();
            if (code != 200) return null;
            final InputStream in = conn.getInputStream();
            final ByteArrayOutputStream bos = new ByteArrayOutputStream();
            final byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
