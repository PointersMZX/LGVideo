// preload-player.js — 播放器独立窗口 preload

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playerAPI', {
  // 主进程装载指令
  onPlayerLoad: (callback) => ipcRenderer.on('player-load', (event, payload) => callback(payload)),

  // 窗口控制（player:window-controls）
  close: () => ipcRenderer.send('player:window-controls', 'close'),
  minimize: () => ipcRenderer.send('player:window-controls', 'minimize'),
  maximize: () => ipcRenderer.send('player:window-controls', 'maximize'),
  toggleFullScreen: () => ipcRenderer.send('player:window-controls', 'fullscreen'),

  // 播放进度记忆（与主窗同一份 positions.json）
  getPosition: (file) => ipcRenderer.invoke('position:get', file),
  setPosition: (file, pos) => ipcRenderer.invoke('position:set', file, pos),
  clearPosition: (file) => ipcRenderer.invoke('position:clear', file),

  // 设置（音量/画面比例等播放器偏好写回主窗同一份 settings.json）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 截图（canvas dataURL → userData/screenshots PNG）
  saveScreenshot: (dataUrl, name) => ipcRenderer.invoke('screenshot:save', dataUrl, name),

  // 本地媒体代理端口（流媒体 m3u8/直连流经代理注头，与主窗共用同一代理）
  ganluProxyPort: () => ipcRenderer.invoke('ganlu-proxy-port'),

  // 剧集页解析（流媒体懒解析：剧集页 → 隐藏窗捕获 m3u8/直链）
  ganluResolve: (payload) => ipcRenderer.invoke('ganlu-resolve', payload),
  ganluResolveCancel: (tag) => ipcRenderer.send('ganlu-resolve-cancel', tag),
  onGanluResolveCapture: (callback) => ipcRenderer.on('ganlu-resolve-capture', (event, payload) => callback(payload)),
  onGanluResolveTimeout: (callback) => ipcRenderer.on('ganlu-resolve-timeout', (event, payload) => callback(payload)),

  // 一起看（syncplay；主进程 TCP/STARTTLS 协议）
  syncplayConnect: (p) => ipcRenderer.invoke('ganlu-syncplay-connect', p),
  syncplayState: (p) => ipcRenderer.invoke('ganlu-syncplay-state', p),
  syncplayChat: (p) => ipcRenderer.invoke('ganlu-syncplay-chat', p),
  syncplayClose: (p) => ipcRenderer.invoke('ganlu-syncplay-close', p),
  onSyncplayEvent: (callback) => ipcRenderer.on('ganlu-syncplay-event', (event, payload) => callback(payload)),
  onSyncplayConnected: (callback) => ipcRenderer.on('ganlu-syncplay-connected', (event, payload) => callback(payload)),
  onSyncplayConnectFailed: (callback) => ipcRenderer.on('ganlu-syncplay-connect-failed', (event, payload) => callback(payload)),
});
