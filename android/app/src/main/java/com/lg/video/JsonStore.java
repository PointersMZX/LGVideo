package com.lg.video;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * JSON 持久层（settings.json / library.json / positions.json）。
 * 与桌面端同形状：userData 对应 Android filesDir；原子写（tmp + rename）。
 */
public final class JsonStore {

    private final Context ctx;

    public JsonStore(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /**
     * 读取设置：与桌面 getSettings 同语义——文件缺失/字段缺失用 DEFAULT_SETTINGS 兜底，
     * player/browser 子对象深合并。桌面端 apiList 等默认值驱动浏览器页初始化，
     * Android 缺这层兜底会让渲染层 init 抛错（冒烟实测）。
     */
    public JSONObject readSettings() {
        final JSONObject stored = readObject("settings.json", new JSONObject());
        try {
            final JSONObject defaults = new JSONObject(DEFAULT_SETTINGS);
            final JSONObject merged = new JSONObject(defaults.toString());
            final java.util.Iterator<String> keys = stored.keys();
            while (keys.hasNext()) {
                final String k = keys.next();
                merged.put(k, stored.get(k));
            }
            merged.put("player", deepMerge(defaults.getJSONObject("player"), stored.optJSONObject("player")));
            merged.put("browser", deepMerge(defaults.getJSONObject("browser"), stored.optJSONObject("browser")));
            return merged;
        } catch (Exception e) {
            return stored;
        }
    }

    private static JSONObject deepMerge(JSONObject base, JSONObject patch) {
        final JSONObject out = new JSONObject();
        try {
            final java.util.Iterator<String> b = base.keys();
            while (b.hasNext()) {
                final String k = b.next();
                out.put(k, base.get(k));
            }
            if (patch != null) {
                final java.util.Iterator<String> p = patch.keys();
                while (p.hasNext()) {
                    final String k = p.next();
                    out.put(k, patch.get(k));
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    /** 与桌面 main.js DEFAULT_SETTINGS 同源（apiList/浏览器起始页/主题/开发者等） */
    private static final String DEFAULT_SETTINGS = "{"
            + "\"localDirs\":[],"
            + "\"theme\":\"dark\","
            + "\"themeAccent\":\"#8b30d6\","
            + "\"localUser\":{},"
            + "\"devMode\":false,"
            + "\"autoCheckUpdate\":false,"
            + "\"themeId\":\"xingyu\","
            + "\"customThemes\":[],"
            + "\"player\":{\"mode\":\"overlay\",\"autoNext\":true,\"rememberPos\":true},"
            + "\"browser\":{\"sleepMinutes\":0,\"startUrl\":\"https://v.qq.com\"},"
            + "\"apiList\":["
            + "{\"value\":\"https://jx.xmflv.com/?url=\",\"label\":\"虾米视频解析\"},"
            + "{\"value\":\"https://jx.77flv.cc/?url=\",\"label\":\"七七云解析\"},"
            + "{\"value\":\"https://jx.playerjy.com/?url=\",\"label\":\"Player-JY\"},"
            + "{\"value\":\"https://jiexi.789jiexi.icu:4433/?url=\",\"label\":\"789解析\"},"
            + "{\"value\":\"https://jx.2s0.cn/player/?url=\",\"label\":\"极速解析\"},"
            + "{\"value\":\"https://bd.jx.cn/?url=\",\"label\":\"冰豆解析\"},"
            + "{\"value\":\"https://jx.973973.xyz/?url=\",\"label\":\"973解析\"},"
            + "{\"value\":\"https://www.ckplayer.vip/jiexi/?url=\",\"label\":\"CK\"},"
            + "{\"value\":\"https://jx.nnxv.cn/tv.php?url=\",\"label\":\"七哥解析\"},"
            + "{\"value\":\"https://www.yemu.xyz/?url=\",\"label\":\"夜幕\"},"
            + "{\"value\":\"https://www.pangujiexi.com/jiexi/?url=\",\"label\":\"盘古\"},"
            + "{\"value\":\"https://www.playm3u8.cn/jiexi.php?url=\",\"label\":\"playm3u8\"},"
            + "{\"value\":\"https://video.isyour.love/player/getplayer?url=\",\"label\":\"芒果TV1\"},"
            + "{\"value\":\"https://im1907.top/?jx=\",\"label\":\"芒果TV2\"},"
            + "{\"value\":\"https://jx.hls.one/?url=\",\"label\":\"HLS解析\"}"
            + "],"
            + "\"dramaSites\":[],"
            + "\"agreedPact\":false"
            + "}";

    public JSONObject readObject(String name, JSONObject fallback) {
        try {
            return new JSONObject(read(name));
        } catch (Exception e) {
            return fallback;
        }
    }

    public JSONArray readArray(String name) {
        try {
            return new JSONArray(read(name));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public void write(String name, String content) {
        try {
            final File dir = ctx.getFilesDir();
            if (!dir.exists()) dir.mkdirs();
            final File target = new File(dir, name);
            final File tmp = new File(dir, name + ".tmp");
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(content.getBytes(StandardCharsets.UTF_8));
                fos.flush();
            }
            if (!tmp.renameTo(target)) {
                // 个别文件系统 rename 跨句柄失败：退回直接写
                try (FileOutputStream fos = new FileOutputStream(target)) {
                    fos.write(content.getBytes(StandardCharsets.UTF_8));
                    fos.flush();
                }
                tmp.delete();
            }
        } catch (Exception ignored) {
        }
    }

    private String read(String name) throws Exception {
        final File f = new File(ctx.getFilesDir(), name);
        final byte[] buf = new byte[(int) f.length()];
        try (FileInputStream fis = new FileInputStream(f)) {
            int off = 0;
            while (off < buf.length) {
                final int n = fis.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        return new String(buf, StandardCharsets.UTF_8);
    }
}
