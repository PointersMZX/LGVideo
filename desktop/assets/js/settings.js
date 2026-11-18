// settings.js — 设置页（卡片流）：关于 / 主题 / 解析接口 / 影视导航 / 浏览器 / 播放器 / 更新检查（双渠道）
;(function initSettings() {

  const $ = (id) => document.getElementById(id);
  let settings = null;

  const parseInput = (text) =>
    text.split('\n').map(l => l.trim()).filter(l => l.includes('|')).map(l => {
      const i = l.indexOf('|');
      return { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    }).filter(x => x.label || x.value);

  const formatForInput = (list) => (list || []).map(x => `${x.label}|${x.value}`).join('\n');

  const updateLineCount = (textarea, display) => {
    display.textContent = String(textarea.value.split('\n').filter(l => l.trim() !== '').length);
  };

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
      await window.voidAPI.setSettings({ agreedPact: true });
      settings.agreedPact = true;
    });
    window.XVPact = { open: openPact, needed: () => !settings.agreedPact };

    // 侧栏链接行为（外链走系统浏览器）
    document.querySelectorAll('.link-open').forEach(a => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.voidAPI.openExternalLink(a.href);
      });
    });
  }

  // ---------- 主题 ----------
  function renderThemeTiles() {
    const tiles = $('theme-tiles');
    tiles.innerHTML = '';
    const st = window.XVThemes.getState();
    const all = window.XVThemes.BUILTIN_THEMES.concat(st.customThemes);
    for (const t of all) {
      const wrap = document.createElement('div');
      wrap.className = 'theme-tile' + (st.themeId === t.id ? ' active' : '');
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (t.builtIn) {
        tile.style.background = `linear-gradient(150deg, ${t.vars['--primary-bg']} 55%, ${t.vars['--highlight-color']} 55%)`;
        tile.style.setProperty('--tile-glass', t.vars['--liquid-glass'] === 'true' ? 'rgba(255,255,255,0.28)' : 'transparent');
      } else {
        const vars = window.XVThemes.customVars(t);
        tile.style.background = `linear-gradient(150deg, ${vars['--primary-bg']} 55%, ${vars['--highlight-color']} 55%)`;
        tile.style.setProperty('--tile-glass', vars['--liquid-glass'] === 'true' ? 'rgba(255,255,255,0.28)' : 'transparent');
      }
      const name = document.createElement('div');
      name.className = 'tile-name';
      name.textContent = t.name;
      wrap.appendChild(tile);
      wrap.appendChild(name);
      wrap.addEventListener('click', async () => {
        window.XVThemes.select(t.id);
        const s2 = await window.voidAPI.getSettings();
        applySettings(s2);
        renderThemeTiles();
      });
      tiles.appendChild(wrap);
    }
    renderCustomEditor();
  }

  function renderCustomEditor() {
    const st = window.XVThemes.getState();
    const cur = st.customThemes;
    const editor = $('theme-custom');
    const pickers = $('theme-pickers');
    pickers.innerHTML = '';
    const labels = [
      ['primary', '主色', '#8b30d6'],
      ['font', '字体色', '#f0ecff'],
      ['appBg', '应用背景', '#0d0716'],
      ['mainBg', '面板背景', '#170d24'],
    ];
    for (const [key, label, def] of labels) {
      const cell = document.createElement('label');
      cell.className = 'picker';
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = 'color';
      input.id = 'theme-pk-' + key;
      input.value = def;
      cell.appendChild(span);
      cell.appendChild(input);
      pickers.appendChild(cell);
    }
    const existing = cur.length ? cur[cur.length - 1] : null;
    if (existing) {
      $('theme-custom-name').value = existing.name;
      for (const [key] of labels) {
        const input = $('theme-pk-' + key);
        if (existing.pickers && existing.pickers[key]) input.value = existing.pickers[key];
      }
      $('theme-dark-flag').checked = existing.dark !== false;
      $('theme-glass-flag').checked = !!existing.glass;
      $('theme-custom-delete').hidden = false;
      editor.dataset.editing = existing.id;
    } else {
      editor.dataset.editing = '';
      $('theme-custom-delete').hidden = true;
    }
  }

  async function initThemes() {
    renderThemeTiles();

    $('theme-custom-new').addEventListener('click', () => {
      $('theme-custom-name').value = '';
      for (const k of ['primary', 'font', 'appBg', 'mainBg']) $('theme-pk-' + k).value = { primary: '#8b30d6', font: '#f0ecff', appBg: '#0d0716', mainBg: '#170d24' }[k];
      $('theme-dark-flag').checked = true;
      $('theme-glass-flag').checked = true;
      $('theme-custom-delete').hidden = true;
      delete $('theme-custom').dataset.editing;
    });

    $('theme-custom-save').addEventListener('click', async () => {
      const editing = $('theme-custom').dataset.editing;
      const pickers = {
        primary: $('theme-pk-primary').value,
        font: $('theme-pk-font').value,
        appBg: $('theme-pk-appBg').value,
        mainBg: $('theme-pk-mainBg').value,
      };
      const payload = {
        pickers,
        dark: $('theme-dark-flag').checked,
        glass: $('theme-glass-flag').checked,
      };
      if (editing) {
        payload.name = $('theme-custom-name').value.trim() || '自定义';
        await window.XVThemes.updateCustom(editing, payload);
      } else {
        payload.name = $('theme-custom-name').value.trim();
        const r = await window.XVThemes.createCustom(payload);
        if (!r.ok) { showToast(r.error, 'error'); return; }
      }
      const s2 = await window.voidAPI.getSettings();
      applySettings(s2);
      renderThemeTiles();
      showToast('主题已保存', 'success');
    });

    $('theme-custom-delete').addEventListener('click', async () => {
      const editing = $('theme-custom').dataset.editing;
      if (!editing) return;
      const ok = await showConfirm('删除该自定义主题？');
      if (!ok) return;
      await window.XVThemes.removeCustom(editing);
      const s2 = await window.voidAPI.getSettings();
      applySettings(s2);
      renderThemeTiles();
    });
  }

  // ---------- 解析接口 / 影视导航 ----------
  function initLists() {
    const parsingInput = $('parsing-list-input');
    const dramaInput = $('drama-list-input');
    const apiDefault = settings.apiList;
    parsingInput.value = formatForInput(apiDefault);
    dramaInput.value = formatForInput(settings.dramaSites);
    updateLineCount(parsingInput, $('parsing-line-count'));
    updateLineCount(dramaInput, $('drama-line-count'));
    parsingInput.addEventListener('input', () => updateLineCount(parsingInput, $('parsing-line-count')));
    dramaInput.addEventListener('input', () => updateLineCount(dramaInput, $('drama-line-count')));

    $('parsing-save').addEventListener('click', async () => {
      const list = parseInput(parsingInput.value);
      if (!list.length) { showToast('至少保留一个接口（名称|接口URL 格式）', 'error'); return; }
      const s2 = await window.voidAPI.setSettings({ apiList: list });
      applySettings(s2);
      window.BrowserX.refreshLists(s2);
      showToast('解析接口已保存', 'success');
    });
    $('parsing-reset').addEventListener('click', async () => {
      const ok = await showConfirm('恢复默认解析接口？自定义接口将被清除。');
      if (!ok) return;
      const s2 = await window.voidAPI.setSettings({ apiList: defaultApiList() });
      applySettings(s2);
      parsingInput.value = formatForInput(s2.apiList);
      updateLineCount(parsingInput, $('parsing-line-count'));
      window.BrowserX.refreshLists(s2);
    });

    $('nav-save').addEventListener('click', async () => {
      let list = parseInput(dramaInput.value);
      if (list.length > 4) { showToast('影视导航最多 4 个站点', 'error'); return; }
      const s2 = await window.voidAPI.setSettings({ dramaSites: list });
      applySettings(s2);
      window.BrowserX.refreshLists(s2);
      showToast('影视导航已保存', 'success');
    });
    $('nav-reset').addEventListener('click', async () => {
      const s2 = await window.voidAPI.setSettings({ dramaSites: [] });
      applySettings(s2);
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
    sleepSel.value = String(settings.browser.sleepMinutes || 0);
    sleepSel.addEventListener('change', async () => {
      const s2 = await window.voidAPI.setSettings({ browser: { ...settings.browser, sleepMinutes: Number(sleepSel.value) } });
      applySettings(s2);
      showToast('标签休眠已更新', 'success');
    });

    const modeSel = $('player-mode');
    const autoNext = $('player-autonext');
    const remember = $('player-remember');
    modeSel.value = settings.player.mode || 'overlay';
    autoNext.checked = !!settings.player.autoNext;
    remember.checked = !!settings.player.rememberPos;
    const savePlayer = async () => {
      const s2 = await window.voidAPI.setSettings({
        player: { ...settings.player, mode: modeSel.value, autoNext: autoNext.checked, rememberPos: remember.checked },
      });
      applySettings(s2);
    };
    modeSel.addEventListener('change', savePlayer);
    autoNext.addEventListener('change', savePlayer);
    remember.addEventListener('change', savePlayer);
  }

  // ---------- 更新检查（双渠道 + 首启选择） ----------
  function initUpdate() {
    const radioGitee = document.createElement('label');
    radioGitee.className = 'check-label';
    radioGitee.innerHTML = '<input type="radio" name="up-ch" value="gitee"> 国内镜像（Gitee）';
    const radioGithub = document.createElement('label');
    radioGithub.className = 'check-label';
    radioGithub.innerHTML = '<input type="radio" name="up-ch" value="github"> 全球官方（GitHub）';
    const row = $('card-update').querySelector('.card-body');
    const chRow = document.createElement('div');
    chRow.className = 'info-row';
    chRow.innerHTML = '<span class="info-label">更新渠道</span>';
    chRow.appendChild(radioGitee);
    chRow.appendChild(radioGithub);
    row.insertBefore(chRow, row.firstChild);

    const radios = row.querySelectorAll('input[name="up-ch"]');
    for (const r of radios) {
      r.checked = (settings.updateChannel || 'github') === r.value;
      r.addEventListener('change', async () => {
        const s2 = await window.voidAPI.setSettings({ updateChannel: r.value });
        applySettings(s2);
        showToast(`更新渠道已切换：${r.value === 'gitee' ? '国内镜像（Gitee）' : '全球官方（GitHub）'}`, 'success');
      });
    }

    const area = $('update-area');
    let downloading = false, downloaded = false;

    window.voidAPI.onUpdateEvent((p) => {
      if (p.type === 'progress') {
        downloading = true;
        const pct = Math.floor((p.percent || 0) * 100);
        area.innerHTML = `<div style="background:var(--accent-color);color:var(--text-color)">下载进度：${pct}%${p.total ? `（${(p.transferred / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB）` : ''}</div>`;
      } else if (p.type === 'downloaded') {
        downloading = false;
        downloaded = true;
        area.innerHTML = `<div style="background:rgba(76,175,80,.18);color:#85c43b">更新已下载。点「重启并安装」。</div>`;
        $('update-check-btn').textContent = '重启并安装';
      } else if (p.type === 'result') {
        downloading = false;
        downloaded = false;
        $('update-check-btn').textContent = '检查更新';
        if (p.hasUpdate) {
          area.innerHTML = `<div style="background:rgba(139,48,214,.16);color:var(--gold-color)">发现新版本 v${p.latest}（当前 v${p.current}）。${p.notes ? '点「下载更新」获取。' : ''}</div>`;
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
        const r = await window.voidAPI.checkForUpdates();
        if (r.hasUpdate) await window.voidAPI.downloadUpdate();
      } catch (e) { /* 错误经 update-event 展示 */ }
      $('update-check-btn').disabled = false;
    });

    // 侧栏「检查更新」按钮 → 跳设置页并滚动到更新卡片 + 触发检查
    $('check-update-button').addEventListener('click', () => {
      window.XVApp.switchPage('settings');
      setTimeout(() => {
        const card = $('card-update');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('update-check-btn').click();
      }, 120);
    });

    // 首启强制选择渠道（未选过才弹）
    if (!settings.updateChannel) {
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
      const s2 = await window.voidAPI.setSettings({ updateChannel: chosen });
      applySettings(s2);
      // 同步 radio 状态
      s2updateRadios(s2.updateChannel);
      showToast(`更新渠道：${chosen === 'gitee' ? '国内镜像（Gitee）' : '全球官方（GitHub）'}`, 'success');
    }, { once: true });
  }

  function s2updateRadios(channel) {
    const radios = document.querySelectorAll('input[name="up-ch"]');
    for (const r of radios) r.checked = (channel || 'github') === r.value;
  }

  // ---------- 对外 ----------
  window.XVSettings = {
    getSettings: () => settings,
    applySettings: (s) => { settings = s; window.XVThemes.hydrate(s); },
    async init() {
      settings = await window.voidAPI.getSettings();
      window.XVThemes.hydrate(settings);
      await initAbout();
      await initThemes();
      initLists();
      initBrowserPlayer();
      initUpdate();
      // 首启许可协议
      if (!settings.agreedPact) window.XVPact.open();
    },
    refresh: (s) => { settings = s; },
  };
  function applySettings(s) { window.XVSettings.applySettings(s); }
})()
