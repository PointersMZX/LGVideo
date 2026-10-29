// app.js — 甘露影视移动端逻辑（复用桌面甘露引擎 GanluEngine）
;(function () {
  const $ = (id) => document.getElementById(id);
  const G = window.GanluEngine;
  const api = window.voidAPI || {};
  if (!G || !api.ganluFetch) { document.body.innerHTML = '<div class="pv-empty" style="padding-top:40%">初始化失败：引擎或桥未就绪</div>'; return; }

  const fetcher = (p, meta) => api.ganluFetch(Object.assign({ timeoutMs: 20000 }, p), meta);
  let store = null;
  let plugins = [];
  let curDetail = null;   // { subject, source, roads, roadIdx, epIdx }
  let hls = null;

  // ---------- 基础 ----------
  let toastTimer = 0;
  function toast(msg) {
    $('pv-toast').hidden = false;
    $('pv-toast-text').textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('pv-toast').hidden = true; }, 2600);
  }

  function switchView(name) {
    document.querySelectorAll('.pv-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.pv-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'home') loadHome().catch(() => {});
    if (name === 'collect') renderCollect();
    if (name === 'rules') renderRules();
  }

  async function refreshData() {
    store = await api.ganluGetStore();
    plugins = (await api.ganluGetPlugins()).map((p) => G.pluginFromJson(p)).filter(Boolean);
    $('pv-rules-count').textContent = plugins.length ? (plugins.length + ' 个源') : '';
    fillSourceSelect();
  }

  function fillSourceSelect() {
    const sel = $('pv-source');
    sel.innerHTML = '';
    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    add('bgm', '番剧数据（按名检索）');
    add('all', '全部源（' + plugins.length + ' 个）');
    plugins.forEach((p) => add('p|' + p.name, p.name || '(未命名规则)'));
  }

  // ---------- 首页 ----------
  let homeLoaded = false;
  async function loadHome() {
    if (homeLoaded) return;
    const [cal, hot] = await Promise.all([
      G.bgm.calendar(fetcher).catch(() => null),
      G.bgm.trending(fetcher).catch(() => null),
    ]);
    const calBox = $('pv-home-cal');
    calBox.innerHTML = '';
    const week = cal && cal.week;
    if (week) {
      const flat = [];
      for (const k of Object.keys(week)) (week[k] || []).forEach((s) => flat.push(s));
      flat.slice(0, 12).forEach((s) => calBox.appendChild(card(s, 'home-cal')));
    } else {
      calBox.innerHTML = '<div class="pv-empty">时间表暂不可用</div>';
    }
    const hotBox = $('pv-home-hot');
    hotBox.innerHTML = '';
    if (hot && hot.length) hot.slice(0, 18).forEach((s) => hotBox.appendChild(card(s, 'hot')));
    else hotBox.innerHTML = '<div class="pv-empty">热门数据暂不可用</div>';
    if (cal && hot) homeLoaded = true;
  }

  function card(subject, tag) {
    const c = document.createElement('div');
    c.className = 'gl-card';
    c.innerHTML = '<div class="gl-card-cover"><img loading="lazy" alt=""></div><div class="gl-card-name"></div>';
    const img = c.querySelector('img');
    img.src = subject.cover || '';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    c.querySelector('.gl-card-name').textContent = subject.nameCn || subject.name || '(未命名)';
    c.addEventListener('click', () => openDetail(subject));
    return c;
  }

  // ---------- 搜索 ----------
  async function doSearch() {
    const kw = String($('pv-kw').value || '').trim();
    const src = $('pv-source').value;
    const box = $('pv-search-results');
    if (!kw) { toast('输入作品名'); return; }
    box.innerHTML = '<div class="pv-empty">检索中…</div>';
    let list = [];
    try {
      if (src === 'bgm') list = await G.bgm.search(kw, fetcher);
      else if (src === 'all') {
        const res = await G.searchAll(plugins, kw, fetcher, 4);
        list = [];
        for (const r of (res.results || [])) {
          (r.items || []).forEach((it) => list.push({ name: it.name, source: { plugin: r.plugin, url: it.url }, cover: it.cover || '', _rule: true }));
        }
      } else if (src.startsWith('p|')) {
        const name = src.slice(2);
        const plugin = plugins.find((p) => p.name === name);
        if (!plugin) throw new Error('规则不存在');
        const r = await G.searchPlugin(plugin, kw, fetcher);
        list = (r.items || []).map((it) => ({ name: it.name, source: { plugin, url: it.url }, cover: it.cover || '', _rule: true }));
      }
    } catch (e) {
      box.innerHTML = '';
      toast('搜索失败：' + (e && e.message || e));
      return;
    }
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="pv-empty">没有找到相关结果</div>'; return; }
    list.slice(0, 60).forEach((s) => box.appendChild(card(s, 'search')));
  }

  // ---------- 详情 / 播放 ----------
  async function openDetail(subject) {
    $('pv-detail').classList.add('open');
    const body = $('pv-detail-body');
    body.innerHTML = '<div class="pv-empty">加载中…</div>';
    curDetail = null;
    try {
      let sub = subject;
      if (!subject.eps && subject.id != null && !subject.source) {
        try { sub = await G.bgm.subject(subject.id, fetcher); } catch (e) { sub = subject; }
      }
      let roads = null;
      if (subject.source && subject.source.plugin) {
        const r = await G.chaptersPlugin(subject.source.plugin, subject.source.url, fetcher);
        roads = (r && r.roads) || null;
      }
      curDetail = { subject: sub, source: subject.source || null, roads, roadIdx: 0, epIdx: 0 };
      renderDetail();
    } catch (e) {
      body.innerHTML = '<div class="pv-empty">详情加载失败：' + esc(e && e.message || e) + '</div>';
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function renderDetail() {
    const d = curDetail;
    const body = $('pv-detail-body');
    body.innerHTML = '';
    const h = document.createElement('div');
    const cover = (d.subject.cover || '');
    h.innerHTML =
      '<div style="display:flex;gap:12px">' +
      (cover ? '<img src="' + esc(cover) + '" style="width:96px;border-radius:10px;object-fit:cover" onerror="this.style.display=\'none\'">' : '') +
      '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:700;color:#e8c98a">' + esc(d.subject.nameCn || d.subject.name || '') + '</div>' +
      '<div style="font-size:11.5px;color:#9a8fc0;margin-top:4px">' + esc(d.subject.name || '') + '</div>' +
      '<div style="font-size:11.5px;color:#9a8fc0;margin-top:6px">' + (d.subject.rating != null ? '评分 ' + esc(d.subject.rating) + ' · ' : '') + (d.subject.eps ? esc(d.subject.eps) + ' 集 · ' : '') + esc(d.subject.aired || '') + '</div></div></div>';
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px;color:#cfc7e8;line-height:1.7;margin-top:12px';
    summary.textContent = d.subject.summary || '';
    body.appendChild(h);
    body.appendChild(summary);

    // 追番按钮（有 bgm id 才可追）
    if (d.subject.id != null) {
      const fav = document.createElement('div');
      fav.style.margin = '14px 0';
      const inCol = store.collect && store.collect[String(d.subject.id)];
      const b = document.createElement('button');
      b.className = 'pv-ep' + (inCol ? ' cur' : '');
      b.textContent = inCol ? '已在追番' : '加入追番';
      b.addEventListener('click', async () => {
        store.collect = store.collect || {};
        const k = String(d.subject.id);
        if (store.collect[k]) delete store.collect[k];
        else store.collect[k] = { subject: d.subject, time: Date.now() };
        await api.ganluSetStore({ collect: store.collect });
        renderDetail();
        toast(inCol ? '已取消追番' : '已加入追番');
      });
      fav.appendChild(b);
      body.appendChild(fav);
    }

    if (!d.roads || !d.roads.length) {
      const p = document.createElement('div');
      p.className = 'pv-empty';
      p.textContent = d.source ? '该源暂无可播放的线路' : '该条目来自番剧数据，请在「搜索」选影视源检索可播放版本';
      body.appendChild(p);
      return;
    }
    d.roads.forEach((road, ri) => {
      const t = document.createElement('div');
      t.className = 'pv-road';
      t.textContent = road.name || ('播放线路' + (ri + 1));
      body.appendChild(t);
      const wrap = document.createElement('div');
      (road.data || []).forEach((url, ei) => {
        const b = document.createElement('button');
        b.className = 'pv-ep' + (d.roadIdx === ri && d.epIdx === ei ? ' cur' : '');
        b.textContent = (road.identifier && road.identifier[ei]) || ('第' + (ei + 1) + '集');
        b.addEventListener('click', () => playEp(ri, ei));
        wrap.appendChild(b);
      });
      body.appendChild(wrap);
    });
  }

  async function playEp(roadIdx, epIdx) {
    const d = curDetail;
    if (!d || !d.roads || !d.roads[roadIdx]) return;
    const road = d.roads[roadIdx];
    const page = road.data[epIdx];
    const label = (road.identifier && road.identifier[epIdx]) || ('第' + (epIdx + 1) + '集');
    d.roadIdx = roadIdx; d.epIdx = epIdx;
    renderDetail();
    $('pv-detail').classList.remove('open');
    $('pv-player').classList.add('open');
    $('pv-eps').innerHTML = '<div class="pv-empty" style="padding:0 10px">解析播放地址…</div>';
    $('pv-video').removeAttribute('src');
    destroyHls();
    const url = await resolveStream(page, d.subject, label);
    if (!url) {
      $('pv-eps').innerHTML = '';
      const b = document.createElement('button');
      b.textContent = label + ' · 解析失败';
      b.disabled = true;
      $('pv-eps').appendChild(b);
      toast('解析不到播放地址，试试其它线路或集数');
      return;
    }
    playUrl(url);
    renderEpBar();
  }

  // 移动版解析：JS 抓剧集页 → 多模式提取直链（原生嗅探窗将随版本加入）
  async function resolveStream(pageUrl, subject, label) {
    try {
      const r = await api.ganluFetch({ url: pageUrl, method: 'GET', headers: G.buildHttpHeaders ? {} : {}, bodyType: 'none', timeoutMs: 20000 }, null);
      if (!r.ok || !r.text) return null;
      const html = r.text;
      const pats = [
        /["'](https?:\/\/[^"']+?\.m3u8[^"']*)["']/i,
        /["'](https?:\/\/[^"']+?\.mp4[^"']*)["']/i,
        /["']((?:\/\/|\/)[^"']+?\.m3u8[^"']*)["']/i,
      ];
      for (const re of pats) {
        const m = html.match(re);
        if (m && m[1]) {
          let u = m[1];
          if (u.startsWith('//')) u = 'https:' + u;
          else if (u.startsWith('/')) { try { u = new URL(u, pageUrl).toString(); } catch (e) { continue; } }
          return u;
        }
      }
    } catch (e) {}
    return null;
  }

  function destroyHls() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  }

  function playUrl(url) {
    const v = $('pv-video');
    const isHls = /\.m3u8([?#]|$)/i.test(url);
    destroyHls();
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hls = new Hls({ manifestLoadingTimeOut: 20000, fragLoadingTimeOut: 30000 });
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) toast('播放中断：' + (data.details || '')); });
      hls.loadSource(url);
      hls.attachMedia(v);
      v.play().catch(() => {});
    } else {
      v.src = url;
      v.play().catch(() => { toast('该格式需要系统播放器（将随版本加入）'); });
    }
  }

  function renderEpBar() {
    const d = curDetail;
    const bar = $('pv-eps');
    bar.innerHTML = '';
    if (!d || !d.roads) return;
    d.roads.forEach((road, ri) => {
      (road.data || []).forEach((u, ei) => {
        const b = document.createElement('button');
        b.textContent = (road.identifier && road.identifier[ei]) || (ri + '-' + (ei + 1));
        if (d.roadIdx === ri && d.epIdx === ei) b.classList.add('cur');
        b.addEventListener('click', () => playEp(ri, ei));
        bar.appendChild(b);
      });
    });
  }

  // ---------- 追番 ----------
  function renderCollect() {
    const box = $('pv-collect');
    box.innerHTML = '';
    const items = Object.values((store && store.collect) || {}).sort((a, b) => (b.time || 0) - (a.time || 0));
    if (!items.length) { box.innerHTML = '<div class="pv-empty">还没有追番，去搜索或首页添加吧</div>'; return; }
    items.forEach((x) => box.appendChild(card(x.subject || {}, 'collect')));
  }

  // ---------- 规则 ----------
  function renderRules() {
    const box = $('pv-rule-list');
    box.innerHTML = '';
    if (!plugins.length) {
      box.innerHTML = '<div class="pv-empty">还没有影视源规则 · 点「在线源目录」一键安装</div>';
      return;
    }
    plugins.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'pv-row';
      row.innerHTML = '<div class="pv-row-main"><div class="pv-row-name"></div><div class="pv-row-meta"></div></div>';
      row.querySelector('.pv-row-name').textContent = p.name || '(未命名规则)';
      row.querySelector('.pv-row-meta').textContent = 'v' + (p.version || '?');
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        plugins.splice(i, 1);
        await api.ganluSetPlugins(plugins.map(G.pluginToJson));
        refreshData().then(renderRules);
        toast('已删除');
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  async function importFromText() {
    const text = String($('pv-rule-text').value || '').trim();
    if (!text) { toast('粘贴规则内容再导入'); return; }
    try {
      const incoming = G.importRuleText(text); // JSON 数组（pluginToJson 形状）
      if (!incoming || !incoming.length) { toast('未解析到有效规则'); return; }
      const byKey = {};
      plugins.forEach((p) => { byKey[(p.name || '').toLowerCase()] = p; });
      incoming.forEach((p) => { byKey[(p.name || '').toLowerCase()] = G.pluginFromJson(p); });
      plugins = Object.values(byKey);
      await api.ganluSetPlugins(plugins.map(G.pluginToJson));
      $('pv-rule-text').value = '';
      refreshData().then(renderRules);
      toast('已导入 ' + incoming.length + ' 条规则');
    } catch (e) {
      toast('导入失败：' + (e && e.message || e));
    }
  }

  async function loadCatalog() {
    const box = $('pv-catalog');
    box.hidden = false;
    box.innerHTML = '<div class="pv-empty">获取在线源目录…</div>';
    try {
      const list = await G.catalog.list(fetcher);
      box.innerHTML = '';
      list.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'pv-row';
        row.innerHTML = '<div class="pv-row-main"><div class="pv-row-name"></div><div class="pv-row-meta"></div></div>';
        row.querySelector('.pv-row-name').textContent = it.name;
        row.querySelector('.pv-row-meta').textContent = (it.author ? '作者 ' + it.author + ' · ' : '') + 'v' + it.version;
        const b = document.createElement('button');
        const has = plugins.some((p) => (p.name || '').toLowerCase() === it.name.toLowerCase());
        b.textContent = has ? '重新下载' : '安装';
        b.addEventListener('click', async () => {
          b.textContent = '下载中…';
          try {
            const p = await G.catalog.get(it.name, fetcher);
            const byKey = {};
            plugins.forEach((x) => { byKey[(x.name || '').toLowerCase()] = x; });
            byKey[(p.name || '').toLowerCase()] = p;
            plugins = Object.values(byKey);
            await api.ganluSetPlugins(plugins.map(G.pluginToJson));
            refreshData().then(renderRules);
            box.hidden = true;
            toast('已安装：' + it.name);
          } catch (e) {
            b.textContent = '安装';
            toast('下载失败：' + (e && e.message || e));
          }
        });
        row.appendChild(b);
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = '<div class="pv-empty">目录获取失败：' + esc(e && e.message || e) + '</div>';
    }
  }

  // ---------- 绑定 ----------
  document.querySelectorAll('.pv-nav button').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });
  $('pv-search-btn').addEventListener('click', doSearch);
  $('pv-kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('pv-detail-back').addEventListener('click', () => $('pv-detail').classList.remove('open'));
  $('pv-player-close').addEventListener('click', () => {
    destroyHls();
    const v = $('pv-video');
    v.pause();
    v.removeAttribute('src');
    $('pv-player').classList.remove('open');
  });
  $('pv-rate').addEventListener('change', (e) => { $('pv-video').playbackRate = Number(e.target.value) || 1; });
  $('pv-rule-apply').addEventListener('click', importFromText);
  $('pv-rule-catalog').addEventListener('click', loadCatalog);

  // ---------- 启动 ----------
  (async () => {
    await refreshData();
    loadHome().catch(() => {});
  })();
})();
