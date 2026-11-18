package com.lg.video;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Android 壳的 voidAPI 全量原生实现（对应桌面 preload-ui.js 的 30+ 个桥接方法）。
 *
 * 传输约定：所有载荷一律 JSON 字符串过桥（data 字段），与 platform-bridge.js 对齐——
 * 统一字符串避开 Capacitor 桥对混合类型参数的序列化差异。
 *
 * 持久层：filesDir 下 settings.json / library.json / positions.json，
 * 形状与桌面 userData 同源（settings:set 同样做 player/browser 子对象深合并）。
 */
@CapacitorPlugin(name = "VoidBridge")
public class VoidBridgePlugin extends Plugin {

    public static final String EXTRA_BROWSER_PAYLOAD = "browserPayload";
    public static final String EXTRA_PLAYER_PAYLOAD = "playerPayload";

    private JsonStore store;
    /** update:check 暂存的最新版 APK 直链（downloadUpdate 使用） */
    private String pendingApkUrl = "";

    @Override
    public void load() {
        store = new JsonStore(getContext());
        super.load();
    }

    // ───────────────────────── 载荷工具 ─────────────────────────

    private static JSONObject payload(PluginCall call) {
        try {
            final String raw = call.getString("data");
            if (raw == null || raw.isEmpty()) return new JSONObject();
            return new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void resolveJson(PluginCall call, Object value) {
        final JSObject ret = new JSObject();
        if (value == null || value == JSONObject.NULL) {
            ret.put("data", "null");
        } else if (value instanceof String) {
            // 字符串必须 JSON 编码（quote 加引号转义），否则 "1.2.0" 这类值在 JS 端 JSON.parse 抛错
            ret.put("data", JSONObject.quote(value.toString()));
        } else {
            ret.put("data", value.toString());
        }
        call.resolve(ret);
    }

    private static void resolveOk(PluginCall call) {
        final JSObject ret = new JSObject();
        ret.put("data", "null");
        call.resolve(ret);
    }

    // ───────────────────────── 窗口控制 ─────────────────────────

    @PluginMethod
    public void minimizeWindow(PluginCall call) {
        final Activity a = bridge.getActivity();
        if (a != null) a.moveTaskToBack(true);
        resolveOk(call);
    }

    // ───────────────────────── 设置 / 影视库 / 播放进度 ─────────────────────────

    @PluginMethod
    public void getSettings(PluginCall call) {
        resolveJson(call, store.readSettings());
    }

    /** 与桌面 settings:set 同语义：浅合并 + player/browser 子对象深合并 */
    @PluginMethod
    public void setSettings(PluginCall call) {
        final JSONObject next;
        try {
            final JSONObject current = store.readSettings();
            final JSONObject patch = payload(call);
            final Iterator<String> keys = patch.keys();
            while (keys.hasNext()) {
                final String k = keys.next();
                final Object v = patch.opt(k);
                if ("player".equals(k) && v instanceof JSONObject && current.opt(k) instanceof JSONObject) {
                    final JSONObject merged = new JSONObject(current.getJSONObject(k).toString());
                    final JSONObject sub = (JSONObject) v;
                    final Iterator<String> sk = sub.keys();
                    while (sk.hasNext()) {
                        final String skk = sk.next();
                        try { merged.put(skk, sub.get(skk)); } catch (Exception ignored) {}
                    }
                    current.put(k, merged);
                } else {
                    current.put(k, v);
                }
            }
            store.write("settings.json", current.toString());
            next = current;
        } catch (Exception e) {
            call.reject("settings 写入失败：" + e.getMessage());
            return;
        }
        resolveJson(call, next);
    }

    @PluginMethod
    public void getLibrary(PluginCall call) {
        resolveJson(call, store.readArray("library.json"));
    }

    @PluginMethod
    public void setLibrary(PluginCall call) {
        final JSONArray items = optArray(payload(call), "0");
        store.write("library.json", items.toString());
        resolveJson(call, items);
    }

    @PluginMethod
    public void getPosition(PluginCall call) {
        final JSONObject positions = store.readObject("positions.json", new JSONObject());
        final String file = optString(payload(call), "0");
        final Object pos = file == null ? null : positions.opt(file);
        resolveJson(call, pos == null ? JSONObject.NULL : pos);
    }

    @PluginMethod
    public void setPosition(PluginCall call) {
        final JSONObject p = payload(call);
        final String file = optString(p, "0");
        if (file == null || file.isEmpty()) { resolveOk(call); return; }
        final JSONObject positions = store.readObject("positions.json", new JSONObject());
        try {
            final Object pos = p.opt("1");
            positions.put(file, pos == null ? JSONObject.NULL : pos);
            store.write("positions.json", positions.toString());
        } catch (Exception ignored) {}
        resolveOk(call);
    }

    @PluginMethod
    public void clearPosition(PluginCall call) {
        final String file = optString(payload(call), "0");
        if (file != null) {
            final JSONObject positions = store.readObject("positions.json", new JSONObject());
            positions.remove(file);
            store.write("positions.json", positions.toString());
        }
        resolveOk(call);
    }

    // ───────────────────────── 本地视频（SAF 扫描 / 选择） ─────────────────────────

    @PluginMethod
    public void scanDir(PluginCall call) {
        final String dir = optString(payload(call), "0");
        resolveJson(call, LocalScanner.scan(getContext(), dir));
    }

    @PluginMethod
    public void scanDirs(PluginCall call) {
        final JSONArray arr = optArray(payload(call), "0");
        final JSONArray out = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            final String d = arr.optString(i, null);
            final JSONArray part = LocalScanner.scan(getContext(), d);
            for (int j = 0; j < part.length(); j++) out.put(part.opt(j));
        }
        resolveJson(call, out);
    }

    /** SAF 选择视频文件（可多选）；授权持久化后回传 URI 字符串数组 */
    @PluginMethod
    public void openFileDialog(PluginCall call) {
        call.save();
        final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "onFilesPicked");
        } catch (Exception e) {
            call.reject("无法打开文件选择器");
        }
    }

    /** SAF 选择目录（单次一个，与桌面多选语义差异：用户可反复添加） */
    @PluginMethod
    public void openDirsDialog(PluginCall call) {
        call.save();
        final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "onDirsPicked");
        } catch (Exception e) {
            call.reject("无法打开目录选择器");
        }
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void onFilesPicked(PluginCall call, Intent data, int resultCode) {
        final JSONArray out = new JSONArray();
        if (resultCode == Activity.RESULT_OK && data != null) {
            if (data.getData() != null) out.put(data.getData().toString());
            final android.content.ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    final Uri u = clip.getItemAt(i).getUri();
                    if (u != null) out.put(u.toString());
                }
            }
            persistGrants(data);
        }
        resolveJson(call, out);
    }

    @com.getcapacitor.annotation.ActivityCallback
    private void onDirsPicked(PluginCall call, Intent data, int resultCode) {
        final JSONArray out = new JSONArray();
        if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
            out.put(data.getData().toString());
            persistGrants(data);
        }
        resolveJson(call, out);
    }

    private void persistGrants(Intent data) {
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    data.getData(),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {
        }
        final android.content.ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                try {
                    getContext().getContentResolver().takePersistableUriPermission(
                            clip.getItemAt(i).getUri(),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {
                }
            }
        }
    }

    // ───────────────────────── 其它 ─────────────────────────

    @PluginMethod
    public void getVersion(PluginCall call) {
        resolveJson(call, versionName());
    }

    /** 头像选择：Android 暂不支持头像自传，恒返回空串（设置页提示文案） */
    @PluginMethod
    public void pickAvatar(PluginCall call) {
        resolveJson(call, "");
    }

    private String versionName() {
        try {
            return getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.2.0";
        }
    }

    @PluginMethod
    public void openExternalLink(PluginCall call) {
        final String url = optString(payload(call), "0");
        if (url == null || url.isEmpty()) { resolveOk(call); return; }
        try {
            final Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception ignored) {}
        resolveOk(call);
    }

    @PluginMethod
    public void resetBrowserSession(PluginCall call) {
        final CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        BrowserSession.get().reset();
        resolveOk(call);
    }

    @PluginMethod
    public void openPlayerWindow(PluginCall call) {
        final JSONObject payload = payload(call);
        final Intent intent = new Intent(getContext(), PlayerActivity.class);
        intent.putExtra(EXTRA_PLAYER_PAYLOAD, payload.toString());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception ignored) {}
        resolveOk(call);
    }

    @PluginMethod
    public void openBrowser(PluginCall call) {
        final JSONObject payload = payload(call);
        final Intent intent = new Intent(getContext(), BrowserActivity.class);
        intent.putExtra(EXTRA_BROWSER_PAYLOAD, payload.toString());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (Exception ignored) {}
        resolveOk(call);
    }

    // ───────────────────────── 双渠道更新（GitHub / Gitee） ─────────────────────────

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        final String channel = readUpdateChannel();
        final Thread t = new Thread(() -> {
            try {
                final JSONObject release = UpdateChecker.fetchLatest(channel);
                if (release == null) {
                    emitUpdateEvent(errEvent("无法连接更新服务器，请检查网络"));
                    resolveOk(call);
                    return;
                }
                final String latest = release.optString("tag_name", "");
                final String current = versionName();
                final boolean hasUpdate = UpdateChecker.isNewer(latest, current);
                if (hasUpdate) {
                    pendingApkUrl = UpdateChecker.findApkUrl(release, channel);
                }
                final JSONObject evt = new JSONObject();
                evt.put("type", "result");
                evt.put("hasUpdate", hasUpdate);
                evt.put("latest", UpdateChecker.stripV(latest));
                evt.put("current", current);
                evt.put("notes", release.optString("body", ""));
                emitUpdateEvent(evt);
            } catch (Exception e) {
                emitUpdateEvent(errEvent("更新检查失败：" + e.getMessage()));
            }
            resolveOk(call);
        });
        t.setName("lgv-update-check");
        t.start();
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        final String url = pendingApkUrl;
        if (url == null || url.isEmpty()) {
            emitUpdateEvent(errEvent("请先检查更新"));
        } else {
            try {
                final Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception e) {
                emitUpdateEvent(errEvent("无法打开下载页：" + e.getMessage()));
            }
        }
        resolveOk(call);
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        emitUpdateEvent(errEvent("安卓版请从下载页获取安装包后安装"));
        resolveOk(call);
    }

    @PluginMethod
    public void onPageNavigate(PluginCall call) {
        resolveOk(call);
    }

    // ───────────────────────── 工具 ─────────────────────────

    private String readUpdateChannel() {
        // Android 渠道固定 GitHub（与 Pointers-BOX v2.6.0 一致；网盘只做手动下载入口）
        return "github";
    }

    private static JSONObject errEvent(String message) {
        final JSONObject evt = new JSONObject();
        try {
            evt.put("type", "error");
            evt.put("message", message == null ? "未知错误" : message);
        } catch (Exception ignored) {
        }
        return evt;
    }

    private void emitUpdateEvent(JSONObject evt) {
        final JSObject data = new JSObject();
        data.put("data", evt.toString());
        notifyListeners("updateEvent", data);
    }

    private static JSONArray optArray(JSONObject obj, String fallbackKey) {
        final JSONArray direct = obj.optJSONArray("data");
        if (direct != null) return direct;
        final Object v = obj.opt(fallbackKey);
        return v instanceof JSONArray ? (JSONArray) v : new JSONArray();
    }

    private static String optString(JSONObject obj, String fallbackKey) {
        if (obj.has("data")) {
            final Object v = obj.opt("data");
            if (v instanceof String) return (String) v;
            if (v != null && JSONObject.NULL != v) return v.toString();
        }
        final Object v = obj.opt(fallbackKey);
        return v instanceof String ? (String) v : (v == null ? null : v.toString());
    }
}
