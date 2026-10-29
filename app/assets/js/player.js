// player.js — LG Video 精雕播放器引擎（窗口内叠层 / 独立新窗口共用）
// 控制条：进度（缓冲段+悬停预览+拖拽）/ 音量 / 倍速 12 档 / 画面比例 / 截图 / A-B 循环 / 上下集 / 全屏 /
// 快捷键（空格 K、←→、J L、N P、X Z、S、↑↓、M、F、0-9、长按→ 2 倍速）/ 3s 自动隐藏 /
// 缓冲指示 / 音量静音记忆 / 进度记忆（距尾 5s 视为看完）/ 自动续播 / 系统媒体键 / 出错态
;(function initPlayer() {

  // 窗口形态无 browser.js，补一份同款 toast（配置与主窗 showToast 一致）
  if (!window.showToast && window.Toastify) {
    window.showToast = function (message, type = 'info') {
      const bgColor = type === 'error' ? '#ff6768' : (type === 'success' ? '#4caf50' : '#321b4d');
      Toastify({
        text: message, duration: 3000, gravity: 'top', position: 'center',
        offset: { y: 52 }, stopOnFocus: true,
        style: { background: bgColor, borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.3)', fontSize: '14px', fontWeight: '500' }
      }).showToast();
    };
  }

  const $ = (id) => document.getElementById(id);
  const layer = $('player-layer') || $('player-window-root');
  const video = $('player-video');
  if (!layer || !video) return; // 无播放器 DOM（理论不会发生）

  const isWindowMode = layer.id === 'player-window-root';
  const api = isWindowMode ? (window.playerAPI || {}) : (window.voidAPI || {});

  // 档位与常量（距尾 5 秒内视为看完；长按右键 400ms 进入 2 倍速）
  const RATE_STEPS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
  const ASPECT_MODES = [
    { key: 'contain', label: '适应' },
    { key: 'cover', label: '裁剪填充' },
    { key: 'fill', label: '拉伸' },
  ];
  const END_WATCHED_SEC = 5;
  const HOLD_FWD_DELAY = 400;
  const HOLD_FWD_RATE = 2.0;

  const el = {
    title: $('player-title'),
    close: $('player-close'),
    error: $('player-error'),
    episodes: $('player-episodes'),
    controls: $('player-controls'),
    progress: $('pc-progress'),
    buffer: $('pc-buffer'),
    segment: $('pc-segment'),
    thumb: $('pc-thumb'),
    hoverTime: $('pc-hover-time'),
    cur: $('pc-cur'),
    dur: $('pc-dur'),
    play: $('pc-play'),
    prev: $('pc-ep-prev'),
    next: $('pc-ep-next'),
    back10: $('pc-back10'),
    fwd10: $('pc-fwd10'),
    ab: $('pc-ab'),
    aspect: $('pc-aspect'),
    shot: $('pc-shot'),
    rate: $('pc-rate'),
    mute: $('pc-mute'),
    volume: $('pc-volume'),
    fullscreen: $('pc-fullscreen'),
  };

  let ctx = null;        // 当前播放上下文
  let settings = { player: { autoNext: true, rememberPos: true }, };
  let open = false;
  let idleTimer = 0;
  let saveTimer = 0;
  let abPoint = null;    // { a, b }
  let fullscreenOn = false;
  let baseRate = 1;      // 用户选定倍速（长按快进临时改速的恢复基准）
  let rHoldTimer = 0;    // 长按右键计时器
  let rBoost = false;    // 长按倍速进行中

  // ---------- 工具 ----------
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const mm = String(m).padStart(2, '0'), xx = String(x).padStart(2, '0');
    return h ? h + ':' + mm + ':' + xx : mm + ':' + xx;
  };

  const fileSrc = (p) => {
    const s = String(p).replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(s)) return 'file:///' + s;
    if (s.startsWith('//')) return s;
    return 'file://' + s;
  };

  const activeSettings = () => {
    if (window.XVSettings && window.XVSettings.getSettings) {
      const s = window.XVSettings.getSettings();
      if (s && s.player) settings = s;
    }
    return settings;
  };

  // ---------- 上下文解析 ----------
  function normalize(ctx) {
    const c = { ...ctx };
    c.list = c.list || [];
    c.index = c.index || 0;
    c.episodes = c.episodes || null;
    c.epIndex = c.epIndex || 0;
    return c;
  }

  function currentEpisodes() {
    // 本地列表上下文（本地页）= list；我的影视上下文 = 条目内本地集数
    if (ctx.episodes) return ctx.episodes;
    return ctx.list.map((p, i) => ({ type: 'file', value: p, label: '第 ' + (i + 1) + ' 项', _listIndex: i }));
  }

  // ---------- 进度记忆 ----------
  async function loadPosition() {
    if (!api.getPosition || !settings.player.rememberPos) return;
    try {
      const pos = await api.getPosition(ctx.file);
      if (pos && isFinite(pos.t) && pos.t > 5 && video.duration && pos.t < video.duration - END_WATCHED_SEC) {
        video.currentTime = pos.t;
      }
    } catch (e) {}
  }

  function savePosition(silent) {
    if (!api.setPosition || !settings.player.rememberPos || !ctx || !ctx.file) return;
    if (!video.duration || !isFinite(video.currentTime)) return;
    clearTimeout(saveTimer);
    const pos = { t: video.currentTime, duration: video.duration, updatedAt: Date.now() };
    api.setPosition(ctx.file, pos).catch(() => {});
    if (!silent && video.currentTime >= video.duration - END_WATCHED_SEC) api.clearPosition && api.clearPosition(ctx.file);
  }

  // ---------- 集数切换 ----------
  function playEpIdx(idx) {
    const eps = currentEpisodes();
    const ep = eps[idx];
    if (!ep) return;
    if (ep.type === 'url') {
      // 链接集数回浏览器页打开
      if (!isWindowMode) {
        close();
        if (window.BrowserX) window.BrowserX.openUrl(ep.value);
      }
      return;
    }
    savePosition(true);
    const file = ep.value;
    const title = ctx.title ? ctx.title : file.split(/[\\/]/).pop();
    load({ file, title, list: ctx.list, index: ctx.list.indexOf(file), episodes: ctx.episodes, epIndex: idx, autoNext: ctx.autoNext });
  }

  // ---------- 核心：装载与播放 ----------
  function load(c) {
    ctx = normalize(c);
    settings = activeSettings();
    if (ctx.settings) { settings.player = ctx.settings.player || settings.player; }
    open = true;
    layer.classList.remove('hidden');

    el.title.textContent = ctx.title || 'LG Video';
    el.error.classList.add('hidden');
    video.removeAttribute('src');
    video.load();
    video.src = fileSrc(ctx.file);
    baseRate = 1;
    video.playbackRate = 1;
    el.rate.value = '1';
    rBoost = false;
    clearTimeout(rHoldTimer);
    abPoint = null;
    el.ab.classList.remove('on');
    el.ab.innerHTML = 'A-B';
    // 恢复记忆偏好：画面比例 / 音量静音
    setAspect(settings.player.aspect || 'contain', false);
    applyVolume(
      typeof settings.player.volume === 'number' ? settings.player.volume : 1,
      !!settings.player.muted,
      false
    );
    updateMediaSession();

    // 集数面板
    if (ctx.episodes && ctx.episodes.length > 1) {
      renderEpisodes();
      el.episodes.hidden = false;
      el.episodes.classList.add('show');
    } else {
      el.episodes.hidden = true;
      el.episodes.classList.remove('show');
    }
    el.prev.disabled = false;
    el.next.disabled = false;
    {
      const eps = currentEpisodes();
      const idx = ctx.episodes ? ctx.epIndex : ctx.index;
      el.prev.disabled = idx <= 0;
      el.next.disabled = idx >= eps.length - 1;
    }

    video.play().catch(() => {});
  }

  function close() {
    savePosition(false);
    open = false;
    video.pause();
    video.removeAttribute('src');
    video.load();
    layer.classList.remove('buffering');
    layer.classList.add('hidden');
    el.episodes.classList.remove('show');
    if (isWindowMode && api.close) api.close();
  }

  function renderEpisodes() {
    el.episodes.innerHTML = '';
    const h = document.createElement('h4');
    h.textContent = '集数（' + ctx.episodes.length + '）';
    el.episodes.appendChild(h);
    ctx.episodes.forEach((ep, i) => {
      const row = document.createElement('div');
      row.className = 'pe-item' + (i === ctx.epIndex ? ' current' : '');
      const t = document.createElement('span');
      t.className = 'pe-type';
      t.textContent = ep.type === 'file' ? '本地' : '链接';
      const n = document.createElement('span');
      n.style.flex = '1';
      n.style.overflow = 'hidden';
      n.style.textOverflow = 'ellipsis';
      n.textContent = ep.label || (ep.type === 'file' ? ep.value.split(/[\\/]/).pop() : ep.value);
      row.appendChild(t);
      row.appendChild(n);
      row.addEventListener('click', () => playEpIdx(i));
      el.episodes.appendChild(row);
    });
  }

  // ---------- 控制条 ----------
  function setPlayIcon(playing) {
    el.play.textContent = playing ? '⏸' : '▶';
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  video.addEventListener('play', () => { setPlayIcon(true); setMediaSessionState('playing'); });
  video.addEventListener('pause', () => { setPlayIcon(false); setMediaSessionState('paused'); savePosition(false); });
  video.addEventListener('playing', () => layer.classList.remove('buffering'));
  video.addEventListener('canplay', () => layer.classList.remove('buffering'));
  video.addEventListener('waiting', () => { if (open) layer.classList.add('buffering'); });
  el.play.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFullscreen);

  video.addEventListener('timeupdate', () => {
    const d = video.duration || 0;
    const t = video.currentTime;
    el.cur.textContent = fmtTime(t);
    el.dur.textContent = fmtTime(d);
    const pct = d ? t / d : 0;
    el.segment.style.width = (pct * 100) + '%';
    el.thumb.style.left = (pct * 100) + '%';
    // A-B 循环
    if (abPoint && abPoint.b > abPoint.a) {
      if (t >= abPoint.b) {
        video.currentTime = abPoint.a;
        if (!video.paused) video.play().catch(() => {});
      }
    }
  });

  video.addEventListener('progress', () => {
    try {
      const d = video.duration || 0;
      if (!d) return;
      const b = video.buffered;
      if (b.length) el.buffer.style.width = (b.end(b.length - 1) / d * 100) + '%';
    } catch (e) {}
  });

  video.addEventListener('loadedmetadata', () => {
    el.dur.textContent = fmtTime(video.duration);
    loadPosition();
  });

  video.addEventListener('ended', () => {
    savePosition(false);
    el.segment.style.width = '100%';
    // 自动续播（我的影视上下文 / 本地列表）
    if (settings.player.autoNext && ctx.episodes && ctx.epIndex < ctx.episodes.length - 1) {
      const nxt = ctx.episodes[ctx.epIndex + 1];
      showToast('正在加载下一集：' + (nxt.label || '下一集'), 'info');
      setTimeout(() => playEpIdx(ctx.epIndex + 1), 800);
    }
  });

  video.addEventListener('error', () => {
    if (!ctx) return;
    el.error.classList.remove('hidden');
    const ext = ctx.file.split('.').pop().toUpperCase();
    el.error.innerHTML = `
      <div class="err-title">无法播放该文件</div>
      <div class="err-desc">格式 ${ext || '未知'} 可能不被当前构建的 &lt;video&gt; 引擎支持（自动实测适配：该格式灰显在列表）。</div>
      <button id="player-error-close">返回</button>`;
    $('player-error-close').addEventListener('click', close);
  });

  // 进度条：拖拽定位 + 悬停时间预览
  let dragging = false;
  const seekFromEvent = (e) => {
    const rect = el.progress.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    return x / rect.width;
  };
  el.progress.addEventListener('pointerdown', (e) => {
    if (!video.duration) return;
    dragging = true;
    el.progress.classList.add('dragging');
    el.progress.setPointerCapture(e.pointerId);
    const p = seekFromEvent(e);
    video.currentTime = p * video.duration;
  });
  el.progress.addEventListener('pointermove', (e) => {
    if (dragging) {
      const p = seekFromEvent(e);
      video.currentTime = p * video.duration;
    }
    const rect = el.progress.getBoundingClientRect();
    const p = seekFromEvent(e);
    el.hoverTime.style.left = (p * rect.width) + 'px';
    el.hoverTime.textContent = fmtTime(p * (video.duration || 0));
  });
  el.progress.addEventListener('pointerup', () => {
    dragging = false;
    el.progress.classList.remove('dragging');
  });

  // 音量 / 静音（记忆到 settings.player，跨次启动恢复）
  let volumeSaveTimer = 0;
  function applyVolume(v, muted, persist) {
    video.volume = Math.min(1, Math.max(0, v));
    video.muted = !!muted || video.volume === 0;
    el.volume.value = String(video.volume);
    el.mute.textContent = video.muted ? '🔇' : (video.volume < 0.5 ? '🔈' : '🔊');
    if (persist) {
      clearTimeout(volumeSaveTimer);
      volumeSaveTimer = setTimeout(() => {
        settings.player = { ...settings.player, volume: video.volume, muted: video.muted };
        if (api.setSettings) {
          api.setSettings({ player: { volume: video.volume, muted: video.muted } })
            .then((s2) => { if (s2 && window.XVSettings && window.XVSettings.refresh) window.XVSettings.refresh(s2); })
            .catch(() => {});
        }
      }, 800);
    }
  }
  el.volume.addEventListener('input', () => applyVolume(Number(el.volume.value), false, true));
  el.mute.addEventListener('click', () => applyVolume(video.volume, !video.muted, true));

  // 倍速（12 档；X/Z 步进；长按右键临时 2 倍速恢复到此处）
  function setRate(r) {
    r = Math.min(3, Math.max(0.25, Math.round(Number(r) * 100) / 100)) || 1;
    baseRate = r;
    video.playbackRate = r;
    el.rate.value = String(r);
    return r;
  }
  el.rate.addEventListener('change', () => setRate(Number(el.rate.value) || 1));

  // 画面比例（适应 / 裁剪填充 / 拉伸，记忆到 settings.player）
  function setAspect(mode, persist) {
    video.style.objectFit = mode;
    const idx = ASPECT_MODES.findIndex((m) => m.key === mode);
    el.aspect.classList.toggle('on', mode !== 'contain');
    el.aspect.textContent = idx > 0 ? ASPECT_MODES[idx].label : '⧉';
    if (persist) {
      settings.player = { ...settings.player, aspect: mode };
      if (api.setSettings) {
        api.setSettings({ player: { aspect: mode } })
          .then((s2) => { if (s2 && window.XVSettings && window.XVSettings.refresh) window.XVSettings.refresh(s2); })
          .catch(() => {});
      }
    }
  }
  el.aspect.addEventListener('click', () => {
    const idx = ASPECT_MODES.findIndex((m) => m.key === (video.style.objectFit || 'contain'));
    setAspect(ASPECT_MODES[(idx + 1) % ASPECT_MODES.length].key, true);
  });

  // 截图（canvas 截当前帧 → userData/screenshots 落盘 PNG）
  function takeScreenshot() {
    if (!video.videoWidth || !video.videoHeight) { showToast('截图失败：画面未就绪', 'error'); return; }
    let dataUrl;
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      dataUrl = c.toDataURL('image/png');
    } catch (e) {
      showToast('截图失败：该视频受跨域限制', 'error');
      return;
    }
    if (!api.saveScreenshot) { showToast('截图失败：当前环境不支持', 'error'); return; }
    api.saveScreenshot(dataUrl, ctx && ctx.title ? ctx.title : 'LGVideo').then((r) => {
      if (r && r.ok) showToast('截图已保存：' + r.path, 'success');
      else showToast('截图失败' + (r && r.error ? '：' + r.error : ''), 'error');
    }).catch(() => showToast('截图失败', 'error'));
  }
  el.shot.addEventListener('click', takeScreenshot);

  // 上下集（按钮 + N/P 快捷键 + 系统媒体键共用）
  function prevEp() {
    if (ctx.episodes && ctx.epIndex > 0) playEpIdx(ctx.epIndex - 1);
    else if (ctx.list && ctx.index > 0) { ctx.index -= 1; load(ctx); }
  }
  function nextEp() {
    if (ctx.episodes && ctx.epIndex < ctx.episodes.length - 1) playEpIdx(ctx.epIndex + 1);
    else if (ctx.list && ctx.index < ctx.list.length - 1) { ctx.index += 1; load(ctx); }
  }
  el.prev.addEventListener('click', prevEp);
  el.next.addEventListener('click', nextEp);

  // ±10s
  el.back10.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  el.fwd10.addEventListener('click', () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });

  // A-B 循环：点 1 定 A，点 2 定 B（开始循环），点 3 复位
  el.ab.addEventListener('click', () => {
    if (!abPoint || (abPoint.a != null && abPoint.b != null)) {
      abPoint = { a: video.currentTime, b: null };
      el.ab.classList.add('on');
      el.ab.innerHTML = 'A-B<span class="ab-tag">A:' + fmtTime(abPoint.a) + '</span>';
    } else if (abPoint.b == null) {
      abPoint.b = video.currentTime;
      el.ab.innerHTML = 'A-B<span class="ab-tag">' + fmtTime(abPoint.a) + '–' + fmtTime(abPoint.b) + '</span>';
      if (window.showToast) showToast('A-B 循环已设定（再次点击复位）', 'info');
    }
    if (abPoint && abPoint.a != null && abPoint.b != null && el.ab.dataset.done === '1') {
      abPoint = null;
      el.ab.classList.remove('on');
      el.ab.innerHTML = 'A-B';
      el.ab.dataset.done = '';
    } else if (abPoint && abPoint.b != null) {
      el.ab.dataset.done = '1';
    }
  });

  // 全屏
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else layer.requestFullscreen && layer.requestFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    fullscreenOn = !!document.fullscreenElement;
    el.fullscreen.classList.toggle('on', fullscreenOn);
  });
  el.fullscreen.addEventListener('click', toggleFullscreen);

  // 关闭（叠层 = 收起；新窗口 = 关窗）
  el.close.addEventListener('click', close);

  // ---------- 键盘快捷键（仅播放器激活时；输入框聚焦不触发） ----------
  const isTypingTarget = (t) => ['input', 'textarea', 'select'].includes((t.tagName || '').toLowerCase());
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    switch (k) {
      case ' ':
      case 'k': e.preventDefault(); togglePlay(); break;
      case 'arrowleft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
      case 'arrowright':
        // 短按 = 前进 5s（在 keyup 执行）；按住 400ms = 临时 2 倍速快进
        e.preventDefault();
        if (!e.repeat && !rBoost) {
          clearTimeout(rHoldTimer);
          rHoldTimer = setTimeout(() => {
            rBoost = true;
            video.playbackRate = HOLD_FWD_RATE;
            showToast('2 倍速快进中（松开恢复）', 'info');
          }, HOLD_FWD_DELAY);
        }
        break;
      case 'j': video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); break;
      case 'n': nextEp(); break;
      case 'p': prevEp(); break;
      case 'arrowup': e.preventDefault(); applyVolume(video.volume + 0.05, false, true); break;
      case 'arrowdown': e.preventDefault(); applyVolume(video.volume - 0.05, false, true); break;
      case 'x': setRate(baseRate + 0.25); break;
      case 'z': setRate(baseRate - 0.25); break;
      case 's': takeScreenshot(); break;
      case 'm': applyVolume(video.volume, !video.muted, true); break;
      case 'f': toggleFullscreen(); break;
      case 'escape': if (document.fullscreenElement) document.exitFullscreen(); else if (!isWindowMode) close(); break;
      default:
        if (/^[0-9]$/.test(k)) {
          // 0-9 百分比定位（1 键 = 10%）
          const p = (k === '0' ? 0 : Number(k)) / 10;
          video.currentTime = p * (video.duration || 0);
        }
    }
  });
  // 松开右方向键：长按倍速恢复 / 短按补一次前进
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'ArrowRight') return;
    clearTimeout(rHoldTimer);
    if (rBoost) {
      rBoost = false;
      video.playbackRate = baseRate;
    } else if (open && !isTypingTarget(e.target)) {
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
    }
  });
  // 失焦兜底：长按倍速状态必须复位
  window.addEventListener('blur', () => {
    clearTimeout(rHoldTimer);
    if (rBoost) { rBoost = false; video.playbackRate = baseRate; }
  });

  // ---------- 系统媒体键（Windows 媒体面板 / 键盘媒体键） ----------
  function setMediaSessionState(state) {
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state; } catch (e) {}
  }
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (ctx && ctx.title) || 'LG Video',
        artist: 'LG Video',
      });
      const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {} };
      set('play', () => video.play().catch(() => {}));
      set('pause', () => video.pause());
      set('seekbackward', (d) => { video.currentTime = Math.max(0, video.currentTime - ((d && d.seekOffset) || 10)); });
      set('seekforward', (d) => { video.currentTime = Math.min(video.duration || 0, video.currentTime + ((d && d.seekOffset) || 10)); });
      set('previoustrack', () => prevEp());
      set('nexttrack', () => nextEp());
      set('seekto', (d) => {
        if (!d || d.seekTime == null) return;
        if (d.fastSeek && typeof video.fastSeek === 'function') video.fastSeek(d.seekTime);
        else video.currentTime = d.seekTime;
      });
    } catch (e) {}
  }

  // ---------- 自动隐藏（3s 无操作） ----------
  function wake() {
    if (!open) return;
    layer.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (open) layer.classList.add('idle'); }, 3000);
  }
  ['mousemove', 'mousedown', 'wheel'].forEach(evt => layer.addEventListener(evt, wake, { passive: true }));

  // 定时存档（每 5s）
  setInterval(() => { if (open && video.duration && !video.paused && settings.player.rememberPos) savePosition(true); }, 5000);

  // ---------- 对外接口 ----------
  window.XVPlayer = {
    // ctx: { file, title, list?, index?, episodes?, epIndex? }
    open(ctx) {
      const mode = (window.XVSettings && window.XVSettings.getSettings && window.XVSettings.getSettings().player.mode) || 'overlay';
      if (mode === 'window' && !isWindowMode) {
        const payload = { ...ctx, settings };
        if (window.voidAPI.openPlayerWindow) window.voidAPI.openPlayerWindow(payload);
        return;
      }
      load(ctx);
      wake();
    },
    close,
    get isOpen() { return open; },
  };

  // 新窗口形态：等主进程发 player-load
  if (isWindowMode) {
    if (window.playerAPI && window.playerAPI.onPlayerLoad) {
      window.playerAPI.onPlayerLoad((payload) => {
        if (payload && payload.file) {
          if (payload.settings) settings = { ...settings, ...payload.settings };
          load(payload);
          wake();
        }
      });
    }
  }
})()
