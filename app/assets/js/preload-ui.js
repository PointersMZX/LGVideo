// preload-ui.js — LG Video 主窗 preload

const { contextBridge, ipcRenderer } = require('electron');

// 解析窗事件分发：单一 IPC 监听 + 处理函数表（避免每次调用都 ipcRenderer.on 累积）
const glResolveCaptureHandlers = [];
const glResolveTimeoutHandlers = [];
ipcRenderer.on('ganlu-resolve-capture', (event, payload) => glResolveCaptureHandlers.forEach((h) => h(payload)));
ipcRenderer.on('ganlu-resolve-timeout', (event, payload) => glResolveTimeoutHandlers.forEach((h) => h(payload)));

contextBridge.exposeInMainWorld('voidAPI', {
  // --- 窗口控制 ---
  showWindow: () => ipcRenderer.send('show-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  // --- 页面（左导航 / 托盘跳转）---
  onInitPage: (callback) => ipcRenderer.on('init-page', (event, page) => callback(page)),
  onPageNavigate: (callback) => ipcRenderer.on('page-navigate', (event, page) => callback(page)),

  // --- 设置 / 影视库 / 播放进度（JSON 持久层，主进程原子写）---
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  setLibrary: (items) => ipcRenderer.invoke('library:set', items),
  getPosition: (file) => ipcRenderer.invoke('position:get', file),
  setPosition: (file, pos) => ipcRenderer.invoke('position:set', file, pos),
  clearPosition: (file) => ipcRenderer.invoke('position:clear', file),

  // --- 本地视频（目录扫描 / 文件与目录对话框）---
  scanDir: (dir) => ipcRenderer.invoke('scan:dir', dir),
  scanDirs: (dirs) => ipcRenderer.invoke('scan:dirs', dirs),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-files'),
  openDirsDialog: () => ipcRenderer.invoke('dialog:open-dirs'),

  // --- 其它 ---
  getVersion: () => ipcRenderer.invoke('get-version'),
  openExternalLink: (url) => ipcRenderer.send('open-external-link', url),

  // --- 浏览器会话（webview 内存 session 重置）---
  resetBrowserSession: () => ipcRenderer.send('reset-browser-session'),

  // --- 浏览器手机模式（按标签 webContentsId 上报 UA 覆写；mode='mobile'|'desktop'）---
  setBrowserUaMode: (wcId, mode) => ipcRenderer.send('browser-ua-mode', wcId, mode),

  // --- 播放器独立窗口 ---
  openPlayerWindow: (payload) => ipcRenderer.send('player:open-window', payload),

  // --- 播放器截图（canvas dataURL → userData/screenshots PNG）---
  saveScreenshot: (dataUrl, name) => ipcRenderer.invoke('screenshot:save', dataUrl, name),

  // --- 甘露影视源：抓取代理（规则引擎/公共数据/识图/弹幕，主进程代抓绕 CORS + cookie jar + 弹幕签名）---
  ganluFetch: (payload) => ipcRenderer.invoke('ganlu-fetch', payload),

  // --- 甘露影视源：数据持久（ganlu.json / plugins.json）---
  ganluGetStore: () => ipcRenderer.invoke('ganlu-store:get'),
  ganluSetStore: (patch) => ipcRenderer.invoke('ganlu-store:set', patch),
  ganluGetPlugins: () => ipcRenderer.invoke('ganlu-plugins:get'),
  ganluSetPlugins: (list) => ipcRenderer.invoke('ganlu-plugins:set', list),

  // --- 甘露影视源：剧集页解析（隐藏窗口捕获 m3u8/直链，按 tag 回报；on/off 设计防监听器累积）---
  ganluResolve: (payload) => ipcRenderer.invoke('ganlu-resolve', payload),
  ganluResolveCancel: (tag) => ipcRenderer.send('ganlu-resolve-cancel', tag),
  onGanluResolveCapture: (callback) => { glResolveCaptureHandlers.push(callback); },
  offGanluResolveCapture: (callback) => {
    const i = glResolveCaptureHandlers.indexOf(callback);
    if (i >= 0) glResolveCaptureHandlers.splice(i, 1);
  },
  onGanluResolveTimeout: (callback) => { glResolveTimeoutHandlers.push(callback); },
  offGanluResolveTimeout: (callback) => {
    const i = glResolveTimeoutHandlers.indexOf(callback);
    if (i >= 0) glResolveTimeoutHandlers.splice(i, 1);
  },

  // --- 甘露影视源：本地媒体代理（m3u8 改写 + 头注入）---
  ganluProxyPort: () => ipcRenderer.invoke('ganlu-proxy-port'),

  // --- 甘露影视源：m3u8 下载器 ---
  ganluDownloadStart: (task) => ipcRenderer.invoke('ganlu-download-start', task),
  ganluDownloadPause: (taskId) => ipcRenderer.invoke('ganlu-download-pause', taskId),
  ganluDownloadCancel: (taskId) => ipcRenderer.invoke('ganlu-download-cancel', taskId),
  onGanluDownloadProgress: (callback) => ipcRenderer.on('ganlu-download-progress', (event, payload) => callback(payload)),

  // --- 甘露影视源：一起看（syncplay）---
  ganluSyncplayConnect: (p) => ipcRenderer.invoke('ganlu-syncplay-connect', p),
  ganluSyncplayState: (p) => ipcRenderer.invoke('ganlu-syncplay-state', p),
  ganluSyncplayChat: (p) => ipcRenderer.invoke('ganlu-syncplay-chat', p),
  ganluSyncplayClose: (p) => ipcRenderer.invoke('ganlu-syncplay-close', p),
  onGanluSyncplayEvent: (callback) => ipcRenderer.on('ganlu-syncplay-event', (event, payload) => callback(payload)),
  onGanluSyncplayConnected: (callback) => ipcRenderer.on('ganlu-syncplay-connected', (event, payload) => callback(payload)),
  onGanluSyncplayConnectFailed: (callback) => ipcRenderer.on('ganlu-syncplay-connect-failed', (event, payload) => callback(payload)),

  // --- 甘露影视源：DLNA 投屏 ---
  ganluDlnaDiscover: () => ipcRenderer.invoke('ganlu-dlna-discover'),
  ganluDlnaCast: (p) => ipcRenderer.invoke('ganlu-dlna-cast', p),

  // --- 双渠道更新（GitHub 官方 / Gitee 镜像；主进程手动 API 检查 + 流式下载 + 唤起安装器）---
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (callback) => ipcRenderer.on('update-event', (event, payload) => callback(payload)),
});
