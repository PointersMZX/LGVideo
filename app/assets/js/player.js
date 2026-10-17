// player.js — LG Video 精雕播放器引擎（窗口内叠层 / 独立新窗口共用）
// 控制条：进度（缓冲段+悬停预览+拖拽）/ 音量 / 倍速 / A-B 循环 / 上下集 / 全屏 /
// 快捷键（空格 K、←→、J L、↑↓、M、F、0-9）/ 3s 自动隐藏 / 进度记忆 / 自动续播 / 出错态
;(function initPlayer() {

  const $ = (id) => document.getElementById(id);
  const layer = $('player-layer') || $('player-window-root');
  const video = $('player-video');
  if (!layer || !video) return; // 无播放器 DOM（理论不会发生）

  const isWindowMode = layer.id === 'player-window-root';
  const api = isWindowMode ? (window.playerAPI || {}) : (window.voidAPI || {});

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
      if (pos && isFinite(pos.t) && pos.t > 5 && video.duration && pos.t < video.duration * 0.95) {
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
    if (!silent && video.currentTime >= video.duration - 3) api.clearPosition && api.clearPosition(ctx.file);
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
    video.playbackRate = 1;
    el.rate.value = '1';
    abPoint = null;
    el.ab.classList.remove('on');
    el.ab.innerHTML = 'A-B';

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

  video.addEventListener('play', () => setPlayIcon(true));
  video.addEventListener('pause', () => { setPlayIcon(false); savePosition(false); });
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

  // 音量 / 静音
  el.volume.addEventListener('input', () => {
    video.volume = Number(el.volume.value);
    video.muted = video.volume === 0;
    el.mute.textContent = video.muted || video.volume === 0 ? '🔇' : (video.volume < 0.5 ? '🔈' : '🔊');
  });
  el.mute.addEventListener('click', () => {
    video.muted = !video.muted;
    el.mute.textContent = video.muted ? '🔇' : '🔊';
  });

  // 倍速
  el.rate.addEventListener('change', () => {
    video.playbackRate = Number(el.rate.value) || 1;
  });

  // 上下集
  el.prev.addEventListener('click', () => {
    if (ctx.episodes && ctx.epIndex > 0) playEpIdx(ctx.epIndex - 1);
    else if (ctx.list && ctx.index > 0) { ctx.index -= 1; load(ctx); }
  });
  el.next.addEventListener('click', () => {
    if (ctx.episodes && ctx.epIndex < ctx.episodes.length - 1) playEpIdx(ctx.epIndex + 1);
    else if (ctx.list && ctx.index < ctx.list.length - 1) { ctx.index += 1; load(ctx); }
  });

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
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const k = e.key.toLowerCase();
    switch (k) {
      case ' ':
      case 'k': e.preventDefault(); togglePlay(); break;
      case 'arrowleft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
      case 'arrowright': e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); break;
      case 'j': video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); break;
      case 'arrowup': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); el.volume.value = String(video.volume); break;
      case 'arrowdown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); el.volume.value = String(video.volume); break;
      case 'm': video.muted = !video.muted; break;
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
