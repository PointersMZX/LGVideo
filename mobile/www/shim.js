// shim.js — 移动端宿主桥（voidAPI polyfill）
// 桌面甘露引擎依赖的宿主接口在 Android WebView 里接到 Capacitor 原生能力：
// 抓取代理 = CapacitorHttp（原生 HTTP，无 CORS 限制）；持久化 = Preferences。
;(function initShim() {
  const prefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  const http = () => window.Capacitor && window.Capacitor.Plugins && window.CapacitorHttp;

  // 抓取代理（返回形状与桌面主进程 ganlu-fetch 一致：{ok, status, text, error}）
  async function nativeFetch(p) {
    if (!http()) return { ok: false, error: '原生网络桥未就绪' };
    const headers = Object.assign({}, p.headers || {});
    let data;
    const bt = p.bodyType || 'none';
    if (bt === 'json') {
      headers['content-type'] = headers['content-type'] || 'application/json';
      data = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
    } else if (bt === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      data = typeof p.body === 'string' ? p.body : new URLSearchParams(p.body || {}).toString();
    } else if (bt !== 'none' && p.body != null) {
      headers['content-type'] = headers['content-type'] || 'text/plain';
      data = p.body;
    }
    try {
      const r = await http().request({
        url: String(p.url || ''),
        method: (p.method || 'GET').toUpperCase(),
        headers,
        data,
        connectTimeout: 15000,
        readTimeout: Number(p.timeoutMs) || 20000,
      });
      const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 持久化（Preferences 单键 JSON 容器，形状对齐桌面 ganlu.json / plugins.json）
  const STORE_KEY = 'lgvideo_ganlu_store';
  const PLUGINS_KEY = 'lgvideo_ganlu_plugins';

  async function readJson(key, fallback) {
    try {
      const r = await prefs().get({ key });
      const v = r && r.value;
      if (!v) return fallback;
      return JSON.parse(v);
    } catch (e) { return fallback; }
  }
  async function writeJson(key, value) {
    await prefs().set({ key, value: JSON.stringify(value) });
  }

  window.voidAPI = {
    // --- 甘露影视源 ---
    ganluFetch: nativeFetch,
    ganluGetStore: async () => {
      const s = await readJson(STORE_KEY, null);
      return s || { collect: {}, history: {}, searchHistory: [], downloads: {}, shields: [], settings: {} };
    },
    ganluSetStore: async (patch) => {
      const cur = await readJson(STORE_KEY, {}) || {};
      const next = Object.assign(cur, patch || {});
      await writeJson(STORE_KEY, next);
      return next;
    },
    ganluGetPlugins: async () => (await readJson(PLUGINS_KEY, [])) || [],
    ganluSetPlugins: async (list) => { await writeJson(PLUGINS_KEY, Array.isArray(list) ? list : []); return list; },

    // --- 播放进度（移动版同一 Preferences 容器）---
    getPosition: async (file) => {
      const m = (await readJson('lgvideo_positions', {})) || {};
      return m[file] || null;
    },
    setPosition: async (file, pos) => {
      const m = (await readJson('lgvideo_positions', {})) || {};
      m[file] = pos;
      await writeJson('lgvideo_positions', m);
    },
    clearPosition: async (file) => {
      const m = (await readJson('lgvideo_positions', {})) || {};
      delete m[file];
      await writeJson('lgvideo_positions', m);
    },

    // --- 移动端暂不提供的桌面能力（甘露页按缺省静默降级）---
    ganluResolve: null,
    ganluResolveCancel: null,
    onGanluResolveCapture: null,
    onGanluResolveTimeout: null,
    ganluProxyPort: async () => null,
    ganluDownloadStart: null,
    ganluDownloadPause: null,
    ganluDownloadCancel: null,
    onGanluDownloadProgress: null,
    ganluSyncplayConnect: null,
    ganluSyncplayState: null,
    ganluSyncplayChat: null,
    ganluSyncplayClose: null,
    onGanluSyncplayEvent: null,
    onGanluSyncplayConnected: null,
    onGanluSyncplayConnectFailed: null,
    ganluDlnaDiscover: null,
    ganluDlnaCast: null,
    openDirsDialog: async () => [],
  };
})();
