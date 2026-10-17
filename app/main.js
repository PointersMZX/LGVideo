// main.js — LG Video
// 单主窗（frameless）+ <webview> 多标签浏览器 + 本地播放器窗口 + 托盘
// 基底 = AudioVisual 1.0.9 主进程（Widevine/UA/更新链路保留），UI 与功能第二轮重构

const {
  app, screen, BrowserWindow, ipcMain, session, shell, dialog,
  Tray, Menu, nativeImage, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// --- Debounce Utility ---
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// --- Environment & Security Configuration ---
const isDev = false; // Forced to false to disable auto DevTools

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion'); // Fixes some white flashes on Windows
// 允许 SwiftShader 软渲染兜底：液态玻璃 WebGL 层在无硬件 GPU / GPU 被禁用时
// 仍可（以 CPU 软渲染）工作；有硬件 GPU 的机器走 ANGLE/D3D，此开关不影响性能
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

if (isDev) {
  app.commandLine.appendSwitch('ignore-certificate-errors');
  app.on('certificate-error', (event, webContents, url, error, callback) => {
    event.preventDefault();
    callback(true);
  });
}

// --- Application Setup ---
// 打包版：userData 放安装目录旁（与 exe 同级，可写）；dev 版：app/userData
// 注意：不能指进 asar 内部（app.asar/userData 在 Windows 上建不出目录，
// 单实例锁 / 持久层会静默失败）
const dataRoot = app.isPackaged ? path.dirname(process.execPath) : __dirname;
app.setPath('userData', path.join(dataRoot, 'userData'));

// --- 退出标志（关窗 = 隐藏到托盘，仅托盘菜单「退出」才真正退出）---
let isQuitting = false;
const markQuitting = () => { isQuitting = true; };

// --- JSON 持久层（settings.json / library.json / positions.json，原子写）---
const storeFile = (name) => path.join(app.getPath('userData'), name);

function readStore(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(storeFile(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeStore(name, data) {
  try {
    const p = storeFile(name);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error(`Failed to write ${name}:`, e);
  }
}

// 默认设置（解析接口保留原 15 个；影视导航按维护者要求默认清空）
const DEFAULT_SETTINGS = {
  localDirs: [],
  themeId: 'xingyu',
  customThemes: [],
  player: { mode: 'overlay', autoNext: true, rememberPos: true },
  browser: { sleepMinutes: 0, startUrl: 'https://v.qq.com' },
  apiList: [
    { value: "https://jx.xmflv.com/?url=", label: "虾米视频解析" },
    { value: "https://jx.77flv.cc/?url=", label: "七七云解析" },
    { value: "https://jx.playerjy.com/?url=", label: "Player-JY" },
    { value: "https://jiexi.789jiexi.icu:4433/?url=", label: "789解析" },
    { value: "https://jx.2s0.cn/player/?url=", label: "极速解析" },
    { value: "https://bd.jx.cn/?url=", label: "冰豆解析" },
    { value: "https://jx.973973.xyz/?url=", label: "973解析" },
    { value: "https://www.ckplayer.vip/jiexi/?url=", label: "CK" },
    { value: "https://jx.nnxv.cn/tv.php?url=", label: "七哥解析" },
    { value: "https://www.yemu.xyz/?url=", label: "夜幕" },
    { value: "https://www.pangujiexi.com/jiexi/?url=", label: "盘古" },
    { value: "https://www.playm3u8.cn/jiexi.php?url=", label: "playm3u8" },
    { value: "https://video.isyour.love/player/getplayer?url=", label: "芒果TV1" },
    { value: "https://im1907.top/?jx=", label: "芒果TV2" },
    { value: "https://jx.hls.one/?url=", label: "HLS解析" },
  ],
  dramaSites: [], // 第三方导航：默认清空（维护者要求）
  updateChannel: '', // '' = 尚未选择（首启弹窗询问）；'github' 全球官方 / 'gitee' 国内镜像
  agreedPact: false,
};

const getSettings = () => {
  const stored = readStore('settings.json', {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.player = { ...DEFAULT_SETTINGS.player, ...(stored.player || {}) };
  merged.browser = { ...DEFAULT_SETTINGS.browser, ...(stored.browser || {}) };
  return merged;
};

// --- Widevine CDM Injection ---
function getWidevinePath() {
  const platform = os.platform();
  const arch = os.arch();
  const paths = {
    'win32': `${os.homedir()}/AppData/Local/Google/Chrome/User Data/WidevineCdm`,
    'darwin': `${os.homedir()}/Library/Application Support/Google/Chrome/WidevineCdm`,
    'linux': `${os.homedir()}/.config/google-chrome/WidevineCdm`
  };
  if (paths[platform]) {
    if (!fs.existsSync(paths[platform])) return null;
    const versions = fs.readdirSync(paths[platform]).filter(f => fs.statSync(`${paths[platform]}/${f}`).isDirectory());
    if (versions.length > 0) {
      const latestVersion = versions.sort().pop();
      let cdmPath = '';
      if (platform === 'win32') cdmPath = `${paths[platform]}/${latestVersion}/_platform_specific/win_${arch === 'x64' ? 'x64' : 'x86'}/widevinecdm.dll`;
      else if (platform === 'darwin') cdmPath = `${paths[platform]}/${latestVersion}/_platform_specific/mac_${arch}/libwidevinecdm.dylib`;
      else cdmPath = `${paths[platform]}/${latestVersion}/_platform_specific/linux_${arch}/libwidevinecdm.so`;
      if (fs.existsSync(cdmPath)) return { path: cdmPath, version: latestVersion };
    }
  }
  return null;
}
const widevineInfo = getWidevinePath();
if (widevineInfo) {
  app.commandLine.appendSwitch('widevine-cdm-path', widevineInfo.path);
  app.commandLine.appendSwitch('widevine-cdm-version', widevineInfo.version);
} else {
  console.log('Widevine CDM not found.（本机无 Chrome CDM，DRM 站点降级，非错误）');
}

// --- 浏览器 webview 会话与策略（照 Pointers-BOX：共享内存 session + 导航兜底注入）---
const XV_SESSION = 'xvideo-mem'; // 非 persist: 前缀 = 内存型，进程退出即清空（完全退出后重开为未登录态）
const XV_RESET_STORAGES = ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers', 'shadercache', 'websql', 'filesystem'];

// 站点侧 _blank/下载按钮的 window.open 在 Electron 33 会出现 detached pending webview，
// 统一改写为同页导航；a[target=_blank] 捕获阶段拦截
const NAV_OVERRIDE_SCRIPT = `
(() => {
  window.open = function (url) {
    if (url) { try { window.location.href = String(url); } catch (e) {} }
    return null;
  };
  document.addEventListener('click', (ev) => {
    const node = ev.target;
    const a = node && node.closest ? node.closest('a') : null;
    if (a && a.target === '_blank' && a.href) {
      ev.preventDefault();
      ev.stopPropagation();
      try { window.location.href = a.href; } catch (e) {}
    }
  }, true);
})();
`;

function injectNavOverride(contents) {
  contents.executeJavaScript(NAV_OVERRIDE_SCRIPT).catch(() => {});
}

app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;

  // 弹窗 → 同标签加载，拒绝新窗
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      try { contents.loadURL(url); } catch (e) {}
    }
    return { action: 'deny' };
  });

  // 非 http(s) 导航（file:// 等）拦截
  contents.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });

  ['dom-ready', 'did-navigate', 'did-navigate-in-page'].forEach(evt => {
    contents.on(evt, () => injectNavOverride(contents));
  });

  // 右键菜单（系统浏览器逃生门 + 页面操作）
  contents.on('context-menu', (e, params) => {
    const items = [];
    if (params.linkURL) {
      items.push({ label: '在系统浏览器中打开链接', click: () => shell.openExternal(params.linkURL) });
      items.push({ label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) });
    }
    items.push({ type: 'separator' });
    items.push({ label: '用系统浏览器打开此页', click: () => shell.openExternal(params.pageURL) });
    items.push({ label: '刷新页面', click: () => contents.reload() });
    items.push({ label: '后退', click: () => { try { contents.goBack(); } catch (e) {} } });
    Menu.buildFromTemplate(items).popup();
  });
});

app.on('will-attach-webview', (e, webPreferences, params) => {
  e.preventDefault();
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  if (params.partition !== XV_SESSION) {
    e.setGuestSession(session.fromPartition(XV_SESSION));
  }
});

// 站点伪装 UA + 剥离 CSP/XFO（解析/注入链路依赖），主窗 default 会话与 webview 会话都要挂
const SPOOF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
function applySessionFilters(sess) {
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = SPOOF_UA;
    callback({ requestHeaders: details.requestHeaders });
  });
  sess.webRequest.onHeadersReceived((details, callback) => {
    if (details.responseHeaders) {
      const headersToLower = Object.keys(details.responseHeaders).reduce((acc, key) => {
        acc[key.toLowerCase()] = key;
        return acc;
      }, {});
      if (headersToLower['content-security-policy']) delete details.responseHeaders[headersToLower['content-security-policy']];
      if (headersToLower['x-frame-options']) delete details.responseHeaders[headersToLower['x-frame-options']];
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}

function clearBrowserSession() {
  return session.fromPartition(XV_SESSION).clearStorageData({ storages: XV_RESET_STORAGES });
}

// --- 本地视频扫描（主进程 fs）---
const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'flv', 'ts', 'm2ts', '3gp', 'mpg', 'mpeg'];
const SCAN_CAP = 10000;

function scanVideoDir(rootDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= SCAN_CAP) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (out.length >= SCAN_CAP) return;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) {
        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (!VIDEO_EXTS.includes(ext)) continue;
        try {
          const st = fs.statSync(full);
          out.push({ path: full, name: ent.name, ext, size: st.size, mtime: st.mtimeMs });
        } catch (e) { /* 跳过不可读文件 */ }
      }
    }
  };
  walk(rootDir, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// --- 播放器独立窗口（设置里「独立新窗口」形态）---
let playerWin = null;

function openPlayerWindow(payload) {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.show();
    playerWin.focus();
    playerWin.webContents.send('player-load', payload);
    return;
  }
  playerWin = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: '#0d0716',
    title: payload && payload.title ? payload.title : 'LG Video',
    icon: path.join(__dirname, 'assets', 'images', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'assets', 'js', 'preload-player.js'),
    },
  });
  playerWin.setMenu(null);
  const sendLoad = () => { if (playerWin && !playerWin.isDestroyed()) playerWin.webContents.send('player-load', payload); };
  playerWin.webContents.on('did-finish-load', sendLoad);
  playerWin.on('closed', () => { playerWin = null; });
  playerWin.loadFile('player-window.html');
}

// --- Window State Persistence ---
function getWindowState() {
  try {
    const stateFile = path.join(app.getPath('userData'), 'window-state.json');
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read window state:', e);
  }
  return null;
}

function saveWindowState() {
  if (mainWindow) {
    try {
      const stateFile = path.join(app.getPath('userData'), 'window-state.json');
      const state = {
        bounds: mainWindow.getBounds(),
        isMaximized: mainWindow.isMaximized()
      };
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save window state:', e);
    }
  }
}

let mainWindow;
let tray;

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createWindow() {
  const windowState = getWindowState();
  const { workAreaSize } = screen.getPrimaryDisplay();
  const initialWidth = Math.min(1440, Math.round(workAreaSize.width * 0.8));
  const initialHeight = Math.min(1000, Math.round(workAreaSize.height * 0.85));

  const windowOptions = {
    width: windowState?.bounds?.width || initialWidth,
    height: windowState?.bounds?.height || initialHeight,
    x: windowState?.bounds?.x,
    y: windowState?.bounds?.y,
    minWidth: 940,
    minHeight: 620,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0716',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, 'assets', 'js', 'preload-ui.js')
    },
    title: "LG Video",
    icon: path.join(__dirname, 'assets', 'images', 'icon.png'),
    show: false
  };

  mainWindow = new BrowserWindow(windowOptions);

  if (windowState?.isMaximized) mainWindow.maximize();

  const saveStateDebounced = debounce(saveWindowState, 500);
  mainWindow.on('resize', saveStateDebounced);
  mainWindow.on('move', saveStateDebounced);

  // 关窗 = 隐藏到托盘（防误关），真正退出只走托盘菜单「退出」
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    saveWindowState();
    mainWindow = null;
  });

  ipcMain.once('show-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.webContents.send('init-page', 'browser');
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
}

// ---------- IPC（模块级注册一次；window 相关动作经全局 mainWindow 变量） ----------
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('maximize-window', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('close-window', () => { if (mainWindow) mainWindow.close(); });

// --- 设置 / 影视库 / 进度 / 本地扫描 ---
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (event, patch) => {
  const current = getSettings();
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.player) next.player = { ...current.player, ...patch.player };
  if (patch && patch.browser) next.browser = { ...current.browser, ...patch.browser };
  writeStore('settings.json', next);
  return next;
});

ipcMain.handle('library:get', () => readStore('library.json', []));
ipcMain.handle('library:set', (event, items) => {
  const list = Array.isArray(items) ? items : [];
  writeStore('library.json', list);
  return list;
});

ipcMain.handle('position:get', (event, file) => (readStore('positions.json', {})[file]) || null);
ipcMain.handle('position:set', (event, file, pos) => {
  const store = readStore('positions.json', {});
  store[file] = pos;
  writeStore('positions.json', store);
});
ipcMain.handle('position:clear', (event, file) => {
  const store = readStore('positions.json', {});
  delete store[file];
  writeStore('positions.json', store);
});

ipcMain.handle('scan:dir', (event, dir) => scanVideoDir(dir));
ipcMain.handle('scan:dirs', (event, dirs) => {
  const all = [];
  for (const d of (dirs || [])) all.push(...scanVideoDir(d));
  all.sort((a, b) => a.path.localeCompare(b.path));
  return all;
});

ipcMain.handle('dialog:open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择本地视频',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频', extensions: VIDEO_EXTS }],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:open-dirs', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频目录（可多选）',
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('get-version', () => app.getVersion());

// --- 播放器窗口 ---
ipcMain.on('player:open-window', (event, payload) => openPlayerWindow(payload));
ipcMain.on('player:window-controls', (event, action) => {
  if (!playerWin || playerWin.isDestroyed()) return;
  if (action === 'close') playerWin.close();
  else if (action === 'minimize') playerWin.minimize();
  else if (action === 'maximize') {
    if (playerWin.isMaximized()) playerWin.unmaximize();
    else playerWin.maximize();
  } else if (action === 'fullscreen') {
    playerWin.setFullScreen(!playerWin.isFullScreen());
  }
});

// --- 浏览器会话重置 ---
ipcMain.on('reset-browser-session', () => { clearBrowserSession(); });

// --- 托盘跳转页面 ---
ipcMain.on('navigate-page', (event, page) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('page-navigate', page);
});

// --- 托盘（照 Pointers-BOX：关窗藏托盘，完全退出只走托盘菜单）---
function trayIconPath() {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(__dirname, '..', 'build');
  return path.join(root, 'tray.png');
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(trayIconPath());
  } catch (e) {
    console.error('Failed to load tray icon:', e);
  }
  if (!icon || icon.isEmpty()) {
    console.warn('Tray icon unavailable, tray skipped');
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip('LG Video');
  const pageNav = (page) => {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('page-navigate', page);
  };
  const template = [
    { label: '显示窗口', click: () => showMainWindow() },
    { label: '解析&浏览器', click: () => pageNav('browser') },
    { label: '本地', click: () => pageNav('local') },
    { label: '我的影视', click: () => pageNav('library') },
    { label: '设置', click: () => pageNav('settings') },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        markQuitting();
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('double-click', () => showMainWindow());
}

// --- 单实例锁（第二实例 = 聚焦现窗）---
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showMainWindow(); });

  app.whenReady().then(async () => {
    applySessionFilters(session.defaultSession);
    applySessionFilters(session.fromPartition(XV_SESSION));
    await clearBrowserSession(); // 每次启动浏览器会话全新（未登录态）

    createWindow();
    createTray();
  });

  app.on('will-quit', () => {
    markQuitting();
    clearBrowserSession().catch(() => {});
  });

  // 托盘常驻：关窗不退进程；完全退出仅通过托盘菜单「退出」
  app.on('window-all-closed', () => {
    // 不退出（托盘仍在）
  });
}

// --- 双渠道更新（照 Pointers-BOX 设计移植：GitHub/Gitee 均为手动 API 检查 + 流式下载安装包 + 唤起安装器）---
// 用户发布流程：把 NSIS 安装器上传到两个 Release 页即可（GitHub 官方 + Gitee 国内镜像），无需 latest.yml
const { net } = require('electron');

const UPDATE_CHANNELS = {
  github: {
    label: '全球官方（GitHub）',
    api: 'https://api.github.com/repos/PointersMZX/LGVideo/releases/latest',
    page: 'https://github.com/PointersMZX/LGVideo/releases',
    headers: { 'User-Agent': 'LGVideo-Updater', 'Accept': 'application/vnd.github+json' },
  },
  gitee: {
    label: '国内镜像（Gitee）',
    api: 'https://gitee.com/api/v5/repos/PointersMZX/LGVideo/releases/latest',
    page: 'https://gitee.com/PointersMZX/LGVideo/releases',
    headers: { 'User-Agent': 'LGVideo-Updater' },
  },
};

// Win7 兼容构建跑 Electron 22（Chromium 108）；常规版 33+。按 electron 大版本选对应安装器
const isWin7Build = () => parseInt(process.versions.electron, 10) <= 22;

const parseVer = (s) => {
  const m = String(s || '').replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
const isNewerVersion = (remote, local) => {
  const a = parseVer(remote), b = parseVer(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

function requestJson(url, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('请求超时')); }, 15000);
    const req = net.request(url);
    for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, v);
    let data = '';
    req.on('response', (res) => {
      if (res.statusCode === 404) { settled = true; clearTimeout(timer); reject(new Error('未找到 Release（仓库或 Release 尚未创建）')); return; }
      if (res.statusCode === 401 || res.statusCode === 403) { settled = true; clearTimeout(timer); reject(new Error('Release 接口访问受限')); return; }
      if (res.statusCode !== 200) { settled = true; clearTimeout(timer); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        settled = true;
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应数据无效')); }
      });
    });
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    req.end();
  });
}

function matchUpdateAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const exes = assets.filter(a => /\.exe$/i.test(a.name || ''));
  if (!exes.length) return null;
  if (isWin7Build()) return exes.find(a => /win7|windows7/i.test(a.name)) || exes[0];
  return exes.find(a => !/win7|windows7/i.test(a.name)) || exes[0];
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0, received = 0, lastEmit = 0;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { req.abort(); } catch (e) {} reject(new Error('下载超时')); } }, 10 * 60 * 1000);
    const req = net.request(url);
    req.setHeader('User-Agent', 'LGVideo-Updater');
    const ws = fs.createWriteStream(destPath);
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        ws.close();
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`下载失败 HTTP ${res.statusCode}`)); }
        return;
      }
      total = Number(res.headers['content-length']) || 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 250 || (total && received === total)) {
          lastEmit = now;
          if (onProgress) onProgress(total ? received / total : 0, received, total);
        }
      });
      res.pipe(ws);
      ws.on('finish', () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ received }); }
      });
      ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    });
    req.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); try { ws.close(); } catch (err) {} reject(e); } });
    req.end();
  });
}

let lastRelease = null;
let downloadedInstaller = null;

function broadcastUpdate(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
}

async function checkUpdate(channel) {
  const ch = UPDATE_CHANNELS[channel] || UPDATE_CHANNELS.github;
  const release = await requestJson(ch.api, ch.headers);
  const latest = release.tag_name || '';
  const hasUpdate = !!latest && isNewerVersion(latest, app.getVersion());
  const asset = matchUpdateAsset(release.assets);
  if (hasUpdate && !asset) throw new Error('该 Release 未附带可用的 Windows 安装包（.exe）');
  lastRelease = { channel, release, asset, latest };
  downloadedInstaller = null;
  broadcastUpdate({
    type: 'result',
    hasUpdate,
    latest,
    current: app.getVersion(),
    notes: release.body || '',
    releaseUrl: release.html_url || ch.page,
    channel,
  });
  return { hasUpdate, latest };
}

async function downloadUpdate() {
  if (!lastRelease || !lastRelease.hasUpdate) {
    const s = getSettings();
    await checkUpdate(s.updateChannel || 'github');
  }
  const asset = lastRelease.asset;
  const dir = path.join(app.getPath('userData'), 'updates');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `LGVideo-Setup-${lastRelease.latest}.exe`);
  fs.rmSync(dest, { force: true });
  await downloadFile(asset.browser_download_url, dest, (pct, rec, tot) => {
    broadcastUpdate({ type: 'progress', percent: pct, transferred: rec, total: tot });
  });
  if (asset.size && asset.size > 0) {
    const actual = fs.statSync(dest).size;
    if (actual !== asset.size) {
      fs.rmSync(dest, { force: true });
      throw new Error(`安装包大小校验失败（${actual} / ${asset.size}）`);
    }
  }
  downloadedInstaller = dest;
  broadcastUpdate({ type: 'downloaded', path: dest });
}

function installUpdate() {
  if (downloadedInstaller && fs.existsSync(downloadedInstaller)) {
    shell.openPath(downloadedInstaller); // 唤起 NSIS 安装器，随后退出
    markQuitting();
    app.quit();
    return;
  }
  broadcastUpdate({ type: 'error', message: '尚未下载更新包' });
}

ipcMain.handle('update:check', async () => {
  const s = getSettings();
  try {
    return await checkUpdate(s.updateChannel || 'github');
  } catch (e) {
    broadcastUpdate({ type: 'error', message: String(e.message || e) });
    throw e;
  }
});
ipcMain.handle('update:download', async () => {
  try {
    await downloadUpdate();
  } catch (e) {
    broadcastUpdate({ type: 'error', message: String(e.message || e) });
    throw e;
  }
});
ipcMain.handle('update:install', () => { installUpdate(); });

// --- 外部链接 ---
ipcMain.on('open-external-link', (event, url) => { shell.openExternal(url); });
