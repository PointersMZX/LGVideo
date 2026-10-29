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
});
