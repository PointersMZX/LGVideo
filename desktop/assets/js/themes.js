// themes.js — LG Video 主题系统 v2（对齐 Pointers-BOX v2.6.0 形态）
// light/dark 双主题（旧键迁移）+ 用户自定义强调色（强调色通用、键位选中零色）
// + 液态玻璃零染色材质链（--lgv-* 变量 + flatMaterial 退化链，组件不感知开关）
// 持久化：settings.json 的 theme / themeAccent（localStorage 同步快取防闪变）
;(function initThemes() {

  const DEFAULT_ACCENT = '#8b30d6';

  const hexToRgba = (hex, alpha) => {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return `rgba(0,0,0,${alpha})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  // 旧主题键 → 新双主题（对齐 Pointers-BOX migrateThemeKey 语义）
  function migrateThemeKey(raw) {
    const k = String(raw || '');
    if (k === 'dark' || k === 'light') return k;
    if (k === 'white') return 'light';
    // xingyu 紫金黑 / black 纯黑 / glass / custom-* 及未知 → dark
    return 'dark';
  }

  function normalizeAccent(raw) {
    let h = String(raw || '').trim().replace('#', '').toLowerCase();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/.test(h)) return DEFAULT_ACCENT;
    return '#' + h;
  }

  // ---------- 材质档位（Pointers-BOX buildTheme SURFACES 数值 + LGVideo 流动背景） ----------
  // ★11-22 用户定案：深色=纯黑、浅色=纯白（基底零紫调，紫色只出现在强调色且可自定义）；
  // 流动光斑去紫改中性白光斑（保留流动质感、不染色），舞台光取消。
  const SURFACES = {
    dark: {
      appBg: '#000000',
      secondaryBg: '#101010',
      sidebarBg: '#0a0a0a',
      textPrimary: '#f5f5f5',
      textMuted: '#9a9a9a',
      // 磨砂三件套
      blur: 24, saturate: 150, brightness: 1.12,
      sidebarBlur: 30, sidebarSaturate: 165,
      bottomnavBlur: 32, bottomnavSaturate: 175,
      // 棱线 / 内泛光 / 光泽 / 投影 / 噪点（零染色：hi/lo 恒 transparent）
      edge: 'rgba(255, 255, 255, 0.14)',
      border: 'rgba(255, 255, 255, 0.18)',
      rimTop: 'rgba(255, 255, 255, 0.34)',
      rimBottom: 'rgba(255, 255, 255, 0.10)',
      innerGlow: 'rgba(255, 255, 255, 0.05)',
      sheenColor: 'rgba(255, 255, 255, 0.12)',
      shadow: '0 10px 34px rgba(0, 0, 0, 0.50)',
      grainOpacity: 0.06,
      navActive: 'rgba(255, 255, 255, 0.10)',
      navActiveRing: 'rgba(255, 255, 255, 0.22)',
      navColor: 'rgba(245, 245, 245, 0.45)',
      navColorHover: 'rgba(245, 245, 245, 0.85)',
      overlay: 'rgba(0, 0, 0, 0.45)',
      // 流动背景（中性白光斑，去紫；质感保留、零染色）
      flow: {
        '--flow-speed': '1',
        '--bg-blob-1': 'rgba(255, 255, 255, 0.06)',
        '--bg-blob-2': 'rgba(255, 255, 255, 0.10)',
        '--bg-blob-3': 'rgba(255, 255, 255, 0.05)',
        '--bg-flow-conic': 'conic-gradient(from 0deg at 50% 50%, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.04))',
      },
    },
    light: {
      appBg: '#ffffff',
      secondaryBg: '#ffffff',
      sidebarBg: '#ffffff',
      textPrimary: '#111111',
      textMuted: '#6f6f6f',
      blur: 22, saturate: 140, brightness: 0.94,
      sidebarBlur: 28, sidebarSaturate: 150,
      bottomnavBlur: 30, bottomnavSaturate: 160,
      edge: 'rgba(15, 23, 42, 0.14)',
      border: 'rgba(15, 23, 42, 0.16)',
      rimTop: 'rgba(255, 255, 255, 0.95)',
      rimBottom: 'rgba(15, 23, 42, 0.12)',
      innerGlow: 'rgba(255, 255, 255, 0.30)',
      sheenColor: 'rgba(255, 255, 255, 0.50)',
      shadow: '0 10px 34px rgba(15, 23, 42, 0.14)',
      grainOpacity: 0.05,
      navActive: 'rgba(255, 255, 255, 0.70)',
      navActiveRing: 'rgba(15, 23, 42, 0.10)',
      navColor: 'rgba(33, 33, 33, 0.55)',
      navColorHover: 'rgba(33, 33, 33, 0.95)',
      overlay: 'rgba(15, 23, 42, 0.30)',
      flow: {
        '--flow-speed': '1',
        '--bg-blob-1': 'rgba(0, 0, 0, 0.03)',
        '--bg-blob-2': 'rgba(0, 0, 0, 0.025)',
        '--bg-blob-3': 'rgba(0, 0, 0, 0.02)',
        '--bg-flow-conic': 'conic-gradient(from 0deg at 50% 50%, rgba(0, 0, 0, 0.02), rgba(0, 0, 0, 0.015), rgba(0, 0, 0, 0.02))',
      },
    },
  };

  // ---------- CSS 变量注入（一个出口） ----------
  let domStyle = null;
  const setThemeVars = (body) => {
    if (!domStyle) {
      domStyle = document.createElement('style');
      domStyle.id = 'lgv-theme-style';
      document.head.appendChild(domStyle);
    }
    domStyle.innerText = body;
  };

  let state = { theme: 'dark', accent: DEFAULT_ACCENT };

  function applyTheme(theme, accent) {
    const t = SURFACES[theme] || SURFACES.dark;
    state.theme = SURFACES[theme] ? theme : 'dark';
    state.accent = normalizeAccent(accent || DEFAULT_ACCENT);
    const a = state.accent;
    const isDark = state.theme === 'dark';
    const v = [];
    const put = (k, val) => v.push(`${k}:${val};`);

    // 基底（沿用 style.css 现有消费点变量名）
    put('--primary-bg', t.appBg);
    put('--secondary-bg', t.secondaryBg);
    put('--sidebar-bg', t.sidebarBg);
    // 强调色通用（用户自定义；主按钮/进度/焦点环/底栏指示条消费）
    put('--highlight-color', a);
    put('--gold-color', a);
    put('--lgv-accent', a);
    put('--lgv-accent-soft', hexToRgba(a, 0.35));
    // 面板底色（accent-color 在 LGVideo 语义=面板实底，深浅各一档；★11-22 去紫改中性）
    put('--accent-color', isDark ? '#141414' : '#f2f2f2');
    put('--text-color', t.textPrimary);
    put('--text-secondary-color', t.textMuted);
    // 玻璃恒开（双主题各自磨砂标定）
    put('--liquid-glass', 'true');
    put('--color-glass-tint', 'transparent');
    put('--color-glass-edge', 'transparent');
    put('--color-glass-base', 'transparent');
    put('--color-content-background', isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)');
    // 导航
    put('--nav-color', t.navColor);
    put('--nav-color-hover', t.navColorHover);
    put('--nav-hover-bg', isDark ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.05)');
    put('--lgv-nav-active', t.navActive);
    put('--lgv-nav-active-ring', t.navActiveRing);
    put('--lgv-overlay', t.overlay);
    // 玻璃材质链（零染色：blur/saturate/brightness 三件套 + 棱线/泛光/光泽/投影）
    put('--glass-blur', t.blur + 'px');
    put('--glass-alpha', '0.42');
    put('--glass-tint-rgb', isDark ? '0, 0, 0' : '255, 255, 255');
    put('--glass-border-c', t.border);
    put('--glass-rim', t.rimTop);
    put('--glass-rim-b', t.rimBottom);
    put('--glass-shadow-c', t.shadow.replace(/^[^ ]+ /, ''));
    put('--glass-sheen-a', isDark ? '0.10' : '0.16');
    put('--glass-glow-c', 'transparent');
    put('--lgv-g-backdrop', `blur(${t.blur}px) saturate(${t.saturate}%) brightness(${t.brightness})`);
    put('--lgv-sb-backdrop', `blur(${t.sidebarBlur}px) saturate(${t.sidebarSaturate}%) brightness(1)`);
    put('--lgv-bn-backdrop', `blur(${t.bottomnavBlur}px) saturate(${t.bottomnavSaturate}%) brightness(1)`);
    put('--lgv-edge', t.edge);
    put('--lgv-g-border', t.border);
    put('--lgv-g-rim-top', t.rimTop);
    put('--lgv-g-rim-bottom', t.rimBottom);
    put('--lgv-g-inner-glow', t.innerGlow);
    put('--lgv-g-shadow', t.shadow);
    put('--lgv-sheen-color', t.sheenColor);
    put('--lgv-grain-opacity', String(t.grainOpacity));
    put('--lgv-modal-backdrop', `blur(40px) saturate(160%)${isDark ? '' : ' brightness(1.06)'}`);
    // 流动背景（中性白光斑保留质感）；★11-22 舞台光取消（去紫，深色=纯黑、浅色=纯白）
    put('--stage-background', 'none');
    for (const [k, val] of Object.entries(t.flow)) put(k, val);

    setThemeVars(`:root{${v.join('')}}`);
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.setProperty('--tile-glass', 'rgba(255,255,255,0.28)');
  }

  // 同步快取（settings 加载前防闪变；桌面 dev 刷新/Android 冷启各一次）
  const CACHE_KEY = 'lgv-appearance';
  const readCache = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  };
  const writeCache = (theme, accent) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, accent })); } catch (e) {}
  };

  const cached = readCache();
  applyTheme(migrateThemeKey(cached.theme), cached.accent);

  window.XVThemes = {
    DEFAULT_ACCENT,
    getState() { return { theme: state.theme, accent: state.accent }; },
    // 从 settings 同步（含旧键迁移；customThemes 旧档丢弃）
    hydrate(settings) {
      const theme = migrateThemeKey(settings.theme || settings.themeId);
      const accent = normalizeAccent(settings.themeAccent);
      writeCache(theme, accent);
      applyTheme(theme, accent);
      // 迁移结果回写（一次性；主进程/原生把旧键清掉）
      if (settings.themeId || settings.customThemes) {
        window.voidAPI.setSettings({
          theme, themeAccent: accent,
          themeId: null, customThemes: null,
        }).catch(() => {});
      }
    },
    select(theme, accent) {
      const t = migrateThemeKey(theme);
      const a = normalizeAccent(accent || state.accent);
      writeCache(t, a);
      applyTheme(t, a);
      return window.voidAPI.setSettings({ theme: t, themeAccent: a });
    },
    setAccent(accent) {
      const a = normalizeAccent(accent);
      writeCache(state.theme, a);
      applyTheme(state.theme, a);
      return window.voidAPI.setSettings({ themeAccent: a });
    },
  };
})();
