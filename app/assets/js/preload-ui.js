// preload-ui.js — XingyuVideo 主窗 preload

const { contextBridge, ipcRenderer } = require('electron');

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

  // --- 解析引擎（站点侧主动探测转发，链路保留）---
  onFastParseUrl: (callback) => ipcRenderer.on('fast-parse-url', (event, url) => callback(url)),

  // --- 播放器独立窗口 ---
  openPlayerWindow: (payload) => ipcRenderer.send('player:open-window', payload),

  // --- 双渠道更新（GitHub 官方 / Gitee 镜像；主进程手动 API 检查 + 流式下载 + 唤起安装器）---
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (callback) => ipcRenderer.on('update-event', (event, payload) => callback(payload)),
});
