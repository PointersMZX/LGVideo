// renderer.js — LG Video 应用编排
// 页面切换（左导航 / Ctrl+1..4 / 托盘跳转）+ 窗口控制 + 各模块初始化
window.XVApp = {
  switchPage: null,
};

document.addEventListener('DOMContentLoaded', async () => {

  const $ = (id) => document.getElementById(id);
  const PAGES = ['browser', 'local', 'library', 'settings'];

  // ---------- 页面切换 ----------
  function switchPage(page) {
    if (!PAGES.includes(page)) page = 'browser';
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    document.querySelectorAll('#page-nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
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

  // ---------- 窗口控制（顶栏） ----------
  $('minimize-button').addEventListener('click', () => window.voidAPI.minimizeWindow());
  $('maximize-button').addEventListener('click', () => window.voidAPI.maximizeWindow());
  $('close-button').addEventListener('click', () => window.voidAPI.closeWindow());

  // ---------- 模块初始化 ----------
  const s = await window.voidAPI.getSettings();
  window.XVApp.settings = s;

  window.XVSettings.init(s);      // 关于/主题/列表/浏览器/播放器/更新（首启渠道与协议弹窗在此触发）
  window.BrowserX.init(s);       // 解析&浏览器页（首标签 = 起始页）
  window.XVLocal.init(s);        // 本地页
  window.XVLibrary.init();       // 我的影视页
});
