// settings.js — 设置页 v2（对齐 Pointers-BOX v2.6.0 卡片流形态）
// 本地用户卡片置顶 + 点入资料内页 / 关于 / 主题（dark·light+强调色） / 解析接口 / 影视导航 /
// 浏览器 / 播放器 / 更新检查（自动检测+渠道：Android 固定 GitHub+网盘手动入口） / 开发者模式置底。
// 控件规则：命名选项一律下拉、开关一律 Switch、禁折叠全平铺。
;(function initSettings() {

  const $ = (id) => document.getElementById(id);
  let settings = null;
  const IS_ANDROID = document.documentElement.classList.contains('platform-android');
  // 网盘手动下载入口（甘露影视分享页；检测渠道不受影响）
  const NETDISK_URL = 'https://share.feijipan.com/s/dgzZYGJw';

  const parseInput = (text) =>
    text.split('\n').map(l => l.trim()).filter(l => l.includes('|')).map(l => {
      const i = l.indexOf('|');
      return { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    }).filter(x => x.label || x.value);

  const formatForInput = (list) => (list || []).map(x => `${x.label}|${x.value}`).join('\n');

  const updateLineCount = (textarea, display) => {
    display.textContent = String(textarea.value.split('\n').filter(l => l.trim() !== '').length);
  };

  const save = async (patch) => {
    const s2 = await window.voidAPI.setSettings(patch);
    settings = s2;
    window.XVThemes.hydrate(s2);
    return s2;
  };

  // ---------- 本地用户（localUser；userId 首写自动生成） ----------
  function normalizeLocalUser(u) {
    const out = (u && typeof u === 'object') ? { ...u } : {};
    if (!out.userId) out.userId = `local_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
    if (!out.username) out.username = 'LG 用户';
    out.avatar = typeof out.avatar === 'string' ? out.avatar : '';
    out.status = typeof out.status === 'string' ? out.status : '';
    out.signature = typeof out.signature === 'string' ? out.signature : '';
    return out;
  }

  function renderUserCard() {
    const u = normalizeLocalUser(settings.localUser);
    const avatarEl = $('user-avatar');
    avatarEl.classList.toggle('placeholder', !u.avatar);
    avatarEl.style.backgroundImage = u.avatar ? `url(${u.avatar})` : 'none';
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.textContent = u.avatar ? '' : (u.username || 'L').slice(0, 1).toUpperCase();
    $('user-name').textContent = u.username;
    $('user-status').textContent = u.status || u.signature || '点击编辑个人资料';
    $('user-dev-badge').hidden = !settings.devMode;
  }

  function fillUserForm() {
    const u = normalizeLocalUser(settings.localUser);
    $('user-avatar-edit').classList.toggle('placeholder', !u.avatar);
    $('user-avatar-edit').style.backgroundImage = u.avatar ? `url(${u.avatar})` : 'none';
    $('user-avatar-edit').style.backgroundSize = 'cover';
    $('user-avatar-edit').textContent = u.avatar ? '' : (u.username || 'L').slice(0, 1).toUpperCase();
    $('user-username').value = u.username;
    $('user-status-input').value = u.status;
    $('user-signature').value = u.signature;
    $('avatar-hint').textContent = IS_ANDROID ? '当前平台不支持头像自传' : '';
    $('user-avatar-btn').hidden = IS_ANDROID;
  }

  async function compressAvatar(filePath) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // 居中裁方
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => resolve('');
      img.src = 'file:///' + String(filePath).replace(/\\/g, '/');
    });
  }

  function initUserCard() {
    const card = $('user-card');
    card.addEventListener('click', () => {
      fillUserForm();
      $('settings-main').hidden = true;
      $('user-page').hidden = false;
    });
    $('user-page-back').addEventListener('click', () => {
      $('user-page').hidden = true;
      $('settings-main').hidden = false;
      renderUserCard();
    });

    const saveUser = async (patch) => {
      const merged = normalizeLocalUser({ ...(settings.localUser || {}), ...patch });
      await save({ localUser: merged });
    };

    let nameTimer = null;
    $('user-username').addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => saveUser({ username: $('user-username').value.trim() || 'LG 用户' }), 400);
    });
    let statusTimer = null;
    $('user-status-input').addEventListener('input', () => {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => saveUser({ status: $('user-status-input').value }), 400);
    });
    let sigTimer = null;
    $('user-signature').addEventListener('input', () => {
      clearTimeout(sigTimer);
      sigTimer = setTimeout(() => saveUser({ signature: $('user-signature').value }), 400);
    });

    $('user-avatar-btn').addEventListener('click', async () => {
      const filePath = await window.voidAPI.pickAvatar();
      if (!filePath) return;
      const dataURL = await compressAvatar(filePath);
      if (!dataURL) { showToast('头像读取失败', 'error'); return; }
      await saveUser({ avatar: dataURL });
      fillUserForm();
      showToast('头像已更新', 'success');
    });
  }

  // ---------- 关于 ----------
  async function initAbout() {
    try {
      $('about-version').textContent = 'v' + await window.voidAPI.getVersion();
    } catch (e) {}

    // 许可协议弹窗（关于页按钮 + 首启未同意）
    const pactModal = $('pact-modal');
    const openPact = () => { pactModal.style.display = 'flex'; };
    $('pact-open-button').addEventListener('click', openPact);
    $('pact-ok').addEventListener('click', async () => {
      pactModal.style.display = 'none';
      await save({ agreedPact: true });
    });
    window.XVPact = { open: openPact, needed: () => !settings.agreedPact };

    // 链接外跳（外链走系统浏览器）
    document.querySelectorAll('.link-open').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.voidAPI.openExternalLink(a.href);
      });
    });
  }

  // ---------- 主题（dark/light 预览卡 + 强调色） ----------
  const ACCENT_PRESETS = ['#8b30d6', '#d4b06f', '#4fd1c5', '#ed64a6', '#4299e1', '#48bb78'];

  function renderThemeTiles() {
    const tiles = $('theme-tiles');
    tiles.innerHTML = '';
    const st = window.XVThemes.getState();
    const previews = [
      { key: 'dark', name: '深色', bg: 'linear-gradient(150deg, #0d0716 55%, #8b30d6 55%)' },
      { key: 'light', name: '浅色', bg: 'linear-gradient(150deg, #eef0f4 55%, #8b30d6 55%)' },
    ];
    for (const p of previews) {
      const wrap = document.createElement('div');
      wrap.className = 'theme-tile' + (st.theme === p.key ? ' active' : '');
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.style.background = p.bg;
      tile.style.setProperty('--tile-glass', 'rgba(255,255,255,0.28)');
      const name = document.createElement('div');
      name.className = 'tile-name';
      name.textContent = p.name;
      wrap.appendChild(tile);
      wrap.appendChild(name);
      wrap.addEventListener('click', () => window.XVThemes.select(p.key));
      tiles.appendChild(wrap);
    }
  }

  function renderAccentRow() {
    const row = $('accent-row');
    row.innerHTML = '';
    const st = window.XVThemes.getState();
    for (const c of ACCENT_PRESETS) {
      const dot = document.createElement('span');
      dot.className = 'accent-dot' + (st.accent === c ? ' active' : '');
      dot.style.background = c;
      dot.addEventListener('click', () => window.XVThemes.setAccent(c));
      row.appendChild(dot);
    }
    $('accent-color-input').value = st.accent;
    $('accent-hex-input').value = st.accent;
  }

  function initThemes() {
    renderThemeTiles();
    renderAccentRow();
    $('accent-color-input').addEventListener('input', (e) => window.XVThemes.setAccent(e.target.value));
    $('accent-hex-input').addEventListener('change', (e) => window.XVThemes.setAccent(e.target.value));
  }

  // ---------- 解析接口 / 影视导航 ----------
  function initLists() {
    const parsingInput = $('parsing-list-input');
    const dramaInput = $('drama-list-input');
    parsingInput.value = formatForInput(settings.apiList);
    dramaInput.value = formatForInput(settings.dramaSites);
    updateLineCount(parsingInput, $('parsing-line-count'));
    updateLineCount(dramaInput, $('drama-line-count'));
    parsingInput.addEventListener('input', () => updateLineCount(parsingInput, $('parsing-line-count')));
    dramaInput.addEventListener('input', () => updateLineCount(dramaInput, $('drama-line-count')));

    $('parsing-save').addEventListener('click', async () => {
      const list = parseInput(parsingInput.value);
      if (!list.length) { showToast('至少保留一个接口（名称|接口URL 格式）', 'error'); return; }
      const s2 = await save({ apiList: list });
      window.BrowserX.refreshLists(s2);
      showToast('解析接口已保存', 'success');
    });
    $('parsing-reset').addEventListener('click', async () => {
      const ok = await showConfirm('恢复默认解析接口？自定义接口将被清除。');
      if (!ok) return;
      const s2 = await save({ apiList: defaultApiList() });
      parsingInput.value = formatForInput(s2.apiList);
      updateLineCount(parsingInput, $('parsing-line-count'));
      window.BrowserX.refreshLists(s2);
    });

    $('nav-save').addEventListener('click', async () => {
      const list = parseInput(dramaInput.value);
      if (list.length > 4) { showToast('影视导航最多 4 个站点', 'error'); return; }
      const s2 = await save({ dramaSites: list });
      window.BrowserX.refreshLists(s2);
      showToast('影视导航已保存', 'success');
    });
    $('nav-reset').addEventListener('click', async () => {
      const s2 = await save({ dramaSites: [] });
      dramaInput.value = '';
      updateLineCount(dramaInput, $('drama-line-count'));
      window.BrowserX.refreshLists(s2);
    });
  }

  // 默认接口（与主进程 DEFAULT_SETTINGS.apiList 一致，重置用）
  function defaultApiList() {
    return [
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
    ];
  }

  // ---------- 浏览器 / 播放器 ----------
  function initBrowserPlayer() {
    const sleepSel = $('browser-sleep');
    sleepSel.value = String((settings.browser && settings.browser.sleepMinutes) || 0);
    sleepSel.addEventListener('change', async () => {
      await save({ browser: { ...settings.browser, sleepMinutes: Number(sleepSel.value) } });
      showToast('标签休眠已更新', 'success');
    });

    const modeSel = $('player-mode');
    const autoNext = $('player-autonext');
    const remember = $('player-remember');
    modeSel.value = (settings.player && settings.player.mode) || 'overlay';
    autoNext.checked = !!(settings.player && settings.player.autoNext);
    remember.checked = !!(settings.player && settings.player.rememberPos);
    const savePlayer = async () => {
      await save({
        player: {
          ...(settings.player || {}),
          mode: modeSel.value, autoNext: autoNext.checked, rememberPos: remember.checked,
        },
      });
    };
    modeSel.addEventListener('change', savePlayer);
    autoNext.addEventListener('change', savePlayer);
    remember.addEventListener('change', savePlayer);
  }

  // ---------- 更新检查（自动检测 + 渠道 + 网盘手动入口） ----------
  function initUpdate() {
    // Android：渠道固定 GitHub（旧档 netdisk 迁回由 themes/默认值层处理），显示网盘手动按钮
    const channelSel = $('update-channel-select');
    if (IS_ANDROID) {
      $('update-channel-row').hidden = true;
      $('netdisk-update-btn').hidden = false;
    } else {
      channelSel.value = settings.updateChannel || 'github';
      channelSel.addEventListener('change', async () => {
        await save({ updateChannel: channelSel.value });
        showToast(`更新渠道已切换：${channelSel.value === 'gitee' ? '国内镜像（Gitee）' : '全球官方（GitHub）'}`, 'success');
      });
    }

    const autoSwitch = $('update-auto-check');
    autoSwitch.checked = !!settings.autoCheckUpdate;
    autoSwitch.addEventListener('change', async () => {
      await save({ autoCheckUpdate: autoSwitch.checked });
      showToast(autoSwitch.checked ? '已开启自动检测更新（启动 5 秒后检查）' : '已关闭自动检测更新', 'success');
    });

    $('netdisk-update-btn').addEventListener('click', () => {
      window.voidAPI.openExternalLink(NETDISK_URL);
    });

    const area = $('update-area');
    let downloaded = false;

    window.voidAPI.onUpdateEvent((p) => {
      if (!p) return;
      if (p.type === 'progress') {
        const pct = Math.floor((p.percent || 0) * 100);
        area.innerHTML = `<div style="background:var(--lgv-accent,var(--highlight-color));color:var(--text-color)">下载进度：${pct}%${p.total ? `（${(p.transferred / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB）` : ''}</div>`;
      } else if (p.type === 'downloaded') {
        downloaded = true;
        area.innerHTML = `<div style="background:rgba(76,175,80,.18);color:#85c43b">更新已下载。点「重启并安装」。</div>`;
        $('update-check-btn').textContent = '重启并安装';
      } else if (p.type === 'result') {
        downloaded = false;
        $('update-check-btn').textContent = '检查更新';
        if (p.hasUpdate) {
          area.innerHTML = `<div style="background:rgba(139,48,214,.16);color:var(--gold-color)">发现新版本 v${p.latest}（当前 v${p.current}）。</div>`;
        } else {
          area.innerHTML = `<div style="background:var(--accent-color);color:var(--text-color)">已是最新版本 v${p.current}</div>`;
        }
      } else if (p.type === 'error') {
        area.innerHTML = `<div style="background:rgba(255,103,104,.15);color:#ff8f8f">更新失败：${p.message}</div>`;
      }
    });

    $('update-check-btn').addEventListener('click', async () => {
      if (downloaded) {
        window.voidAPI.installUpdate();
        return;
      }
      $('update-check-btn').disabled = true;
      try {
        const r = await window.XVUpdatePrompt.manualCheck();
        // 桌面：有更新且未弹窗（桌面也弹统一 UpdatePrompt），同时保留区域展示
        if (r && r.hasUpdate && !IS_ANDROID) await window.voidAPI.downloadUpdate();
      } catch (e) { /* 错误经 update-event 展示 */ }
      $('update-check-btn').disabled = false;
    });

    // 侧栏「检查更新」按钮（桌面）→ 跳设置页并触发检查
    const sideBtn = $('check-update-button');
    if (sideBtn) {
      sideBtn.addEventListener('click', () => {
        window.XVApp.switchPage('settings');
        setTimeout(() => {
          const card = $('card-update');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          $('update-check-btn').click();
        }, 120);
      });
    }

    // 首启强制选择渠道（仅桌面；Android 渠道固定 GitHub）
    if (!IS_ANDROID && !settings.updateChannel) {
      openChannelModal();
    }
  }

  function openChannelModal() {
    const modal = $('channel-modal');
    const opts = modal.querySelectorAll('.channel-option');
    const confirmBtn = $('channel-confirm');
    let chosen = '';
    modal.style.display = 'flex';
    opts.forEach(o => {
      o.addEventListener('click', () => {
        opts.forEach(x => x.classList.remove('selected'));
        o.classList.add('selected');
        chosen = o.dataset.channel;
        confirmBtn.disabled = false;
      });
    });
    confirmBtn.addEventListener('click', async () => {
      if (!chosen) return;
      modal.style.display = 'none';
      await save({ updateChannel: chosen });
      const sel = $('update-channel-select');
      if (sel) sel.value = chosen;
      showToast(`更新渠道：${chosen === 'gitee' ? '国内镜像（Gitee）' : '全球官方（GitHub）'}`, 'success');
    }, { once: true });
  }

  // ---------- 开发者模式（置底；开=两步验证，关=直写） ----------
  function initDevMode() {
    const sw = $('dev-mode-switch');
    sw.checked = !!settings.devMode;
    sw.addEventListener('change', async () => {
      if (!sw.checked) {
        await save({ devMode: false });
        renderUserCard();
        showToast('已关闭开发者模式', 'success');
        return;
      }
      sw.checked = false; // 验证通过后再置真
      const ok = await window.XVDevActivation.openDevActivation();
      if (ok) {
        await save({ devMode: true });
        sw.checked = true;
        renderUserCard();
        showToast('开发者模式已开启', 'success');
      }
    });
  }

  // ---------- 对外 ----------
  window.XVSettings = {
    getSettings: () => settings,
    applySettings: (s) => { settings = s; window.XVThemes.hydrate(s); },
    async init() {
      settings = await window.voidAPI.getSettings();
      // 首次生成 localUser（userId 自动生成；与 Pointers-BOX generateLocalUserId 同语义）
      if (!settings.localUser) {
        settings = await save({
          localUser: normalizeLocalUser(null),
        });
      }
      window.XVThemes.hydrate(settings);
      await initAbout();
      initUserCard();
      renderUserCard();
      initThemes();
      initLists();
      initBrowserPlayer();
      initUpdate();
      initDevMode();
      // 首启许可协议
      if (!settings.agreedPact) window.XVPact.open();
    },
    refresh: (s) => { settings = s; },
  };
  function applySettings(s) { window.XVSettings.applySettings(s); }
})()
