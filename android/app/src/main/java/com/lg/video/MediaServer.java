package com.lg.video;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 本地媒体流服务器（127.0.0.1，应用内随机端口）。
 *
 * 为什么不用 WebViewClient.shouldInterceptRequest 拦截流（冒烟实测结论）：
 * Chromium 对拦截流的 Range 处理有硬限制——Range start 越过 2MB 后响应一律
 * net::ERR_FAILED（无论 200 全量流是否正常），媒体栈读 moov 尾部永远失败。
 * 真实 HTTP 服务器原生处理 Range 没有这些怪癖，是 WebView 本地视频的成熟做法。
 *
 * 协议：GET /media/<id> → 流式返回注册的文件/内容 URI，支持 Range（206）。
 * 明文回环经 network_security_config 仅对 127.0.0.1/localhost 放行。
 */
public final class MediaServer {

    private static final String TAG = "LGVServer";

    public interface SourceResolver {
        /** 由 id 取实际来源（file 路径或 content:// URI），无则 null */
        String resolve(String id);
    }

    private final android.content.Context ctx;
    private final SourceResolver resolver;
    private ServerSocket serverSocket;
    private Thread acceptThread;
    private int port = -1;

    public MediaServer(android.content.Context ctx, SourceResolver resolver) {
        this.ctx = ctx.getApplicationContext();
        this.resolver = resolver;
    }

    /** 启动并返回端口；失败返回 -1 */
    public synchronized int start() {
        if (port > 0) return port;
        try {
            serverSocket = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"));
            port = serverSocket.getLocalPort();
            acceptThread = new Thread(this::acceptLoop, "LGV-MediaServer");
            acceptThread.setDaemon(true);
            acceptThread.start();
            return port;
        } catch (Exception e) {
            stop();
            return -1;
        }
    }

    public synchronized void stop() {
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Exception ignored) {
        }
        serverSocket = null;
        port = -1;
    }

    private void acceptLoop() {
        while (true) {
            final ServerSocket ss = serverSocket;
            if (ss == null || ss.isClosed()) return;
            try {
                final Socket socket = ss.accept();
                final Thread t = new Thread(() -> handle(socket), "LGV-MediaConn");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) {
                return; // socket 关闭
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(30000);
            final java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
            final String requestLine = reader.readLine();
            if (requestLine == null || !requestLine.startsWith("GET ")) return;
            String path = requestLine.split(" ")[1];
            // 解析 Range 头
            String rangeHeader = null;
            String line;
            long maxBody = -1;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                final int colon = line.indexOf(':');
                if (colon <= 0) continue;
                final String name = line.substring(0, colon).trim().toLowerCase();
                final String value = line.substring(colon + 1).trim();
                if ("range".equals(name)) rangeHeader = value;
                // 媒体栈可能声明很大的预期读长；仅用于日志
                if ("content-length".equals(name)) {
                    try { maxBody = Long.parseLong(value); } catch (Exception ignored) {}
                }
            }
            if (!path.startsWith("/media/")) {
                writeEmpty(socket, 404, "Not Found");
                return;
            }
            final String id = URLDecoder.decode(path.substring("/media/".length()), "UTF-8");
            final String source = resolver.resolve(id);
            if (source == null) {
                writeEmpty(socket, 404, "Not Found");
                return;
            }
            streamSource(socket, source, rangeHeader);
        } catch (Exception e) {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void streamSource(Socket socket, String source, String rangeHeader) throws IOException {
        InputStream raw = null;
        try {
            final long total;
            if (source.startsWith("content://")) {
                final ParcelFileDescriptor pfd = openContent(source);
                if (pfd == null) { writeEmpty(socket, 404, "Not Found"); return; }
                total = pfd.getStatSize();
                raw = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
            } else {
                final File f = new File(source);
                if (!f.exists()) { writeEmpty(socket, 404, "Not Found"); return; }
                total = f.length();
                raw = new FileInputStream(f);
            }
            final long[] range = parseRange(rangeHeader);
            final long start = range[0];
            final long end = range[1] >= 0 ? Math.min(range[1], total - 1) : total - 1;
            if (start >= total || start > end) {
                // 不可满足区间：416 + 有效范围提示
                writeRangeUnsatisfiable(socket, total);
                try { raw.close(); } catch (Exception ignored) {}
                return;
            }
            skipFully(raw, start);
            final long length = end - start + 1;
            final OutputStream out = socket.getOutputStream();
            final StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(range[0] > 0 || range[1] >= 0 ? "206 Partial Content" : "200 OK").append("\r\n");
            head.append("Content-Type: ").append(guessMime(source)).append("\r\n");
            head.append("Content-Length: ").append(length).append("\r\n");
            head.append("Accept-Ranges: bytes\r\n");
            if (range[0] > 0 || range[1] >= 0) {
                head.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(total).append("\r\n");
            }
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
            out.flush();
            copyLimited(raw, out, length);
            out.flush();
        } catch (Exception e) {
            // 客户端中断属正常（seek 时旧连接被丢弃）
        } finally {
            try { if (raw != null) raw.close(); } catch (Exception ignored) {}
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private ParcelFileDescriptor openContent(String source) {
        try {
            return ctx.getContentResolver().openFileDescriptor(Uri.parse(source), "r");
        } catch (Exception e) {
            return null;
        }
    }

    private static void copyLimited(InputStream in, OutputStream out, long length) throws IOException {
        final byte[] buf = new byte[64 * 1024];
        long remaining = length;
        while (remaining > 0) {
            final int want = (int) Math.min(buf.length, remaining);
            final int n = in.read(buf, 0, want);
            if (n < 0) break;
            out.write(buf, 0, n);
            remaining -= n;
        }
    }

    private static void skipFully(InputStream in, long count) throws IOException {
        long remaining = count;
        while (remaining > 0) {
            final long skipped = in.skip(remaining);
            if (skipped > 0) remaining -= skipped;
            else if (in.read() >= 0) remaining -= 1;
            else return;
        }
    }

    private static long[] parseRange(String header) {
        // 返回 [start, end]；无 Range → [0, -1]（-1 表示到末尾）
        final long[] out = {0, -1};
        if (header == null) return out;
        try {
            final java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("bytes=(\\d*)-(\\d*)").matcher(header.trim());
            if (m.find()) {
                if (!m.group(1).isEmpty()) out[0] = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) out[1] = Long.parseLong(m.group(2));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static void writeEmpty(Socket socket, int status, String reason) throws IOException {
        final OutputStream out = socket.getOutputStream();
        out.write(("HTTP/1.1 " + status + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII));
        out.flush();
        socket.close();
    }

    private static void writeRangeUnsatisfiable(Socket socket, long total) throws IOException {
        final OutputStream out = socket.getOutputStream();
        out.write(("HTTP/1.1 416 Requested Range Not Satisfiable\r\n"
                + "Content-Range: bytes */" + total + "\r\n"
                + "Content-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        socket.close();
    }

    private static String guessMime(String source) {
        final String s = source.toLowerCase();
        if (s.endsWith(".mkv")) return "video/x-matroska";
        if (s.endsWith(".webm")) return "video/webm";
        if (s.endsWith(".ts") || s.endsWith(".m2ts")) return "video/mp2t";
        if (s.endsWith(".avi")) return "video/x-msvideo";
        if (s.endsWith(".mov")) return "video/quicktime";
        if (s.endsWith(".flv")) return "video/x-flv";
        return "video/mp4";
    }
}
