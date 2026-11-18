// themes.js — LG Video 主题系统（照 XingyuMusic setTheme 机制：:root 整包 CSS 变量即时注入）
// 3 内置主题（xingyu 紫金黑默认 / white 纯白 / black 纯黑）+ 自定义取色主题（上限 10）
// 持久化：settings.json 的 themeId / customThemes（主进程原子写）
;(function initThemes() {
  const hexToRgba = (hex, alpha) => {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return `rgba(0,0,0,${alpha})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  const hexToSolid = (hex) => {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return '#' + h;
  };

  // hex → "r, g, b" 三元组（供 rgba(var(--glass-tint-rgb), a) 复用）
  const hexToRgbTriplet = (hex) => {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return '13, 7, 22';
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  };

  // 主题键（与 style.css :root 对齐）
  const VAR_KEYS = [
    '--primary-bg', '--secondary-bg', '--sidebar-bg', '--accent-color',
    '--highlight-color', '--gold-color', '--text-color', '--text-secondary-color',
    '--liquid-glass', '--color-glass-edge', '--color-glass-base', '--color-glass-tint',
    '--color-content-background', '--stage-background',
    '--nav-color', '--nav-color-hover', '--nav-hover-bg',
    // 液态玻璃材质参数（六层模型的 Web 落点，缺项回落 style.css :root 默认值）
    '--glass-blur', '--glass-alpha', '--glass-tint-rgb', '--glass-border-c',
    '--glass-rim', '--glass-rim-b', '--glass-shadow-c', '--glass-sheen-a', '--glass-glow-c',
    // 流动背景（液态层）
    '--flow-speed', '--bg-blob-1', '--bg-blob-2', '--bg-blob-3', '--bg-flow-conic',
  ];

  const STAGE_PURPLE = 'radial-gradient(1100px 700px at 18% -10%, rgba(124, 32, 194, 0.4), transparent 62%), radial-gradient(900px 600px at 88% 110%, rgba(212, 176, 111, 0.16), transparent 55%), radial-gradient(700px 500px at 55% 50%, rgba(63, 15, 90, 0.35), transparent 70%)';

  const BUILTIN_THEMES = [
    {
      id: 'xingyu',
      name: '紫金黑',
      builtIn: true,
      vars: {
        '--primary-bg': '#0d0716',
        '--secondary-bg': '#170d24',
        '--sidebar-bg': '#120a1e',
        '--accent-color': '#321b4d',
        '--highlight-color': '#8b30d6',
        '--gold-color': '#e8c98a',
        '--text-color': '#f0ecff',
        '--text-secondary-color': '#9a8fc0',
        '--liquid-glass': 'true',
        '--color-glass-edge': 'rgba(232, 208, 158, 0.75)',
        '--color-glass-base': 'rgba(13, 7, 22, 0.42)',
        '--color-glass-tint': 'rgba(124, 32, 194, 0.38)',
        '--color-content-background': 'rgba(13, 7, 22, 0.78)',
        '--stage-background': STAGE_PURPLE,
        '--nav-color': 'rgba(240, 236, 255, 0.45)',
        '--nav-color-hover': 'rgba(240, 236, 255, 0.85)',
        '--nav-hover-bg': 'rgba(255, 255, 255, 0.035)',
        // 玻璃材质（06 规范 dark/flowPanel 预设标定）
        '--glass-blur': '18px',
        '--glass-alpha': '0.42',
        '--glass-tint-rgb': '13, 7, 22',
        '--glass-border-c': 'rgba(255, 255, 255, 0.16)',
        '--glass-rim': 'rgba(255, 255, 255, 0.34)',
        '--glass-rim-b': 'rgba(255, 255, 255, 0.10)',
        '--glass-shadow-c': 'rgba(3, 0, 20, 0.35)',
        '--glass-sheen-a': '0.10',
        '--glass-glow-c': 'rgba(255, 255, 255, 0.14)',
        // 流动背景（紫金青三球 + 低透锥形整层旋转）
        '--flow-speed': '1',
        '--bg-blob-1': 'rgba(124, 32, 194, 0.5)',
        '--bg-blob-2': 'rgba(212, 176, 111, 0.28)',
        '--bg-blob-3': 'rgba(88, 28, 150, 0.45)',
        '--bg-flow-conic': 'conic-gradient(from 0deg at 50% 50%, rgba(124, 32, 194, 0.14), rgba(88, 28, 150, 0.10), rgba(212, 176, 111, 0.07), rgba(124, 32, 194, 0.14))',
      },
    },
    {
      id: 'white',
      name: '纯白',
      builtIn: true,
      vars: {
        '--primary-bg': '#f5f5f7',
        '--secondary-bg': '#ffffff',
        '--sidebar-bg': '#ffffff',
        '--accent-color': '#e8e4f5',
        '--highlight-color': '#7C20C2',
        '--gold-color': '#D4B06F',
        '--text-color': '#212121',
        '--text-secondary-color': '#8a86a0',
        '--liquid-glass': 'false',
        '--color-glass-edge': 'transparent',
        '--color-glass-tint': 'transparent',
        '--color-glass-base': '#ffffff',
        '--color-content-background': '#f5f5f7',
        '--stage-background': 'none',
        '--nav-color': 'rgba(33, 33, 33, 0.55)',
        '--nav-color-hover': 'rgba(33, 33, 33, 0.95)',
        '--nav-hover-bg': 'rgba(0, 0, 0, 0.05)',
        // 玻璃材质（浅色 frosted：白 tint 提实、暗边框、白棱线，投影与光斑用主题紫）
        '--glass-blur': '16px',
        '--glass-alpha': '0.50',
        '--glass-tint-rgb': '255, 255, 255',
        '--glass-border-c': 'rgba(20, 10, 40, 0.10)',
        '--glass-rim': 'rgba(255, 255, 255, 0.90)',
        '--glass-rim-b': 'rgba(20, 10, 40, 0.06)',
        '--glass-shadow-c': 'rgba(31, 26, 51, 0.12)',
        '--glass-sheen-a': '0.09',
        '--glass-glow-c': 'rgba(124, 32, 194, 0.08)',
        // 流动背景（浅底低饱和，紫金各一球）
        '--flow-speed': '1',
        '--bg-blob-1': 'rgba(124, 32, 194, 0.10)',
        '--bg-blob-2': 'rgba(212, 176, 111, 0.10)',
        '--bg-blob-3': 'rgba(88, 28, 150, 0.07)',
        '--bg-flow-conic': 'conic-gradient(from 0deg at 50% 50%, rgba(124, 32, 194, 0.05), rgba(212, 176, 111, 0.04), rgba(124, 32, 194, 0.05))',
      },
    },
    {
      id: 'black',
      name: '纯黑',
      builtIn: true,
      vars: {
        '--primary-bg': '#0c0c10',
        '--secondary-bg': '#121216',
        '--sidebar-bg': '#0c0c10',
        '--accent-color': '#1f1f24',
        '--highlight-color': '#965adc',
        '--gold-color': '#D4B06F',
        '--text-color': '#ebebf0',
        '--text-secondary-color': '#8f8f9a',
        '--liquid-glass': 'false',
        '--color-glass-edge': 'transparent',
        '--color-glass-tint': 'transparent',
        '--color-glass-base': '#121216',
        '--color-content-background': '#0c0c10',
        '--stage-background': 'none',
        '--nav-color': 'rgba(235, 235, 240, 0.45)',
        '--nav-color-hover': 'rgba(235, 235, 240, 0.9)',
        '--nav-hover-bg': 'rgba(255, 255, 255, 0.06)',
        // 玻璃材质（06 规范 dark 预设：blur 24、深 tint、极克制光效）
        '--glass-blur': '24px',
        '--glass-alpha': '0.42',
        '--glass-tint-rgb': '12, 12, 16',
        '--glass-border-c': 'rgba(255, 255, 255, 0.13)',
        '--glass-rim': 'rgba(255, 255, 255, 0.28)',
        '--glass-rim-b': 'rgba(255, 255, 255, 0.08)',
        '--glass-shadow-c': 'rgba(0, 0, 0, 0.45)',
        '--glass-sheen-a': '0.08',
        '--glass-glow-c': 'rgba(150, 90, 220, 0.10)',
        // 流动背景（纯黑上极淡，避免喧宾夺主）
        '--flow-speed': '1',
        '--bg-blob-1': 'rgba(150, 90, 220, 0.14)',
        '--bg-blob-2': 'rgba(212, 176, 111, 0.05)',
        '--bg-blob-3': 'rgba(63, 15, 90, 0.18)',
        '--bg-flow-conic': 'conic-gradient(from 0deg at 50% 50%, rgba(150, 90, 220, 0.06), rgba(63, 15, 90, 0.05), rgba(150, 90, 220, 0.06))',
      },
    },
  ];

  // 自定义主题：取色器 4 色 + 深色标记 + 玻璃开关
  // pickers: { primary, font, appBg, mainBg }
  const customVars = (t) => {
    const p = t.pickers || {};
    const primary = hexToSolid(p.primary || '#8b30d6');
    const font = hexToSolid(p.font || '#f0ecff');
    const appBg = hexToSolid(p.appBg || '#0d0716');
    const mainBg = hexToSolid(p.mainBg || '#170d24');
    const dark = t.dark !== false;
    const glass = !!t.glass;
    const navColor = dark ? 'rgba(240, 236, 255, 0.45)' : 'rgba(33, 33, 33, 0.55)';
    const navColorHover = dark ? 'rgba(240, 236, 255, 0.85)' : 'rgba(33, 33, 33, 0.95)';
    const navHoverBg = dark ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.05)';
    const stage = dark
      ? `radial-gradient(1100px 700px at 18% -10%, ${hexToRgba(primary, 0.38)}, transparent 62%), radial-gradient(900px 600px at 88% 110%, ${hexToRgba(primary, 0.14)}, transparent 55%)`
      : 'none';
    // 玻璃材质与流动背景按深浅两套标定（深色=dark 预设 / 浅色=frosted 白玻璃）
    const tintRgb = dark
      ? (p.appBg ? hexToRgbTriplet(appBg) : '13, 7, 22')
      : '255, 255, 255';
    const glassVars = dark ? {
      '--glass-blur': '18px',
      '--glass-alpha': '0.42',
      '--glass-tint-rgb': tintRgb,
      '--glass-border-c': `rgba(255, 255, 255, 0.16)`,
      '--glass-rim': `rgba(255, 255, 255, 0.34)`,
      '--glass-rim-b': `rgba(255, 255, 255, 0.10)`,
      '--glass-shadow-c': 'rgba(3, 0, 20, 0.35)',
      '--glass-sheen-a': '0.10',
      '--glass-glow-c': `rgba(255, 255, 255, 0.14)`,
      '--flow-speed': '1',
      '--bg-blob-1': hexToRgba(primary, 0.5),
      '--bg-blob-2': hexToRgba(primary, 0.22),
      '--bg-blob-3': hexToRgba(primary, 0.38),
      '--bg-flow-conic': `conic-gradient(from 0deg at 50% 50%, ${hexToRgba(primary, 0.12)}, ${hexToRgba(primary, 0.06)}, ${hexToRgba(primary, 0.12)})`,
    } : {
      '--glass-blur': '16px',
      '--glass-alpha': '0.50',
      '--glass-tint-rgb': tintRgb,
      '--glass-border-c': 'rgba(20, 10, 40, 0.10)',
      '--glass-rim': 'rgba(255, 255, 255, 0.90)',
      '--glass-rim-b': 'rgba(20, 10, 40, 0.06)',
      '--glass-shadow-c': 'rgba(31, 26, 51, 0.12)',
      '--glass-sheen-a': '0.09',
      '--glass-glow-c': hexToRgba(primary, 0.08),
      '--flow-speed': '1',
      '--bg-blob-1': hexToRgba(primary, 0.10),
      '--bg-blob-2': hexToRgba(primary, 0.06),
      '--bg-blob-3': hexToRgba(primary, 0.04),
      '--bg-flow-conic': `conic-gradient(from 0deg at 50% 50%, ${hexToRgba(primary, 0.04)}, ${hexToRgba(primary, 0.02)}, ${hexToRgba(primary, 0.04)})`,
    };
    return {
      ...glassVars,
      '--primary-bg': appBg,
      '--secondary-bg': mainBg,
      '--sidebar-bg': mainBg,
      '--accent-color': mainBg,
      '--highlight-color': primary,
      '--gold-color': primary,
      '--text-color': font,
      '--text-secondary-color': font,
      '--liquid-glass': glass ? 'true' : 'false',
      '--color-glass-edge': glass ? hexToRgba(primary, 0.75) : 'transparent',
      '--color-glass-tint': glass ? hexToRgba(primary, 0.38) : 'transparent',
      '--color-glass-base': glass ? hexToRgba(appBg, 0.42) : mainBg,
      '--color-content-background': glass ? hexToRgba(appBg, 0.78) : appBg,
      '--stage-background': stage,
      '--nav-color': navColor,
      '--nav-color-hover': navColorHover,
      '--nav-hover-bg': navHoverBg,
    };
  };

  // --- :root 注入（XingyuMusic index.html setTheme 同款机制）---
  let domStyle = null;
  const setThemeVars = (vars) => {
    if (!domStyle) {
      domStyle = document.createElement('style');
      domStyle.id = 'xingyu-theme-style';
      document.head.appendChild(domStyle);
    }
    const body = `:root{${VAR_KEYS.map(k => `${k}:${vars[k] != null ? vars[k] : 'inherit'};`).join('')}}`;
    domStyle.innerText = body;
  };

  // --- 运行时状态（settings 未加载前用内置默认）---
  let state = {
    themeId: 'xingyu',
    customThemes: [],
  };

  const allThemes = () => BUILTIN_THEMES.concat(state.customThemes.map(t => ({ ...t, builtIn: false })));

  const findTheme = (id) => allThemes().find(t => t.id === id) || null;

  const varsOf = (t) => t.builtIn ? t.vars : customVars(t);

  const applyTheme = (id) => {
    const t = findTheme(id) || BUILTIN_THEMES[0];
    state.themeId = t.id;
    setThemeVars(varsOf(t));
    document.documentElement.style.setProperty('--tile-glass', varsOf(t)['--liquid-glass'] === 'true' ? 'rgba(255,255,255,0.28)' : 'transparent');
  };

  // 供 settings.js / 启动流程调用
  window.XVThemes = {
    BUILTIN_THEMES,
    customVars,
    getState() { return { themeId: state.themeId, customThemes: state.customThemes }; },
    // 从主进程 settings 同步
    hydrate(settings) {
      state.themeId = settings.themeId || 'xingyu';
      state.customThemes = Array.isArray(settings.customThemes) ? settings.customThemes : [];
      applyTheme(state.themeId);
    },
    // 切换主题（内置或自定义）
    select(id) {
      const t = findTheme(id);
      if (!t) return false;
      applyTheme(id);
      return window.voidAPI.setSettings({ themeId: id });
    },
    // 新建自定义主题并应用
    createCustom(theme) {
      const list = [...state.customThemes];
      if (list.length >= 10) return { ok: false, error: '自定义主题最多 10 个' };
      const t = {
        id: 'custom-' + Date.now(),
        name: String(theme.name || '').trim() || `自定义 ${list.length + 1}`,
        pickers: {
          primary: theme.primary || '#8b30d6',
          font: theme.font || '#f0ecff',
          appBg: theme.appBg || '#0d0716',
          mainBg: theme.mainBg || '#170d24',
        },
        dark: theme.dark !== false,
        glass: !!theme.glass,
      };
      list.push(t);
      state.customThemes = list;
      applyTheme(t.id);
      return window.voidAPI.setSettings({ themeId: t.id, customThemes: list }).then(() => ({ ok: true, id: t.id, list }));
    },
    updateCustom(id, patch) {
      const list = state.customThemes.map(t => (t.id === id ? { ...t, ...patch } : t));
      const t = list.find(x => x.id === id);
      state.customThemes = list;
      if (state.themeId === id && t) applyTheme(id);
      return window.voidAPI.setSettings({ customThemes: list });
    },
    removeCustom(id) {
      const list = state.customThemes.filter(t => t.id !== id);
      state.customThemes = list;
      if (state.themeId === id) applyTheme('xingyu');
      return window.voidAPI.setSettings({ customThemes: list, ...(state.themeId === id ? { themeId: 'xingyu' } : {}) });
    },
  };

  // 启动时先应用默认（xingyu），settings.js hydrate 后会按持久化值再套一次
  applyTheme('xingyu');
})()
