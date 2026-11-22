// renderer.js — LG Video 应用编排
// 页面切换（桌面左导航 / Android 底栏 / Ctrl+1..4 / 托盘跳转）+ 窗口控制 + 各模块初始化
// + 全站液态玻璃折射（glass-svg 三目标）+ 更新自动检测触发
window.XVApp = {
  switchPage: null,
};

const IS_ANDROID = document.documentElement.classList.contains('platform-android');

// 导航数据源：桌面侧栏与 Android 底栏同源（对齐 Pointers-BOX 平台分流）
const NAV_ITEMS = [
  {
    page: 'browser', label: '解析&浏览器',
    svg: '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
  },
  {
    page: 'local', label: '本地',
    svg: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
  },
  {
    page: 'library', label: '我的影视',
    svg: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',
  },
  {
    page: 'settings', label: '设置',
    svg: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
  },
];

document.addEventListener('DOMContentLoaded', async () => {

  const $ = (id) => document.getElementById(id);
  const PAGES = ['browser', 'local', 'library', 'settings'];

  // ---------- 页面切换 ----------
  function switchPage(page) {
    if (!PAGES.includes(page)) page = 'browser';
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    document.querySelectorAll('#page-nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    document.querySelectorAll('#bottomnav .bn-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    // class 切换不触发 MutationObserver：手动重扫让新页玻璃卡被折射层接管
    if (window.LGVGlass) window.LGVGlass.rescan();
    // 底栏指示条吸附到新页
    if (IS_ANDROID && window.__bnIndicatorSync) window.__bnIndicatorSync(true);
  }
  window.XVApp.switchPage = switchPage;

  document.querySelectorAll('#page-nav .nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // Ctrl+1..4（输入框聚焦不触发）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && /^1$|^2$|^3$|^4$/.test(e.key)) {
      e.preventDefault();
      switchPage(PAGES[Number(e.key) - 1]);
    }
  });

  // 托盘 / 主进程跳页
  window.voidAPI.onInitPage((page) => switchPage(page));
  window.voidAPI.onPageNavigate((page) => switchPage(page));

  // ---------- Android 底栏渲染（与侧栏同一 NAV 数据源） ----------
  if (IS_ANDROID) {
    const nav = $('bottomnav');
    nav.hidden = false;
    nav.innerHTML = `
      <span id="bn-indicator"></span>` + NAV_ITEMS.map((item) => `
      <button class="bn-item" data-page="${item.page}">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.svg}</svg>
        <span>${item.label}</span>
      </button>
    `).join('');
    nav.querySelectorAll('.bn-item').forEach(btn => {
      btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });

    // ---------- 指示条：左右跟手拖动 + 松手 springEase 吸附（对齐 Pointers-BOX 跟手/预览/吸附） ----------
    const indicator = $('bn-indicator');
    const bnItems = () => Array.from(nav.querySelectorAll('.bn-item'));
    const IND_W = 32;
    const indicatorLeftFor = (idx) => {
      const it = bnItems()[idx];
      return it ? it.offsetLeft + it.offsetWidth / 2 - IND_W / 2 : 0;
    };
    const setIndicator = (left, animate) => {
      const from = parseFloat(indicator.style.left || '0');
      if (!animate || Number.isNaN(from)) {
        indicator.style.left = left + 'px';
        return;
      }
      const t0 = performance.now();
      const ease = window.LGVGlass ? window.LGVGlass.springEase : (t) => t;
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / 460);
        indicator.style.left = from + (left - from) * ease(t) + 'px';
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    function currentActivePage() {
      const act = nav.querySelector('.bn-item.active');
      return act ? act.dataset.page : 'browser';
    }
    window.__bnIndicatorSync = (animate) => {
      const idx = PAGES.indexOf(currentActivePage());
      setIndicator(idx >= 0 ? indicatorLeftFor(idx) : indicatorLeftFor(0), animate);
    };
    // 初始化位置
    requestAnimationFrame(() => window.__bnIndicatorSync(false));

    // 拖动跟手：按下跟移（钳制在栏内），松手吸附最近项并切换页
    // ★11-22 修「四个按钮无法切换」：不再 setPointerCapture（capture 会吞掉
    // bn-item 按钮的原生 click，tap 切页全失效）；改 window 级 move/up 监听跟手。
    let dragX = 0, dragBaseLeft = 0, dragMoved = false, dragging = false;
    // 拖拽松手后浏览器会在按下位置的按钮上派发合成 click，会把刚吸附的页冲掉
    let suppressClick = false;
    let suppressTimer = null;
    const clamp = (v) => Math.max(4, Math.min(nav.clientWidth - IND_W - 4, v));
    nav.addEventListener('pointerdown', (e) => {
      dragX = e.clientX;
      dragBaseLeft = parseFloat(indicator.style.left || '0');
      dragMoved = false;
      dragging = true;
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging || e.buttons === 0) return;
      const dx = e.clientX - dragX;
      if (Math.abs(dx) > 8) dragMoved = true;
      if (dragMoved) indicator.style.left = clamp(dragBaseLeft + dx) + 'px';
    }, { passive: true });
    window.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      if (!dragMoved) return; // tap：bn-item 的 click 原生处理（未 capture，click 正常派发）
      suppressClick = true;
      // 若浏览器最终没派发合成 click，400ms 后自清（防误吞下一次正常 tap）
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; }, 400);
      const x = e.clientX - nav.getBoundingClientRect().left;
      let idx = 0, best = Infinity;
      bnItems().forEach((it, i) => {
        const c = it.offsetLeft + it.offsetWidth / 2;
        const d = Math.abs(x - c);
        if (d < best) { best = d; idx = i; }
      });
      const targetPage = bnItems()[idx].dataset.page;
      if (targetPage !== currentActivePage()) switchPage(targetPage); // 异页：switchPage 内吸附
      else window.__bnIndicatorSync(true); // 同页：指示条回弹吸附原位
    });
    // capture 拦截拖拽后的合成 click（tap<8px 未置 suppressClick，正常放行给 bn-item click 切页）
    nav.addEventListener('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  // ---------- 窗口控制（桌面顶栏；Android 隐藏但保留绑定防御） ----------
  const bindWin = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  };
  bindWin('minimize-button', () => window.voidAPI.minimizeWindow());
  bindWin('maximize-button', () => window.voidAPI.maximizeWindow());
  bindWin('close-button', () => window.voidAPI.closeWindow());

  // ---------- 模块初始化 ----------
  const s = await window.voidAPI.getSettings();
  window.XVApp.settings = s;

  window.XVSettings.init(s);      // 用户卡片/关于/主题/列表/浏览器/播放器/更新/开发者
  window.BrowserX.init(s);        // 解析&浏览器页（首标签 = 起始页）
  window.XVLocal.init(s);         // 本地页
  window.XVLibrary.init();        // 我的影视页

  // ---------- 全站液态玻璃折射（三目标；参数随主题刷新） ----------
  function applyGlass() {
    const st = window.XVThemes.getState();
    const dark = st.theme === 'dark';
    const targets = [];
    if (!IS_ANDROID) {
      // 桌面：内容玻璃卡 + 侧栏全开
      targets.push(
        { selector: '.glass-card', cssVar: '--lgv-g-backdrop', tail: dark
            ? { blur: 24, saturate: 150, brightness: 1.12 }
            : { blur: 22, saturate: 140, brightness: 0.94 } },
        { selector: '.sidebar', cssVar: '--lgv-sb-backdrop', tail: dark
            ? { blur: 30, saturate: 165, brightness: 1 }
            : { blur: 28, saturate: 150, brightness: 1 } },
      );
    }
    // 安卓：只给底栏开折射（★11-22：内容卡折射层×玻璃磨砂×双 webview 把 GPU tile
    // 内存打超限 → 「切出后几乎空白页」；内容卡回落 CSS 磨砂配方，玻璃质感保留）
    targets.push(
      { selector: '.bottom-nav', cssVar: '--lgv-bn-backdrop', refMult: 2.0, tail: dark
          ? { blur: 32, saturate: 175, brightness: 1.05 }
          : { blur: 30, saturate: 160, brightness: 1 } },
    );
    window.LGVGlass.setSvgGlass(true, { ref: dark ? 1.1 : 1.0, edge: dark ? 1.1 : 1.15 }, targets);
  }
  applyGlass();
  // 主题切换时刷新折射档位（themes.js 每次切换都会触发 hydrate → 这里监听 settings 回流）
  const origApply = window.XVSettings.applySettings;
  window.XVSettings.applySettings = (s2) => { origApply(s2); applyGlass(); };

  // ---------- 更新自动检测（5s；autoCheckUpdate 开关） ----------
  window.XVUpdatePrompt.autoCheck(s);
});
