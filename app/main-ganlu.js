// main-ganlu.js — 甘露影视源主进程服务
// 职责：① HTTP 抓取代理（规则引擎/bgm/识图/弹幕，绕过渲染层 CORS + cookie jar + 弹幕签名）
// ② 剧集页解析窗（隐藏 BrowserWindow 捕获 m3u8/直链）
// ③ 本地媒体代理（127.0.0.1 HTTP 中继：m3u8 改写 + 分片/密钥 + UA/Referer 头注入）
// ④ m3u8 下载器（分片并行 + AES-128 + 广告过滤 + 本地 playlist.m3u8 回写）
// ⑤ 一起看（syncplay TCP/STARTTLS 协议）
// ⑥ DLNA 投屏（SSDP 发现 + UPnP SOAP 播放）
// ⑦ 数据落盘（ganlu.json：追番/历史/下载任务/弹幕屏蔽/页内设置；plugins.json：规则）
// 全部 Node 16 兼容（Electron 22 构建），无原生模块。

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const { URL: NodeURL } = require('url');

const UA_SPOOF = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

module.exports = {
  register(ctx) {
    const { ipcMain, session, BrowserWindow, app, path, fs, getMainWindow, userDataDir } = ctx;

    const sendToMain = (channel, payload) => {
      const targets = [getMainWindow()];
      if (typeof ctx.getExtraWindows === 'function') {
        try { targets.push(...(ctx.getExtraWindows() || [])); } catch (e) {}
      }
      for (const w of targets) {
        if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
      }
    };

    // ================= ⑦ 数据落盘 =================
    const DEFAULT_GANLU = {
      collect: {},        // { [bgmId]: { id, name, cover, type(1在看2想看3搁置4看过5弃番), updatedAt } }
      history: {},       // { [key]: { progresses:{ep:{road,posMs,at}}, lastEp, lastRoad, lastSrc, lastAt, title, cover, pluginName } }
      searchHistory: [],  // [{ keyword, at }]
      downloads: {},      // { [taskId]: { task:{...}, episodes:[...] } }
      shields: [],        // 弹幕屏蔽词（≤64 字符）
      settings: {
        danmaku: { enabled: true, top: true, bottom: true, rolling: true, fontSize: 22, opacity: 0.9,
                   speed: 1, offset: 0, dedupe: true, followRate: true, chConvert: 0,
                   sourceFilter: '' },
        syncplay: { host: 'syncplay.pl', port: 8996, username: '', tls: true },
        download: { dir: '', episodeParallel: 2, segmentParallel: 3 },
        trace: {},
        credentials: { appId: '', appKey: '' }, // 弹幕源可选凭据
      },
    };
    const ganluFile = path.join(userDataDir, 'ganlu.json');
    const pluginsFile = path.join(userDataDir, 'plugins.json');

    const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
    const writeJson = (f, data) => {
      try {
        const tmp = f + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, f);
      } catch (e) { console.error('ganlu write failed:', e); }
    };
    const getGanluStore = () => {
      const s = readJson(ganluFile, {});
      const out = JSON.parse(JSON.stringify(DEFAULT_GANLU));
      const st = s.settings || {};
      for (const k of Object.keys(out.settings)) {
        if (st[k] && typeof st[k] === 'object' && !Array.isArray(st[k])) out.settings[k] = Object.assign({}, out.settings[k], st[k]);
        else if (st[k] !== undefined) out.settings[k] = st[k];
      }
      for (const k of ['collect', 'history', 'downloads', 'shields']) if (s[k] && typeof s[k] === 'object') out[k] = s[k];
      if (Array.isArray(s.searchHistory)) out.searchHistory = s.searchHistory;
      return out;
    };
    const setGanluStore = (patch) => {
      const cur = getGanluStore();
      const next = { ...cur, ...(patch || {}) };
      if (patch && patch.settings) next.settings = Object.assign({}, cur.settings, patch.settings);
      writeJson(ganluFile, next);
      return next;
    };
    const getPlugins = () => { const a = readJson(pluginsFile, []); return Array.isArray(a) ? a : []; };
    const setPlugins = (list) => { const a = Array.isArray(list) ? list : []; writeJson(pluginsFile, a); return a; };

    ipcMain.handle('ganlu-store:get', () => getGanluStore());
    ipcMain.handle('ganlu-store:set', (e, patch) => setGanluStore(patch));
    ipcMain.handle('ganlu-plugins:get', () => getPlugins());
    ipcMain.handle('ganlu-plugins:set', (e, list) => setPlugins(list));

    // ================= ① HTTP 抓取代理 =================
    // cookie jar：内存（会话级，与参考实现一致）；key = 调用方给的 jarKey（通常是源站 origin）
    const cookieJars = new Map();

    function captureSetCookie(setCookie, jarKey) {
      if (!setCookie || !jarKey) return;
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      let jar = cookieJars.get(jarKey) || '';
      for (const c of list) {
        const kv = String(c).split(';')[0];
        const idx = kv.indexOf('=');
        if (idx <= 0) continue;
        const name = kv.slice(0, idx).trim();
        jar = jar ? jar + '; ' + name + '=' + kv.slice(idx + 1).trim() : name + '=' + kv.slice(idx + 1).trim();
      }
      cookieJars.set(jarKey, jar);
    }

    // 弹幕签名（照 dandanplay 客户端：恒附 X-Auth/X-AppId/X-Timestamp/X-Signature，
    // 签名 = base64(sha256(appId + 时间戳 + 请求路径 + appKey))；凭据可为空串）
    function dandanHeaders(urlStr, appId, appKey) {
      const u = new NodeURL(urlStr);
      const p = u.pathname + (u.search || '');
      const ts = String(Math.floor(Date.now() / 1000));
      const data = String(appId || '') + ts + p + String(appKey || '');
      const sig = crypto.createHash('sha256').update(data, 'utf8').digest('base64');
      return { 'X-Auth': '1', 'X-AppId': String(appId || ''), 'X-Timestamp': ts, 'X-Signature': sig };
    }

    function httpReq(method, urlStr, headers, body, timeoutMs, jarKey) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const lib = urlStr.startsWith('https') ? https : http;
        const isPost = method === 'POST';
        if (isPost && body != null) {
          headers = Object.assign({}, headers, { 'content-length': Buffer.isBuffer(body) ? body.length : String(body).length });
        }
        const req = lib.request(urlStr, { method: isPost ? 'POST' : 'GET', headers: headers || {}, timeout: timeoutMs || 15000 }, (res) => {
          if (!isPost && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const n = (headers && headers.__retries) || 0;
            if (n < 3) {
              res.resume();
              const nh = { ...(headers || {}) };
              nh.__retries = n + 1;
              const target = new NodeURL(res.headers.location, urlStr).toString();
              return resolve(httpReq(method, target, nh, body, timeoutMs, jarKey));
            }
          }
          captureSetCookie(res.headers['set-cookie'], jarKey);
          if (res.statusCode >= 400) {
            res.resume();
            const err = new Error('HTTP ' + res.statusCode);
            err.status = res.statusCode;
            if (!settled) { settled = true; reject(err); }
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const buf = Buffer.concat(chunks);
            const ct = String(res.headers['content-type'] || '');
            if (/xml|json|mpegurl|x-mpegurl|vnd\.apple|javascript|text/i.test(ct)) {
              resolve({ status: res.statusCode, text: buf.toString('utf8'), headers: res.headers });
            } else {
              resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
            }
          });
        });
        if (isPost && body != null) req.write(body);
        req.end();
        req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        req.on('timeout', () => { if (!settled) { settled = true; req.destroy(); reject(new Error('请求超时')); } });
      });
    }
    function httpGetRaw(urlStr, headers, timeoutMs, jarKey) {
      return httpReq('GET', urlStr, headers, null, timeoutMs, jarKey);
    }

    ipcMain.handle('ganlu-fetch', async (e, payload) => {
      const p = payload || {};
      try {
        let headers = {
          'user-agent': UA_SPOOF,
          'accept': 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
        };
        if (p.headers) for (const k of Object.keys(p.headers)) headers[k.toLowerCase()] = p.headers[k];
        let target = String(p.url || '');
        let body = p.body;
        const method = String(p.method || 'GET').toUpperCase();

        if (p.sign) Object.assign(headers, dandanHeaders(target, p.sign.appId, p.sign.appKey));
        if (p.cookieJar) {
          const jar = cookieJars.get(p.cookieJar);
          if (jar) headers['cookie'] = jar;
        }
        if (method === 'POST' && body) {
          if (p.bodyType === 'json') {
            headers['content-type'] = 'application/json';
            body = JSON.stringify(body);
          } else if (p.bodyType === 'raw') {
            // 二进制 body（识图等）：base64 传过来转 Buffer，content-type 以调用方头为准
            body = Buffer.from(String(body), 'base64');
          } else {
            headers['content-type'] = 'application/x-www-form-urlencoded';
            const parts = [];
            for (const [k, v] of Object.entries(body)) {
              const vals = Array.isArray(v) ? v : [v];
              for (const x of vals) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(x)));
            }
            body = parts.join('&');
          }
        }
        const result = await httpReq(method, target, headers, method === 'POST' && body ? body : null, p.timeoutMs, p.cookieJar || '');
        const out = {
          ok: result.status >= 200 && result.status < 400,
          status: result.status,
          headers: {
            'content-type': String(result.headers['content-type'] || ''),
            'content-length': String(result.headers['content-length'] || ''),
          },
        };
        if (result.text !== undefined) out.text = result.text;
        else out.base64 = result.buffer.toString('base64');
        return out;
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    // ================= ② 剧集页解析窗（捕获 m3u8 / 直连媒体） =================
    const RESOLVE_SESSION = 'ganlu-resolve-mem';
    const MEDIA_URL_RE = /\.(m3u8|m3u|mp4|mov|webm|mpd|flv|ts|m4s|mp3)([?#]|$)/i;
    let resolverWin = null;
    let resolverSession = null;
    const captureQueue = [];          // { token, tag }（FIFO，命中时取队首）
    const pendingResolvers = new Map(); // token → { resolve }（下载器侧 Promise）
    let resolveChain = Promise.resolve();

    function getResolverSession() {
      if (resolverSession) return resolverSession;
      const s = session.fromPartition(RESOLVE_SESSION);
      s.webRequest.onBeforeSendHeaders((details, cb) => {
        details.requestHeaders['User-Agent'] = UA_SPOOF;
        cb({ requestHeaders: details.requestHeaders });
      });
      s.webRequest.onBeforeRequest((details, cb) => {
        const u = details.url || '';
        if (!/^(https?:)?\/\//i.test(u) || u.startsWith('data:')) return cb({});
        if (!MEDIA_URL_RE.test(u)) return cb({});
        const head = captureQueue[0];
        if (head) {
          captureQueue.shift();
          sendToMain('ganlu-resolve-capture', { token: head.token, tag: head.tag || '', url: u });
          const pr = pendingResolvers.get(head.token);
          if (pr) {
            pendingResolvers.delete(head.token);
            pr.resolve({ url: u, kind: /\.(m3u8|m3u)([?#]|$)/i.test(u) ? 'hls' : 'media' });
          }
          cb({ cancel: true }); // 拿到即停，页面无需继续
        } else {
          cb({});
        }
      });
      resolverSession = s;
      return s;
    }

    function ensureResolver() {
      if (resolverWin && !resolverWin.isDestroyed()) return resolverWin;
      resolverWin = new BrowserWindow({
        width: 400, height: 300, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, session: getResolverSession() },
      });
      resolverWin.setMenu(null);
      resolverWin.on('closed', () => { resolverWin = null; });
      return resolverWin;
    }

    // 单窗串行：resolveChain 排队；任务 { url, tag, timeoutMs, referer }
    function runResolveJob(job) {
      const token = 'r' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      captureQueue.push({ token, tag: job.tag || '' });
      const win = ensureResolver();
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => {
          if (done) return;
          done = true;
          const i = captureQueue.findIndex((c) => c.token === token);
          if (i >= 0) captureQueue.splice(i, 1);
          pendingResolvers.delete(token);
          resolve(r);
        };
        const timer = setTimeout(() => {
          sendToMain('ganlu-resolve-timeout', { token, tag: job.tag || '' });
          finish(null);
        }, (job.timeoutMs || 15000) + 2000);
        pendingResolvers.set(token, { resolve: (r) => { clearTimeout(timer); finish(r || null); } });
        const headers = { 'User-Agent': UA_SPOOF };
        if (job.referer) headers['Referer'] = job.referer;
        win.loadURL(job.url, { headers }).catch(() => { /* 加载失败走超时兜底 */ });
      });
    }

    function resolveEpisodePage(job) {
      // 返回 Promise<{url,kind}|null>；同时渲染端可监听 ganlu-resolve-capture/timeout（token 由调用方在 job 里带上）
      const prev = resolveChain;
      const p = prev.then(() => runResolveJob(job));
      resolveChain = p.catch(() => {});
      return p;
    }

    ipcMain.handle('ganlu-resolve', async (e, payload) => {
      const url = String(payload.url || '');
      if (!url) return { ok: false, error: '缺少 URL' };
      if (MEDIA_URL_RE.test(url)) {
        return { ok: true, url, kind: /\.(m3u8|m3u)([?#]|$)/i.test(url) ? 'hls' : 'media', direct: true };
      }
      const job = { url, tag: String(payload.tag || ''), timeoutMs: payload.timeoutMs || 15000, referer: payload.referer || '' };
      resolveEpisodePage(job); // 单窗串行排队；结果按 tag 回报渲染端
      return { ok: true, started: true };
    });

    ipcMain.on('ganlu-resolve-cancel', (e, tag) => {
      // 渲染端提前放弃等待：按 tag 清队列（结果仍会发出但无人消费，无副作用）
      const t = String(tag || '');
      const i = captureQueue.findIndex((c) => c.tag === t);
      if (i >= 0) captureQueue.splice(i, 1);
    });

    // ================= ③ 本地媒体代理（m3u8 改写 + 分片/密钥中继 + 头注入） =================
    let mediaProxy = null;
    let mediaProxyPort = 0;

    function proxyWrap(target, opts) {
      if (!mediaProxyPort) return null;
      const p = new NodeURL('http://127.0.0.1:' + mediaProxyPort + '/x?');
      p.searchParams.set('url', target);
      if (opts.mode) p.searchParams.set('mode', opts.mode);
      if (opts.ua) p.searchParams.set('ua', opts.ua);
      if (opts.referer) p.searchParams.set('referer', opts.referer);
      return p.toString();
    }

    function rewriteM3u8(text, m3u8Url, ua, referer) {
      const wrap = (u, playlist) => {
        if (!u) return u;
        let abs = u;
        if (!/^(https?:)?\/\//i.test(abs)) {
          try { abs = new NodeURL(abs, m3u8Url).toString(); } catch (e) { return u; }
        }
        const proxied = proxyWrap(abs, { mode: playlist ? 'playlist' : undefined, ua, referer });
        return proxied || abs;
      };
      const lines = String(text).split(/\r?\n/);
      const out = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) { out.push(line); continue; }
        if (t.startsWith('#EXT-X-KEY:')) {
          out.push(t.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + wrap(uri, false) + '"'));
          continue;
        }
        if (t.startsWith('#')) { out.push(line); continue; }
        const isNested = /\.(m3u8|m3u)([?#]|$)/i.test(t);
        out.push(wrap(t, isNested));
      }
      return out.join('\n');
    }

    function startMediaProxy() {
      if (mediaProxy) return;
      mediaProxy = http.createServer((req, res) => {
        const u = new NodeURL(req.url, 'http://127.0.0.1');
        const target = u.searchParams.get('url');
        if (!target || !/^(https?:)?\/\//i.test(target)) { res.writeHead(400); res.end('bad target'); return; }
        const mode = u.searchParams.get('mode') || 'raw';
        const ua = u.searchParams.get('ua') || UA_SPOOF;
        const referer = u.searchParams.get('referer') || '';
        const headers = { 'user-agent': ua, 'accept': '*/*' };
        if (referer) headers['referer'] = referer;
        if (req.headers.range) headers['range'] = req.headers.range;

        const lib = target.startsWith('https') ? https : http;
        const upstream = lib.get(target, { headers, timeout: 30000 }, (up) => {
          const ct = String(up.headers['content-type'] || '');
          const isPlaylist = mode === 'playlist' || /mpegurl/i.test(ct) || /\.(m3u8|m3u)([?#]|$)/i.test(target);
          if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
            up.resume();
            res.writeHead(302, { location: up.headers.location });
            res.end();
            return;
          }
          if (up.statusCode >= 400) {
            up.resume();
            res.writeHead(up.statusCode);
            res.end('upstream ' + up.statusCode);
            return;
          }
          if (!isPlaylist) {
            const outHeaders = {
              'content-type': ct || 'application/octet-stream',
              'access-control-allow-origin': '*',
            };
            if (up.headers['content-length']) outHeaders['content-length'] = up.headers['content-length'];
            if (up.headers['content-range']) outHeaders['content-range'] = up.headers['content-range'];
            res.writeHead(up.statusCode === 206 ? 206 : 200, outHeaders);
            up.pipe(res);
            return;
          }
          // playlist：缓冲全文 → 相对 URL 改写为经过本机代理（分片/密钥/嵌套播放列表）
          const chunks = [];
          up.on('data', (c) => chunks.push(c));
          up.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            res.writeHead(200, {
              'content-type': 'application/vnd.apple.mpegurl',
              'access-control-allow-origin': '*',
            });
            res.end(rewriteM3u8(text, target, ua, referer));
          });
        });
        upstream.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502);
          res.end('proxy error: ' + err.message);
        });
        upstream.on('timeout', () => {
          upstream.destroy();
          if (!res.headersSent) res.writeHead(504);
          res.end('proxy timeout');
        });
      });
      mediaProxy.listen(0, '127.0.0.1', () => {
        mediaProxyPort = mediaProxy.address().port;
      });
    }

    ipcMain.handle('ganlu-proxy-port', () => mediaProxyPort || null);

    // ================= ④ m3u8 下载器 =================
    const runningDownloads = new Map(); // taskId → job

    function hashCode(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return h;
    }

    function resolveM3u8Url(baseUrl, rel) {
      if (/^https?:\/\//i.test(rel)) return rel;
      try { return new NodeURL(rel, baseUrl).toString(); } catch (e) { return rel; }
    }

    function parseM3u8Key(line, baseUrl) {
      const m = line.match(/METHOD=([^,]+)/);
      const method = (m && m[1]) || 'NONE';
      if (method === 'NONE') return null;
      const um = line.match(/URI="([^"]+)"/);
      const im = line.match(/IV=(0x[0-9a-fA-F]+)/);
      return { method, uri: um ? resolveM3u8Url(baseUrl, um[1]) : '', iv: im ? im[1] : null };
    }

    // 解析 m3u8 文本：master 返回最佳码率 URL；media 返回 segments[]
    function parseM3u8(raw, baseUrl) {
      const lines = String(raw).split(/\r?\n/).map((l) => l.trim());
      if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
        let best = null, bestBandwidth = -1, lastBand = null;
        for (const l of lines) {
          if (l.startsWith('#EXT-X-STREAM-INF:')) {
            const m = l.match(/BANDWIDTH=(\d+)/);
            lastBand = m ? Number(m[1]) : 0;
          } else if (l && !l.startsWith('#')) {
            if (lastBand != null && lastBand > bestBandwidth) { best = l; bestBandwidth = lastBand; }
            lastBand = null;
          }
        }
        return best ? resolveM3u8Url(baseUrl, best) : null;
      }
      const segments = [];
      let curDur = 0, group = 0, key = null;
      for (const l of lines) {
        if (l.startsWith('#EXTINF:')) curDur = parseFloat(l.slice(8).split(',')[0]) || 0;
        else if (l === '#EXT-X-DISCONTINUITY') group++;
        else if (l.startsWith('#EXT-X-KEY:')) key = parseM3u8Key(l, baseUrl);
        else if (l && !l.startsWith('#')) {
          segments.push({ duration: curDur, uri: resolveM3u8Url(baseUrl, l), group, key });
          curDur = 0;
        }
      }
      return segments;
    }

    // 广告过滤（仿 ffmpeg hls_ad_filter：discontinuity 分组时长启发式）
    function filterAdSegments(segments) {
      if (!segments.length) return segments;
      const groups = new Map();
      for (const s of segments) {
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
      }
      if (groups.size <= 1) return segments;
      const durations = new Map();
      for (const [g, segs] of groups) durations.set(g, segs.reduce((a, s) => a + s.duration, 0));
      let maxDuration = 0;
      for (const d of durations.values()) maxDuration = Math.max(maxDuration, d);
      const keys = [...groups.keys()].sort((a, b) => a - b);
      const adGroups = new Set();
      for (const g of keys) {
        const d = durations.get(g);
        let isAd = false;
        if (d < maxDuration * 0.3) isAd = true;
        if ((g === keys[0] || g === keys[keys.length - 1]) && d < 30) isAd = true;
        if (d < 10) isAd = true;
        if (isAd) adGroups.add(g);
      }
      if (!adGroups.size) return segments;
      return segments.filter((s) => !adGroups.has(s.group));
    }

    async function downloadHttp(url, destPath, headers, retries) {
      const lib = url.startsWith('https') ? https : http;
      const h = Object.assign({ 'user-agent': UA_SPOOF }, headers || {});
      return new Promise((resolve, reject) => {
        const req = lib.get(url, { headers: h }, (res) => {
          if (res.statusCode === 416) { res.resume(); return resolve({ skipped: true }); } // 已下完
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (retries || 0) > 0) {
            res.resume();
            return downloadHttp(new NodeURL(res.headers.location, url).toString(), destPath, headers, (retries || 0) - 1).then(resolve, reject);
          }
          if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
          const ws = fs.createWriteStream(destPath);
          let received = 0;
          res.on('data', (c) => { received += c.length; });
          res.pipe(ws);
          ws.on('finish', () => resolve({ bytes: received }));
          ws.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60000, () => req.destroy(new Error('超时')));
      });
    }

    function aesDecryptBuffer(buffer, keyBuf, ivHex) {
      if (!keyBuf) return buffer;
      let ivBuf;
      if (ivHex) {
        const hex = ivHex.startsWith('0x') ? ivHex.slice(2) : ivHex;
        ivBuf = Buffer.from(hex.length >= 32 ? hex.slice(0, 32) : hex, 'hex');
      } else {
        ivBuf = Buffer.alloc(16);
      }
      if (ivBuf.length < 16) {
        const padded = Buffer.alloc(16);
        ivBuf.copy(padded, 0);
        ivBuf = padded;
      }
      const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf.slice(0, 16));
      d.setAutoPadding(false);
      return Buffer.concat([d.update(buffer), d.final()]);
    }

    // 单集下载：集 URL/页 → m3u8 链 → 去广告 → 分片+密钥并行 → 本地 playlist.m3u8
    async function downloadOneEpisode(job, epIndex) {
      const st = job.epStates[epIndex];
      st.status = 'resolving';
      emitDownload(job);

      const pageUrl = String(job.epUrls[epIndex] || '');
      let resolvedUrl = null;
      if (MEDIA_URL_RE.test(pageUrl)) resolvedUrl = pageUrl;
      else {
        const r = await resolveEpisodePage({
          url: pageUrl,
          timeoutMs: 20000,
          referer: (job.headers && job.headers['referer']) || '',
        });
        resolvedUrl = r ? r.url : null;
      }
      if (!resolvedUrl) throw new Error('第 ' + (epIndex + 1) + ' 集解析不到媒体地址');

      // m3u8 链：master → media（最多 3 层嵌套展开在分片阶段做）
      let target = resolvedUrl;
      for (let depth = 0; depth < 3; depth++) {
        if (!/\.m3u8([?#]|$)/i.test(target) && !/EXT-X-STREAM-INF/.test(target)) break;
        const r = await httpGetRaw(target, job.headers, 20000);
        const best = parseM3u8(r.text, target);
        if (!Array.isArray(best) && best) target = best;
        else if (Array.isArray(best)) break;
        else throw new Error('m3u8 没有可用码率: ' + target);
      }
      const r2 = await httpGetRaw(target, job.headers, 20000);
      let segments = parseM3u8(r2.text, target);
      if (!Array.isArray(segments)) throw new Error('目标不是媒体播放列表: ' + target);

      // 嵌套展开（segment uri 指向 m3u8 时展开，深度 3）
      let groupOffset = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!/\.(m3u8|m3u)([?#]|$)/i.test(seg.uri)) continue;
        try {
          const rr = await httpGetRaw(seg.uri, job.headers, 20000);
          const nested = parseM3u8(rr.text, seg.uri);
          if (!Array.isArray(nested)) continue;
          const maxG = nested.reduce((a, s) => Math.max(a, s.group), 0);
          const flat = nested.map((s) => ({
            duration: s.duration,
            uri: resolveM3u8Url(seg.uri, s.uri),
            key: s.key,
            group: s.group + seg.group + groupOffset,
          }));
          segments.splice(i, 1, ...flat);
          i += flat.length - 1;
          groupOffset += maxG;
        } catch (e) { /* 展开失败保留原段 */ }
      }
      segments = filterAdSegments(segments);
      if (!segments.length) throw new Error('过滤广告后没有有效分片');

      // 密钥预取
      const epDir = path.join(job.dir, 'ep' + String(epIndex + 1).padStart(3, '0'));
      fs.mkdirSync(epDir, { recursive: true });
      const keyDir = path.join(epDir, 'keys');
      fs.mkdirSync(keyDir, { recursive: true });
      const keyPaths = new Map();
      for (const s of segments) {
        if (!s.key || s.key.method !== 'AES-128') continue;
        if (keyPaths.has(s.key.uri)) continue;
        const kn = 'key_' + Math.abs(hashCode(s.key.uri)) + '.key';
        const kp = path.join(keyDir, kn);
        await downloadHttp(s.key.uri, kp, job.headers, 1).catch(() => { /* 稍后按段重试时再处理 */ });
        keyPaths.set(s.key.uri, { file: kp, iv: s.key.iv, kn });
      }

      // 分片并行下载 + AES 解密
      st.status = 'downloading';
      st.progress = 0;
      emitDownload(job);
      const concurrency = Math.max(1, Number(job.segmentParallel) || 3);
      const total = segments.length;
      let doneCount = 0;
      let cursor = 0;
      const keyBufs = new Map();
      const getKeyBuf = async (s) => {
        const meta = keyPaths.get(s.key.uri);
        if (!meta) return null;
        if (keyBufs.has(s.key.uri)) return keyBufs.get(s.key.uri);
        const kp = meta.file;
        if (!fs.existsSync(kp)) {
          await downloadHttp(s.key.uri, kp, job.headers, 1);
        }
        const buf = fs.readFileSync(kp);
        keyBufs.set(s.key.uri, { buf, meta });
        return { buf, meta };
      };
      const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
        while (cursor < total && !job.cancelled) {
          const i = cursor++;
          const seg = segments[i];
          const segPath = path.join(epDir, 'seg_' + String(i).padStart(5, '0') + '.ts');
          if (!fs.existsSync(segPath)) {
            let tryCount = 0;
            for (;;) {
              try {
                await downloadHttp(seg.uri, segPath, job.headers, 2);
                break;
              } catch (err) {
                tryCount++;
                if (tryCount >= 3 || job.cancelled) throw err;
                await new Promise((r) => setTimeout(r, 1500));
              }
            }
          }
          if (seg.key && seg.key.method === 'AES-128' && fs.existsSync(segPath)) {
            const km = await getKeyBuf(seg);
            if (km) {
              const raw = fs.readFileSync(segPath);
              const ivHex = km.meta.iv || ('0x' + Buffer.from(String(i).padStart(8, '0'), 'ascii').toString('hex'));
              fs.writeFileSync(segPath, aesDecryptBuffer(raw, km.buf, ivHex));
            }
          }
          doneCount++;
          st.progress = doneCount / total;
          emitDownload(job);
        }
      });
      await Promise.all(workers);
      if (job.cancelled) { st.status = 'paused'; emitDownload(job); return; }

      // 本地 playlist 回写
      st.status = 'completed';
      st.dir = epDir;
      st.progress = 1;
      buildLocalM3u8(epDir, segments, keyPaths);
      emitDownload(job);
    }

    function buildLocalM3u8(epDir, segments, keyPaths) {
      let lastGroup = 0, lastKey = null;
      const targetDur = Math.ceil(segments.reduce((a, s) => Math.max(a, s.duration), 0)) || 0;
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + targetDur, '#EXT-X-MEDIA-SEQUENCE:0'];
      segments.forEach((seg, i) => {
        if (seg.group !== lastGroup && i > 0) lines.push('#EXT-X-DISCONTINUITY');
        lastGroup = seg.group;
        const keyChanged = JSON.stringify(seg.key) !== JSON.stringify(lastKey);
        if (keyChanged) {
          lastKey = seg.key;
          if (!seg.key) lines.push('#EXT-X-KEY:METHOD=NONE');
          else {
            const meta = keyPaths.get(seg.key.uri);
            const localUri = meta ? 'keys/' + meta.kn : seg.key.uri;
            let kl = '#EXT-X-KEY:METHOD=' + seg.key.method + ',URI="' + localUri + '"';
            if (seg.key.iv) kl += ',IV=' + seg.key.iv;
            lines.push(kl);
          }
        }
        lines.push('#EXTINF:' + seg.duration.toFixed(6) + ',');
        lines.push('seg_' + String(i).padStart(5, '0') + '.ts');
      });
      lines.push('#EXT-X-ENDLIST');
      fs.writeFileSync(path.join(epDir, 'playlist.m3u8'), lines.join('\n'));
    }

    function sanitizeName(s) {
      return String(s || 'task').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    }

    ipcMain.handle('ganlu-download-start', async (e, task) => {
      const store = getGanluStore();
      const dl = store.settings.download || {};
      let dir = String(dl.dir || '').trim();
      if (!dir) dir = path.join(userDataDir, 'downloads', sanitizeName((task.pluginName || 'ganlu') + '_' + (task.title || task.id || 'episode')));
      else dir = path.join(dir, sanitizeName((task.pluginName || 'ganlu') + '_' + (task.title || task.id || 'episode')));
      fs.mkdirSync(dir, { recursive: true });
      const taskId = (task.pluginName || 'ganlu') + '_' + (task.id || 'ep') + '_' + Date.now();
      const epStates = (task.episodes || []).map((label, i) => ({ i, label, status: 'pending', progress: 0 }));
      const job = {
        cancelled: false,
        task: {
          taskId, pluginName: task.pluginName || '', title: task.title || '',
          dir, createdAt: Date.now(),
          episodes: epStates.map((s) => ({ i: s.i, label: s.label, status: s.status, progress: s.progress })),
        },
        epStates,
        epUrls: task.urls || [],
        headers: task.headers || {},
        segmentParallel: dl.segmentParallel || 3,
        episodeParallel: dl.episodeParallel || 2,
        dir,
      };
      runningDownloads.set(taskId, job);
      startDownloadTask(job).catch(() => {});
      return { taskId };
    });

    async function startDownloadTask(job) {
      const epConcurrency = Math.max(1, Number(job.episodeParallel) || 2);
      for (let i = 0; i < job.epStates.length; i += epConcurrency) {
        if (job.cancelled) break;
        const batch = job.epStates.slice(i, i + epConcurrency);
        await Promise.all(batch.map(async (st) => {
          if (st.status === 'completed' || job.cancelled) return;
          try {
            await downloadOneEpisode(job, st.i);
            persistDownloadTask(job);
          } catch (err) {
            if (job.cancelled) st.status = 'paused';
            else { st.status = 'failed'; st.error = String(err.message || err); }
            emitDownload(job);
            persistDownloadTask(job);
          }
        }));
      }
      emitDownload(job);
      persistDownloadTask(job);
      runningDownloads.delete(job.task.taskId);
    }

    function persistDownloadTask(job) {
      const store = getGanluStore();
      store.downloads[job.task.taskId] = {
        task: {
          taskId: job.task.taskId, pluginName: job.task.pluginName, title: job.task.title,
          dir: job.task.dir, createdAt: job.task.createdAt,
          episodes: job.epStates.map((s) => ({ i: s.i, label: s.label, status: s.status, progress: s.progress, error: s.error || undefined, dir: s.dir || undefined })),
        },
      };
      writeJson(ganluFile, store);
    }

    function emitDownload(job) {
      sendToMain('ganlu-download-progress', {
        taskId: job.task.taskId,
        episodes: job.epStates.map((s) => ({ i: s.i, label: s.label, status: s.status, progress: s.progress, error: s.error })),
        running: runningDownloads.has(job.task.taskId),
      });
    }

    ipcMain.handle('ganlu-download-pause', (e, taskId) => {
      const job = runningDownloads.get(String(taskId));
      if (job) job.cancelled = true;
      return { ok: true };
    });
    ipcMain.handle('ganlu-download-cancel', (e, taskId) => {
      const job = runningDownloads.get(String(taskId));
      if (job) job.cancelled = true;
      return { ok: true };
    });

    // ================= ⑤ 一起看（syncplay v1.7.0 协议） =================
    const syncplaySessions = new Map();

    function spEmit(sp, payload) {
      sendToMain('ganlu-syncplay-event', Object.assign({ id: sp.id }, payload));
    }
    function spClose(sp, reason) {
      if (sp.closed) return;
      sp.closed = true;
      spEmit(sp, { type: 'closed', reason: reason || 'closed' });
      try { if (sp.transport) sp.transport.destroy(); } catch (e) {}
      try { sp.socket.destroy(); } catch (e) {}
      syncplaySessions.delete(sp.id);
    }

    function spOnData(sp, data) {
      sp.buf += Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      for (;;) {
        const start = sp.buf.indexOf('{');
        if (start < 0) break;
        let depth = 0, end = -1;
        for (let i = start; i < sp.buf.length; i++) {
          if (sp.buf[i] === '{') depth++;
          else if (sp.buf[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) break;
        const jsonStr = sp.buf.slice(start, end + 1);
        sp.buf = sp.buf.slice(end + 1);
        let msg;
        try { msg = JSON.parse(jsonStr); } catch (e) { spEmit(sp, { type: 'error', message: '协议解析失败' }); continue; }
        spHandleMessage(sp, msg);
      }
    }

    function spHandleMessage(sp, msg) {
      if (msg.TLS) {
        if (msg.TLS.startTLS === 'true') {
          const raw = sp.socket;
          const secure = tls.connect({ socket: raw, servername: sp.host, rejectUnauthorized: false }, () => {
            sp.socket = secure;
            sp.isTls = true;
            secure.on('data', (d) => spOnData(sp, d));
          });
          secure.on('error', () => spClose(sp, 'TLS 连接失败'));
          return;
        }
        spClose(sp, '服务器拒绝 TLS 升级');
        return;
      }
      if (msg.Hello) {
        const h = msg.Hello || {};
        sp.username = h.username || sp.username;
        sp.room = (h.room && h.room.name) || sp.room;
        spEmit(sp, { type: 'hello', username: sp.username, room: sp.room });
        sp.socket.write(JSON.stringify({ Set: { [sp.username || 'user']: { room: { name: sp.room || '' }, event: { joined: true } } } }) + '\r\n');
        sp.socket.write(JSON.stringify({ Set: { ready: { isReady: true, manuallyInitiated: false } } }) + '\r\n');
        spEmit(sp, { type: 'joined', username: sp.username, room: sp.room });
        return;
      }
      if (msg.State) {
        const s = msg.State || {};
        if (s.ping && s.ping.clientLatencyCalculation != null) {
          const ts = Number(s.ping.clientLatencyCalculation);
          const now = Date.now() / 1000;
          const serverRtt = s.ping.serverRtt != null ? Number(s.ping.serverRtt) : 0;
          if (ts > 0 && now - ts >= 0) {
            sp.clientRtt = now - ts;
            sp.avrRtt = sp.avrRtt === 0 ? sp.clientRtt : sp.avrRtt * 0.85 + sp.clientRtt * 0.15;
            sp.serverRtt = serverRtt;
            sp.fd = serverRtt < sp.clientRtt ? sp.avrRtt / 2 + (sp.clientRtt - serverRtt) : sp.avrRtt / 2;
          }
        }
        if (s.ignoringOnTheFly) {
          if (s.ignoringOnTheFly.server != null) { sp.serverAck = Number(s.ignoringOnTheFly.server); sp.clientAck = 0; }
          else if (s.ignoringOnTheFly.client != null && Number(s.ignoringOnTheFly.client) === sp.clientAck) sp.clientAck = 0;
        }
        if (sp.clientAck === 0 && s.playstate) {
          const paused = s.playstate.paused !== false;
          const pos = Number(s.playstate.position) || 0;
          spEmit(sp, {
            type: 'state', position: pos, paused,
            adjusted: paused ? pos : pos + sp.fd,
            fd: sp.fd, clientRtt: sp.clientRtt,
            doSeek: !!s.playstate.doSeek, setBy: s.playstate.setBy || '',
          });
        }
        spState(sp, sp.lastPosition || 0, !!sp.lastPaused, false, false);
        return;
      }
      if (msg.Set) {
        const set = msg.Set || {};
        if (set.user) {
          for (const [username, details] of Object.entries(set.user)) {
            if (details && details.event) {
              const ev = Object.keys(details.event)[0] || 'unknown';
              spEmit(sp, { type: 'room-event', username, event: ev });
            }
            if (details && details.file && details.file.name) spEmit(sp, { type: 'file', name: details.file.name, setBy: username });
          }
        }
        return;
      }
      if (msg.Chat && msg.Chat.message != null) {
        spEmit(sp, { type: 'chat', username: msg.Chat.username || '', message: msg.Chat.message });
        return;
      }
    }

    function spState(sp, position, paused, doSeek, stateChange) {
      if (stateChange) sp.clientAck += 1;
      const payload = {
        State: {
          ping: { clientRtt: sp.clientRtt, clientLatencyCalculation: Date.now() / 1000 },
          playstate: {
            position: Number(position) || 0,
            paused: !!paused,
            setBy: sp.username || '',
          },
        },
      };
      if (doSeek) payload.State.playstate.doSeek = true;
      if (sp.clientAck > 0 || sp.serverAck > 0) {
        payload.State.ignoringOnTheFly = {};
        if (sp.clientAck > 0) payload.State.ignoringOnTheFly.client = sp.clientAck;
        if (sp.serverAck > 0) { payload.State.ignoringOnTheFly.server = sp.serverAck; sp.serverAck = 0; }
      }
      try { sp.socket.write(JSON.stringify(payload) + '\r\n'); } catch (e) {}
    }

    ipcMain.handle('ganlu-syncplay-connect', (e, p) => {
      const host = String(p.host || 'syncplay.pl');
      const port = Number(p.port) || 8996;
      const username = String(p.username || 'LGVideo').slice(0, 32) || 'LGVideo';
      const room = String(p.room || '');
      const useTls = !!p.tls;
      const sp = {
        id: 'sp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        host, port, username, room, buf: '', closed: false, isTls: false,
        clientRtt: 0, serverRtt: 0, avrRtt: 0, fd: 0, clientAck: 0, serverAck: 0,
        lastPosition: 0, lastPaused: true, socket: null, transport: null,
      };
      const socket = net.connect(port, host);
      socket.setTimeout(10000, () => {
        if (!sp.closed && !sp.username) spClose(sp, '握手超时');
      });
      socket.on('connect', () => {
        sp.socket = socket;
        sp.transport = socket;
        socket.on('data', (d) => spOnData(sp, d));
        socket.on('error', () => { if (!sp.closed) spClose(sp, '连接错误'); });
        socket.on('close', () => spClose(sp, '连接关闭'));
        socket.write(JSON.stringify({
          Hello: {
            username, version: '1.7.0', room: { name: room },
            features: { sharedPlaylists: true, chat: true, featureList: true, readiness: true, managedRooms: false },
          },
        }) + '\r\n');
        if (useTls) socket.write(JSON.stringify({ TLS: { startTLS: 'send' } }) + '\r\n');
        syncplaySessions.set(sp.id, sp);
        sendToMain('ganlu-syncplay-connected', { id: sp.id, username, room, tls: useTls });
      });
      socket.on('error', (err) => {
        sp.closed = true;
        sendToMain('ganlu-syncplay-connect-failed', { host, port, error: String(err.message || err) });
      });
      return { ok: true, id: sp.id };
    });

    ipcMain.handle('ganlu-syncplay-state', (e, p) => {
      const sp = syncplaySessions.get(String(p.id));
      if (!sp || sp.closed) return { ok: false };
      sp.lastPosition = Number(p.position) || 0;
      sp.lastPaused = !!p.paused;
      if (p.syncFile) {
        const fileMsg = { Set: { file: { duration: Number(p.duration) || 0, name: p.syncFile, size: 0 } } };
        try { sp.socket.write(JSON.stringify(fileMsg) + '\r\n'); } catch (e) {}
      }
      spState(sp, sp.lastPosition, sp.lastPaused, !!p.doSeek, !!p.doSeek);
      return { ok: true };
    });

    ipcMain.handle('ganlu-syncplay-chat', (e, p) => {
      const sp = syncplaySessions.get(String(p.id));
      if (!sp || sp.closed) return { ok: false };
      try { sp.socket.write(JSON.stringify({ Chat: String(p.message || '') }) + '\r\n'); } catch (e) {}
      return { ok: true };
    });

    ipcMain.handle('ganlu-syncplay-close', (e, p) => {
      const sp = syncplaySessions.get(String(p.id));
      if (sp) spClose(sp, 'user close');
      return { ok: true };
    });

    // ================= ⑥ DLNA 投屏（SSDP 发现 + UPnP SOAP） =================
    const dlnaDevices = new Map();

    ipcMain.handle('ganlu-dlna-discover', async () => {
      const socket = dgram.createSocket('udp4');
      const found = new Map();
      const msearch = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nMX: 2\r\n\r\n';
      socket.on('message', (msg) => {
        const text = msg.toString('utf8');
        const loc = (text.match(/LOCATION:\s*(\S+)/i) || [])[1];
        const usn = (text.match(/USN:\s*(\S+)/i) || [])[1];
        if (loc && usn && !found.has(loc)) found.set(loc, { location: loc, usn });
      });
      socket.on('error', () => {});
      for (let i = 0; i < 3; i++) socket.send(Buffer.from(msearch), 1900, '239.255.255.250');
      await new Promise((r) => setTimeout(r, 2600));
      try { socket.close(); } catch (e) {}
      const list = [];
      for (const d of found.values()) {
        try {
          const r = await httpGetRaw(d.location, { 'user-agent': UA_SPOOF }, 5000);
          const xml = r.text || '';
          const name = String((xml.match(/<friendlyName[^>]*>([^<]+)</i) || [])[1] || d.usn).trim();
          const control = String(
            (xml.match(/serviceType="urn:schemas-upnp-org:service:AVTransport:1"[\s\S]*?<controlURL>([^<]+)/i) || [])[1]
            || (xml.match(/AVTransport[\s\S]*?<controlURL>([^<]+)/i) || [])[1]
            || (xml.match(/<controlURL>([^<]+)/i) || [])[1]
            || ''
          );
          const id = 'dlna_' + Buffer.from(d.location).toString('base64').slice(0, 16);
          dlnaDevices.set(id, { id, name, location: d.location, control, at: Date.now() });
          list.push({ id, name, hasControl: !!control });
        } catch (e) { /* 跳过不可达 */ }
      }
      return { devices: list };
    });

    function soapPost(url, body) {
      return new Promise((resolve, reject) => {
        const u = new NodeURL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'Content-Length': Buffer.byteLength(body),
            'user-agent': UA_SPOOF,
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }

    const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const soapHeader = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>';
    const soapFooter = '</s:Body></s:Envelope>';

    ipcMain.handle('ganlu-dlna-cast', async (e, p) => {
      const dev = dlnaDevices.get(String(p.deviceId));
      if (!dev || !dev.control) return { ok: false, error: '设备不存在或无播放接口，请重新发现' };
      const uri = String(p.url || '');
      if (!/^https?:\/\//i.test(uri)) return { ok: false, error: '只能投屏网络直连地址' };
      try {
        const r1 = await soapPost(dev.control, soapHeader
          + '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
          + '<InstanceID>0</InstanceID><CurrentURI>' + escapeXml(uri) + '</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>'
          + '</u:SetAVTransportURI>' + soapFooter);
        if (r1.status >= 400) return { ok: false, error: '设置播放地址失败 HTTP ' + r1.status };
        await new Promise((r) => setTimeout(r, 400));
        const r2 = await soapPost(dev.control, soapHeader
          + '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
          + '<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>' + soapFooter).catch(() => null);
        return { ok: !r2 || r2.status < 400, device: dev.name };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    });

    // ================= 就绪钩子 =================
    ctx.onReady = () => {
      startMediaProxy();
    };
  },
};
