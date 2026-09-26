// browser.js — 解析&浏览器页（照 Pointers-BOX 内嵌浏览器设计移植为 vanilla JS）
// 结构：解析选项顶行 → 多标签条（webview 堆叠）→ 浏览器工具栏（进度发丝线）→ webview 区
// 会话：共享内存 session xvideo-mem（主进程 will-attach-webview 强制）；标签休眠可配；重置会话清空登录态
;(function initBrowser() {

  const $ = (id) => document.getElementById(id);
  const tabStrip = $('tab-strip');
  const webviewStack = $('webview-stack');
  const urlInput = $('url-input');
  const goButton = $('go-button');
  const backBtn = $('btab-back');
  const fwdBtn = $('btab-forward');
  const reloadBtn = $('btab-reload');
  const resetBtn = $('btab-reset');
  const progressBar = $('progress-bar');
  const platformSelect = $('platform-select');
  const apiSelect = $('api-select');
  const parseButton = $('parse-button');
  const navsiteSelect = $('navsite-select');
  const navsiteEmpty = $('navsite-empty');
  const modeToggle = $('quick-mode-toggle');
  const youkuPage = $('youku-custom-page');
  const youkuUrlInput = $('youku-url-input');
  const loadingOverlay = $('loading-overlay');

  // 平台导航（功能数据，保留）
  const platforms = [
    { value: 'https://v.qq.com', label: '腾讯视频' },
    { value: 'https://www.iqiyi.com', label: '爱奇艺' },
    { value: 'https://www.youku.com', label: '优酷' },
    { value: 'https://www.bilibili.com', label: '哔哩哔哩' },
    { value: 'https://www.mgtv.com', label: '芒果TV' },
  ];

  // --- 站点侧注入 CSS（原 main.js injectThemeCss 迁移到渲染端 webview.insertCSS）---
  const NUISANCE_CSS = `
    /* 强制隐藏已知顽固弹窗 */
    [class*="popwin_fullCover"],
    [class*="shapedPopup_container"],
    [class*="notSupportedDrm_drmTipsPopBox"],
    [class*="floatPage_floatPage"],
    #tvgCashierPage,
    .browser-ver-tip,
    .qy-dialog-container,
    .iqp-player-guide,
    .mgtv-player-layers, .mgtv-player-ad, .mgtv-player-overlay, #m-player-ad {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      width: 0 !important;
      height: 0 !important;
      z-index: -9999 !important;
    }
  `;
  const VIEW_SCROLLBAR_CSS = `
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--av-primary-bg); }
    ::-webkit-scrollbar-thumb { background-color: var(--av-accent-color); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background-color: var(--av-highlight-color); }
    .notSupportedDrm_drmTipsPopBox__hqd7B, .notSupportedDrm_drmTipsPopBoxCover__c-A0d { display: none !important; }
  `;
  // 解析模式 = 紫金黑（XingyuMusic xingyu）；第三方导航模式 = 黑底绿字（站点皮肤，功能保留）
  const AV_VARS = {
    parse: `:root { --av-primary-bg: #0d0716; --av-accent-color: #321b4d; --av-highlight-color: #e8c98a; }`,
    nav: `:root { --av-primary-bg: #000000; --av-accent-color: #333333; --av-highlight-color: #C0FAA0; }`,
  };

  // --- 状态 ---
  let settings = { browser: { sleepMinutes: 0, startUrl: 'https://v.qq.com' }, apiList: [], dramaSites: [] };
  let tabs = [];           // { id, url, title, lastActiveAt }
  let activeId = null;
  let tabCounter = 0;
  const webviewEls = new Map();   // tabId -> <webview>（休眠时移除，唤醒时重建）
  const initialUrls = new Map();  // tabId -> 首次挂载 src
  let lastUrls = new Map();       // tabId -> 休眠前的最新 URL
  let currentVideoUrl = '';
  let currentYoukuUrl = '';
  let isCurrentlyParsing = false;
  let mode = 'parse';        // 'parse' 普通解析 | 'nav' 第三方导航
  let youkuActive = false;
  let sleepTimer = 0;
  let loadingSafeTimer = 0;  // 转圈遮罩兜底：无论 webview 是否触发 did-stop，N 秒后强制隐藏，杜绝卡死

  // 显示转圈遮罩并挂一个安全定时器（保证它绝不会滞留挡住界面）
  function showLoading() {
    loadingOverlay.classList.remove('hidden');
    clearTimeout(loadingSafeTimer);
    loadingSafeTimer = setTimeout(() => {
      loadingOverlay.classList.add('hidden');
    }, 6000);
  }
  function hideLoading() {
    clearTimeout(loadingSafeTimer);
    loadingOverlay.classList.add('hidden');
  }

  // ---------- 工具 ----------
  const hostOf = (url) => {
    try { return new URL(url).hostname; } catch (e) { return url; };
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  // 地址归一化（照 Pointers-BOX normalizeAddressInput）
  const normalizeAddressInput = (raw) => {
    const input = String(raw || '').trim();
    if (!input) return settings.browser.startUrl || 'https://v.qq.com';
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}(:\d+)?)$/i.test(input)) return 'http://' + input;
    if (/^(https?:|data:|about:)/i.test(input)) return input;
    if (!/\s/.test(input) && input.includes('.')) return 'https://' + input;
    return 'https://www.bing.com/search?q=' + encodeURIComponent(input);
  };

  // ---------- 标签状态机（照 Pointers-BOX browserStore）----------
  function newTab(url) {
    const id = 'tab-' + (++tabCounter);
    const target = url || settings.browser.startUrl || 'https://v.qq.com';
    tabs.push({ id, url: target, title: hostOf(target), lastActiveAt: Date.now() });
    activateTab(id, true);
    renderTabs();
    return id;
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const wasActive = activeId === id;
    tabs.splice(idx, 1);
    unmountWebview(id);
    lastUrls.delete(id);
    if (tabs.length === 0) {
      newTab(); // 至少保留一个标签
      return;
    }
    if (wasActive) {
      const neighbor = tabs[Math.min(idx, tabs.length - 1)];
      neighbor.lastActiveAt = Date.now();
      activateTab(neighbor.id, true);
    }
    renderTabs();
  }

  function reorderTabs(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= tabs.length || toIdx >= tabs.length) return;
    const [moved] = tabs.splice(fromIdx, 1);
    tabs.splice(toIdx, 0, moved);
    renderTabs();
  }

  function activateTab(id, remount = false) {
    activeId = id;
    const tab = tabs.find(t => t.id === id);
    if (tab) tab.lastActiveAt = Date.now();
    if (remount) mountWebview(id);
    // 显示/隐藏
    for (const [tid, el] of webviewEls) {
      el.style.display = tid === id ? 'flex' : 'none';
    }
    renderTabs();
    syncNavState();
  }

  // ---------- webview 创建 / 休眠 ----------
  function mountWebview(id) {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    let wv = webviewEls.get(id);
    if (wv && !wv.isConnected) wv = null;
    if (!wv) {
      wv = document.createElement('webview');
      wv.setAttribute('partition', 'xvideo-mem');
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('preload', 'assets/js/preload-web.js');
      wv.setAttribute('id', 'wv-' + id);
      // 首次挂载 src = 该标签当前 URL（休眠唤醒时回到休眠前地址，登录态由共享会话保持）
      const src = initialUrls.has(id) ? initialUrls.get(id) : (lastUrls.get(id) || tab.url);
      initialUrls.set(id, src);
      wv.src = src;
      webviewEls.set(id, wv);
      bindWebview(id, wv);
      webviewStack.appendChild(wv);
    }
    wv.style.display = id === activeId ? 'flex' : 'none';
    // 缩放逻辑（原 updateZoomFactor：按视口宽度对齐 1400 理想宽度）
    updateZoom(wv);
    // 立即补一次 CSS 注入（休眠唤醒后 guest 文档重建）
    if (wv.contentsReady) injectGuestCSS(wv);
  }

  function unmountWebview(id) {
    const wv = webviewEls.get(id);
    if (wv) {
      try { const u = wv.getURL(); if (u) lastUrls.set(id, u); } catch (e) {}
      wv.remove();
    }
    webviewEls.delete(id);
  }

  const updateZoom = debounce((wv) => {
    try {
      const w = webviewStack.clientWidth;
      if (w > 0 && wv && wv.setZoomFactor) wv.setZoomFactor(w / 1400);
    } catch (e) {}
  }, 150);

  // 标签休眠（照 Pointers-BOX：非激活标签空闲 N 分钟卸载内存，唤醒回原地址）
  function sleepTick() {
    const minutes = Number(settings.browser.sleepMinutes || 0);
    if (minutes <= 0) return;
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.id === activeId) continue;
      if (now - tab.lastActiveAt > minutes * 60000) {
        if (webviewEls.has(tab.id)) unmountWebview(tab.id);
      }
    }
  }

  function bindWebview(id, wv) {
    if (wv.__xvBound) return;
    wv.__xvBound = true;

    wv.addEventListener('did-start-loading', () => {
      if (id === activeId) {
        progressBar.style.width = '35%';
        // 只在「解析」动作时弹转圈层（triggerParse/parseYoukuUrl 内处理，且有 1.5s 兜底）；
        // 普通导航/起始页加载不再弹全屏遮罩，避免 API 页不触发 did-stop-loading 时转圈卡死
      }
    });
    wv.addEventListener('did-stop-loading', () => {
      if (id === activeId) {
        progressBar.style.width = '0';
        hideLoading();
        syncNavState();
      }
    });
    wv.addEventListener('page-title-updated', (e) => {
      const tab = tabs.find(t => t.id === id);
      if (tab && e.title) { tab.title = e.title; renderTabs(); }
    });

    const onNavigated = (url) => {
      const tab = tabs.find(t => t.id === id);
      if (tab && url && url !== 'about:blank') { tab.url = url; lastUrls.set(id, url); }
      if (id !== activeId) return;
      // 地址栏同步（解析 API 中间地址回显原视频链接）
      const isApiUrl = settings.apiList.some(a => a.value && url.startsWith(a.value));
      if (isApiUrl) {
        urlInput.value = currentYoukuUrl || currentVideoUrl;
      } else {
        urlInput.value = url;
        currentVideoUrl = url;
        // 不再自动解析：仅在用户单击「解析」按钮时触发一次（维护者要求：不要自动解析）
      }
      // 导航到第三方导航站点 → 自动切 nav 模式
      const site = settings.dramaSites.find(s => url.startsWith(s.value));
      if (site && mode === 'parse') switchMode('nav', true);
    };
    wv.addEventListener('did-navigate', (e) => onNavigated(e.url));
    wv.addEventListener('did-navigate-in-page', (e) => {
      const tab = tabs.find(t => t.id === id);
      if (tab && e.url) tab.url = e.url;
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // ABORTED（被新导航取代，由新导航的 did-start 负责显示）
      if (id === activeId) hideLoading();
    });
    wv.addEventListener('dom-ready', () => {
      injectGuestCSS(wv);
      updateZoom(wv);
    });
  }

  // 站点侧 CSS 注入（主题变量 + 滚动条 + 顽固弹窗隐藏）
  function injectGuestCSS(wv) {
    try {
      const css = AV_VARS[mode] + '\n' + VIEW_SCROLLBAR_CSS + '\n' + NUISANCE_CSS;
      wv.insertCSS(css).catch(() => {});
    } catch (e) {}
  }

  // ---------- 标签条渲染 ----------
  function renderTabs() {
    // 移除旧 pill（保留 + 按钮）
    tabStrip.querySelectorAll('.tab-pill').forEach(el => el.remove());
    const newBtn = tabStrip.querySelector('.tab-new');
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      const pill = document.createElement('div');
      pill.className = 'tab-pill' + (t.id === activeId ? ' active' : '');
      pill.draggable = true;
      pill.dataset.idx = String(i);
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = t.title || hostOf(t.url);
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '关闭标签';
      close.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(t.id); });
      pill.appendChild(title);
      pill.appendChild(close);
      pill.addEventListener('click', () => activateTab(t.id));
      pill.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/xv-tab', String(i)); });
      pill.addEventListener('dragover', (ev) => ev.preventDefault());
      pill.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const from = Number(ev.dataTransfer.getData('text/xv-tab'));
        reorderTabs(from, Number(pill.dataset.idx));
      });
      tabStrip.insertBefore(pill, newBtn);
    }
  }

  function syncNavState() {
    const wv = webviewEls.get(activeId);
    if (!wv) return;
    try {
      backBtn.disabled = !wv.canGoBack();
      fwdBtn.disabled = !wv.canGoForward();
    } catch (e) { backBtn.disabled = true; fwdBtn.disabled = true; }
  }

  // ---------- 导航 ----------
  function navigate(url, isPlatformSwitch) {
    urlInput.value = url;
    currentVideoUrl = url;
    isCurrentlyParsing = false;
    const wv = webviewEls.get(activeId) || (mountWebview(activeId), webviewEls.get(activeId));
    if (youkuActive && !isPlatformSwitch) { /* 优酷页保持 */ }
    youkuActive = false;
    youkuPage.style.display = 'none';
    webviewStack.style.display = '';
    if (wv) {
      try { if (wv.getURL() === url) wv.reload(); else wv.loadURL(url); } catch (e) {}
    }
    if (isPlatformSwitch) renderTabs();
  }

  function go() {
    let url = urlInput.value.trim();
    if (!url) { navigate(settings.browser.startUrl || 'https://v.qq.com'); return; }
    if (!/^https?:\/\//i.test(url)) url = normalizeAddressInput(url);
    navigate(url, true);
  }

  // ---------- 解析 ----------
  function populateSelect(sel, items) {
    sel.innerHTML = '';
    for (const item of items) {
      const o = document.createElement('option');
      o.value = item.value;
      o.textContent = item.label;
      sel.appendChild(o);
    }
  }

  function triggerParse() {
    const isHomepage = platforms.some(p => currentVideoUrl === p.value || currentVideoUrl === p.value + '/');
    if (isHomepage) {
      showToast('当前页面为平台首页，请选择具体的视频后再点击解析。', 'error');
      isCurrentlyParsing = false;
      hideLoading();
      return;
    }
    if (isCurrentlyParsing && currentVideoUrl) {
      showLoading();
      const api = settings.apiList.find(a => a.value === apiSelect.value) || settings.apiList[0];
      const finalUrl = (api ? api.value : '') + currentVideoUrl;
      const wv = webviewEls.get(activeId);
      if (wv) {
        try { wv.loadURL(finalUrl); } catch (e) {}
      }
      setTimeout(hideLoading, 1500);
    } else {
      console.warn('[Browser] 解析失败：缺少 URL 或非解析态');
      hideLoading();
    }
  }

  function parseYoukuUrl() {
    const u = (youkuUrlInput.value.trim() || currentYoukuUrl);
    if (!u) { showToast('请输入有效的优酷视频链接。', 'error'); return; }
    currentYoukuUrl = u;
    currentVideoUrl = u;
    urlInput.value = u;
    const api = settings.apiList.find(a => a.value === apiSelect.value) || settings.apiList[0];
    const finalUrl = (api ? api.value : '') + u;
    showLoading();
    const wv = webviewEls.get(activeId);
    if (wv) { try { wv.loadURL(finalUrl); } catch (e) {} youkuPage.style.display = 'none'; }
    setTimeout(hideLoading, 1500);
  }

  // ---------- 模式切换（普通解析 ⇄ 第三方导航）----------
  function setModeClass() {
    document.body.classList.toggle('drama-mode', mode === 'nav');
    const dramaTheme = document.getElementById('drama-theme');
    if (dramaTheme) dramaTheme.disabled = mode !== 'nav';
    const parseControls = document.querySelector('#page-browser .parse-controls');
    const navsiteControls = document.querySelector('#page-browser .navsite-controls');
    if (parseControls) parseControls.classList.toggle('hidden', mode === 'nav');
    if (navsiteControls) navsiteControls.classList.toggle('hidden', mode !== 'nav');
    navsiteEmpty.hidden = !(mode === 'nav' && settings.dramaSites.length === 0);
    const icon = modeToggle.querySelector('.mode-icon');
    if (icon) icon.textContent = mode === 'nav' ? '🏠' : '🌐';
    modeToggle.dataset.tooltip = mode === 'nav' ? '普通解析' : '第三方导航';
    // 模式切换后重注入所有 webview 的站点 CSS
    for (const [tid, wv] of webviewEls) {
      if (wv.contentsReady) injectGuestCSS(wv);
    }
  }

  function switchMode(to, silent) {
    if (mode === to) return;
    mode = to;
    if (to === 'nav') {
      if (settings.dramaSites.length === 0) {
        setModeClass();
        if (!silent) showToast('暂无导航站点，可前往「设置 → 影视导航管理」添加', 'info');
        return;
      }
      navsiteSelect.value = settings.dramaSites[0].value;
      navigate(settings.dramaSites[0].value, true);
    } else {
      const home = platformSelect.value || 'https://v.qq.com';
      navigate(home === 'https://www.youku.com' ? 'https://www.youku.com' : home, true);
      if (home === 'https://www.youku.com') enterYoukuPage();
    }
    setModeClass();
  }

  function enterYoukuPage() {
    youkuActive = true;
    youkuPage.style.display = 'flex';
    webviewStack.style.display = 'none';
  }

  // ---------- 会话重置（照 Pointers-BOX：清内存会话 + 全部标签回起始页）----------
  function resetSession() {
    window.voidAPI.resetBrowserSession();
    for (const t of tabs) {
      lastUrls.delete(t.id);
      initialUrls.delete(t.id);
      t.url = settings.browser.startUrl || 'https://v.qq.com';
      t.title = hostOf(t.url);
      t.lastActiveAt = Date.now();
    }
    for (const [tid] of webviewEls) unmountWebview(tid);
    const active = tabs.find(t => t.id === activeId) || tabs[0];
    if (active) mountWebview(active.id);
    renderTabs();
  }

  // ---------- 外部接口 ----------
  window.BrowserX = {
    init(s) {
      settings = {
        browser: s.browser,
        apiList: s.apiList,
        dramaSites: s.dramaSites,
      };
      populateSelect(platformSelect, platforms);
      populateSelect(apiSelect, settings.apiList);
      populateSelect(navsiteSelect, settings.dramaSites.length ? settings.dramaSites : [{ value: '', label: '（未配置）' }]);

      // 工具栏
      goButton.addEventListener('click', go);
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      backBtn.addEventListener('click', () => { const wv = webviewEls.get(activeId); if (wv && wv.canGoBack()) wv.goBack(); });
      fwdBtn.addEventListener('click', () => { const wv = webviewEls.get(activeId); if (wv && wv.canGoForward()) wv.goForward(); });
      reloadBtn.addEventListener('click', () => { const wv = webviewEls.get(activeId); if (wv) wv.reload(); });
      resetBtn.addEventListener('click', async () => {
        const ok = await showConfirm('确定重置浏览器会话？\n将清除登录态并关闭所有标签，回到起始页。');
        if (ok) resetSession();
      });

      // 标签条 + 按钮
      const newBtn = document.createElement('button');
      newBtn.className = 'tab-new';
      newBtn.textContent = '+';
      newBtn.title = '新建标签';
      newBtn.addEventListener('click', () => newTab());
      tabStrip.appendChild(newBtn);

      // 解析选项
      platformSelect.addEventListener('change', () => {
        isCurrentlyParsing = false;
        currentYoukuUrl = '';
        const sel = platformSelect.value;
        if (sel === 'https://www.youku.com') enterYoukuPage();
        else navigate(sel, true);
      });
      apiSelect.addEventListener('change', () => {
        // 换接口不再自动解析（维护者要求：解析只由「解析」按钮单击触发）
      });
      parseButton.addEventListener('click', () => {
        showLoading();
        if (platformSelect.value === 'https://www.youku.com') parseYoukuUrl();
        else {
          isCurrentlyParsing = true;
          requestAnimationFrame(() => triggerParse());
        }
      });
      navsiteSelect.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v) navigate(v, true);
      });
      modeToggle.addEventListener('click', () => switchMode(mode === 'parse' ? 'nav' : 'parse'));

      youkuUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') parseYoukuUrl(); });

      // 休眠 tick
      sleepTimer = setInterval(sleepTick, 60000);

      // 启动标签
      newTab();
      setModeClass();
    },

    refreshLists(newSettings) {
      settings.apiList = newSettings.apiList;
      settings.dramaSites = newSettings.dramaSites;
      settings.browser = newSettings.browser;
      populateSelect(apiSelect, settings.apiList);
      populateSelect(navsiteSelect, settings.dramaSites.length ? settings.dramaSites : [{ value: '', label: '（未配置）' }]);
      navsiteEmpty.hidden = !(mode === 'nav' && settings.dramaSites.length === 0);
    },

    openUrl(url) {
      // 我的影视 URL 集数 / 其它页面跳转：新标签打开
      newTab(url);
      window.XVApp.switchPage('browser');
    },

    loadInActive(url) {
      const wv = webviewEls.get(activeId);
      if (wv) { try { wv.loadURL(url); } catch (e) {} }
    },

    currentSettings() { return settings; },
    getMode() { return mode; },
  };

  // 供本地页 / 我的影视页调用
  window.XVPlayerContext = null;
})()

// 全局 toast（原 renderer.js showToast）
function showToast(message, type = 'info') {
  const bgColor = type === 'error' ? '#ff6768' : (type === 'success' ? '#4caf50' : 'var(--accent-color, #321b4d)');
  Toastify({
    text: message,
    duration: 3000,
    gravity: 'top',
    position: 'center',
    offset: { y: 52 },
    stopOnFocus: true,
    style: {
      background: bgColor,
      borderRadius: '8px',
      boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
      fontSize: '14px',
      fontWeight: '500'
    }
  }).showToast();
}

// 全局确认弹窗（原 renderer.js showConfirm）
function showConfirm(message, title = '提示信息') {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const titleEl = document.getElementById('modal-title');
    const messageEl = document.getElementById('modal-message');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');
    if (!modal) { resolve(confirm(message)); return; }
    titleEl.textContent = title;
    messageEl.textContent = message;
    modal.style.display = 'flex';
    const cleanup = (result) => {
      modal.style.display = 'none';
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(result);
    };
    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
  });
}
