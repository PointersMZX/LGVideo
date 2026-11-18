package com.lg.video;

import android.content.Context;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * SAF 目录树扫描（对应桌面 scanVideoDir）：递归找视频文件，
 * 输出形状与桌面一致 { path, name, ext, size, mtime }。
 * dir 为 SAF tree URI 字符串（openDirsDialog 持久授权后保存的值）。
 */
public final class LocalScanner {

    private static final String[] VIDEO_EXTS = {
            "mp4", "mkv", "webm", "mov", "m4v", "avi", "flv", "ts", "m2ts", "3gp", "mpg", "mpeg"
    };
    private static final int SCAN_CAP = 10000;
    private static final int MAX_DEPTH = 6;

    private LocalScanner() {}

    public static JSONArray scan(Context ctx, String dir) {
        final List<JSONObject> out = new ArrayList<>();
        try {
            final Uri tree = Uri.parse(dir);
            final DocumentFile root = DocumentFile.fromTreeUri(ctx, tree);
            if (root != null && root.exists()) {
                walk(root, 0, out);
                Collections.sort(out, (a, b) -> a.optString("path", "")
                        .compareToIgnoreCase(b.optString("path", "")));
            }
        } catch (Exception ignored) {
        }
        final JSONArray arr = new JSONArray();
        for (JSONObject o : out) arr.put(o);
        return arr;
    }

    private static void walk(DocumentFile dir, int depth, List<JSONObject> out) {
        if (depth > MAX_DEPTH || out.size() >= SCAN_CAP) return;
        try {
            for (DocumentFile f : dir.listFiles()) {
                if (out.size() >= SCAN_CAP) return;
                final String name = f.getName() == null ? "" : f.getName();
                if (name.startsWith(".")) continue;
                if (f.isDirectory()) {
                    walk(f, depth + 1, out);
                } else if (f.isFile()) {
                    final int dot = name.lastIndexOf('.');
                    if (dot < 0) continue;
                    final String ext = name.substring(dot + 1).toLowerCase();
                    if (!isVideoExt(ext)) continue;
                    final JSONObject o = new JSONObject();
                    o.put("path", f.getUri().toString());
                    o.put("name", name);
                    o.put("ext", ext);
                    o.put("size", f.length());
                    o.put("mtime", f.lastModified());
                    out.add(o);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean isVideoExt(String ext) {
        for (String e : VIDEO_EXTS) {
            if (e.equals(ext)) return true;
        }
        return false;
    }
}
