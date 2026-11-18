// platform-bridge.js — Android 壳端 voidAPI 适配层
// 桌面端 preload（contextBridge）已注入 window.voidAPI 时本文件零动作；
// Android（Capacitor WebView）内由 VoidBridgePlugin 原生插件提供同名能力。
;(function initPlatformBridge() {
  if (window.voidAPI) return; // 桌面：preload 已就位
  if (!window.Capacitor || !window.Capacitor.isNativePlatform) return; // 未知环境：不接管

  const plugin = window.Capacitor.Plugins && window.Capacitor.Plugins.VoidBridge;
  if (!plugin) return;

  document.documentElement.classList.add('platform-android');

  // 原生插件统一收发：载荷一律 JSON 字符串过桥（避开 Capacitor 对混合类型参数的序列化差异）
  const call = (method, payload) => plugin[method]({ data: JSON.stringify(payload === undefined ? null : payload) })
    .then((r) => {
      if (!r || typeof r.data !== 'string') return undefined;
      try { return JSON.parse(r.data); } catch (e) { return undefined; }
    });
  const listen = (event, cb) => plugin.addListener(event, (d) => {
    if (!d || typeof d.data !== 'string') return cb(undefined);
    try { return cb(JSON.parse(d.data)); } catch (e) { return cb(undefined); }
  });

  window.voidAPI = {
    // --- 窗口控制（Android 无窗口概念：最小化=回桌面，其余 no-op）---
    showWindow: () => {},
    minimizeWindow: () => call('minimizeWindow'),
    maximizeWindow: () => {},
    closeWindow: () => call('minimizeWindow'),

    // --- 页面跳转（托盘跳转在 Android 无来源；initPage 对齐桌面首启 show-window 流程）---
    onInitPage: (cb) => { initPageCb = cb; },
    onPageNavigate: (cb) => listen('pageNavigate', cb),

    // --- 设置 / 影视库 / 播放进度（filesDir JSON 原子写，同桌面形状）---
    getSettings: () => call('getSettings'),
    setSettings: (patch) => call('setSettings', patch),
    getLibrary: () => call('getLibrary'),
    setLibrary: (items) => call('setLibrary', items),
    getPosition: (file) => call('getPosition', file),
    setPosition: (file, pos) => call('setPosition', { file, pos }),
    clearPosition: (file) => call('clearPosition', file),

    // --- 本地视频（SAF 目录树扫描 / 文件与目录选择）---
    scanDir: (dir) => call('scanDir', dir),
    scanDirs: (dirs) => call('scanDirs', dirs),
    openFileDialog: () => call('openFileDialog'),
    openDirsDialog: () => call('openDirsDialog'),

    // --- 其它 ---
    getVersion: () => call('getVersion'),
    openExternalLink: (url) => call('openExternalLink', url),

    // --- 浏览器会话（原生侧清 Cookie + 重置标签）---
    resetBrowserSession: () => call('resetBrowserSession'),

    // --- 播放器独立窗口（Android = PlayerActivity）---
    openPlayerWindow: (payload) => call('openPlayerWindow', payload),

    // --- 原生内嵌浏览器（Android 专属，桌面 preload 无此方法）---
    openBrowser: (opts) => call('openBrowser', opts),

    // --- 双渠道更新（Android：检查提示 + 外部浏览器拉 APK）---
    checkForUpdates: () => call('checkForUpdates'),
    downloadUpdate: () => call('downloadUpdate'),
    installUpdate: () => call('installUpdate'),
    onUpdateEvent: (cb) => listen('updateEvent', cb),
  };

  // 首启恢复页面：桌面启动后经 show-window 发 init-page('browser')，Android 等价在脚本装载后补发
  let initPageCb = null;
  setTimeout(() => { if (initPageCb) { const cb = initPageCb; initPageCb = null; cb('browser'); } }, 0);
})();
