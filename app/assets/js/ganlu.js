// ganlu.js — 甘露影视源页（主窗）
// 职责：公共数据（首页/搜索/时间表/追番/历史）+ 规则引擎取集数/播放 + 弹幕/一起看/投屏
// 全部新增 UI 收拢在 #page-ganlu 区块；播放器增强仅通过 player.js 的 ext 钩子挂载，不影响本地播放器默认行为
;(function initGanlu() {

  const $ = (id) => document.getElementById(id);
  const G = window.GanluEngine;
  const api = window.voidAPI || {};
  if (!G || !api.ganluFetch || !window.XVPlayer) return; // 引擎或主进程面缺失则整页静默降级

  const XVP = window.XVPlayer;
  const video = $('player-video');
  const layer = $('player-layer');

  // ================= 状态 =================
  let store = null;          // ganlu.json（追番/历史/下载/弹幕屏蔽/源设置）
  let plugins = [];          // 规则（plugin 对象）
  let homeCache = null;      // { calendar, trending, updates }
  let calWeek = null;        // 当前日历页 { week, seasons }
  let calSeasonIdx = 0;     // 0 = 当季；±n 走 seasons 列表
  let curDetail = null;      // 当前详情（作品 + 选定源 + 线路/集数）
  let glSession = null;     // 当前播放会话（ctx._gl）
  const dlLive = new Map();  // taskId → 实时进度
  const dmCache = new Map(); // 弹幕列表缓存 key → items
  let spSession = null;      // 一起看会话 { id, room }
  let spTick = 0;           // 一起看状态上报定时器
  let castPopEl = null;     // 投屏浮层

  const GL_STATUS = { 1: '在看', 2: '想看', 3: '搁置', 4: '看过', 5: '弃番' };

  // ================= 抓取代理（渲染层 → 主进程） =================
  const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return ''; } };

  async function glFetch(prepared, meta) {
    let url = String(prepared.url || '');
    const q = prepared.query || {};
    const qk = Object.keys(q);
    if (qk.length) {
      const sp = new URLSearchParams();
      for (const k of qk) sp.set(k, q[k]);
      url += (url.includes('?') ? '&' : '?') + sp.toString();
    }
    const r = await api.ganluFetch({
      url,
      method: prepared.method || 'GET',
      headers: prepared.headers || {},
      body: prepared.body,
      bodyType: prepared.bodyType || 'none',
      cookieJar: prepared.includeCookies ? originOf(url) : '',
      sign: meta && meta.sign,
      timeoutMs: 20000,
    });
    if (!r.ok) throw new Error(r.error || ('HTTP ' + r.status));
    return r.text != null ? r.text : ('data:application/octet-stream;base64,' + (r.base64 || ''));
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const setChecked = (id, v) => { const el = $(id); if (el) el.checked = !!v; };

  const star = (score) => {
    if (score == null) return '';
    const n = Math.round(Number(score) * 10);
    if (!n || n < 10) return '';
    return '★'.repeat(Math.min(5, Math.ceil(n / 10))) + ' ' + Number(score).toFixed(1);
  };

  // ================= 数据存取 =================
  async function refreshStore() {
    try { store = await api.ganluGetStore(); } catch (e) { store = null; }
    if (!store) store = { collect: {}, history: {}, searchHistory: [], downloads: {}, shields: [], settings: {} };
    return store;
  }
  async function refreshPlugins() {
    try {
      const arr = await api.ganluGetPlugins();
      plugins = (Array.isArray(arr) ? arr : []).map((p) => G.pluginFromJson(p));
    } catch (e) { plugins = []; }
    return plugins;
  }
  const savePlugins = () => api.ganluSetPlugins(plugins.map(G.pluginToJson)).catch(() => {});
  const saveStore = (patch) => api.ganluSetStore(patch).then(() => { store = Object.assign(store || {}, patch); });

  // ================= 通用：作品卡片 =================
  function subjectCard(subj, extraAction) {
    const c = document.createElement('div');
    c.className = 'gl-card';
    c.innerHTML =
      '<div class="gl-card-cover"><img src="' + esc(subj.cover || '') + '" loading="lazy" alt="" ' +
      'onerror="this.style.display=\'none\'"></div>' +
      '<div class="gl-card-name" title="' + esc(subj.nameCn || subj.name || '') + '"></div>' +
      '<div class="gl-card-meta"></div>';
    c.querySelector('.gl-card-name').textContent = subj.nameCn || subj.name || '(未命名)';
    const meta = c.querySelector('.gl-card-meta');
    const bits = [];
    if (subj.rating != null) bits.push(star(subj.rating));
    if (subj.eps) bits.push(subj.eps + ' 集');
    if (subj.season) bits.push(subj.season);
    meta.textContent = bits.join(' · ');
    c.addEventListener('click', () => openDetailBySubject(subj));
    if (extraAction) extraAction(c);
    return c;
  }

  function fillCardGrid(grid, subjects) {
    grid.innerHTML = '';
    if (!subjects.length) {
      grid.innerHTML = '<div class="empty-state" style="flex:none;padding:16px 0">暂无数据</div>';
      return;
    }
    for (const s of subjects) grid.appendChild(subjectCard(s));
  }

  // ================= 首页 =================
  async function loadHome() {
    const safe = (p) => p.catch(() => null); // 单项失败不拖垮整页（检索类端点在部分网络不可用）
    const [calendar, trending, updates] = await Promise.all([
      safe(G.bgm.calendar(glFetch)),
      safe(G.bgm.trending(glFetch)),
      safe(G.bgm.tagFlow(['全部'], glFetch, 0)),
    ]);
    homeCache = { calendar, trending, updates };
    calWeek = calendar;
    calSeasonIdx = 0;
    renderHome();
    renderCalendarView();
  }

  function renderHome() {
    if (!homeCache) return;
    const cal = homeCache.calendar;
    fillCardGrid($('gl-home-calendar'), cal && cal.week ? cal.week[1] || cal.week[0] || [] : []);
    fillCardGrid($('gl-home-trending'), (homeCache.trending || []).slice(0, 24));
    fillCardGrid($('gl-home-updates'), (homeCache.updates || []).slice(0, 24));
  }

  // ================= 时间表 =================
  const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  async function loadCalendarView() {
    let week = null;
    let seasons = [];
    let label = '当季';
    if (calSeasonIdx === 0) {
      if (!calWeek) {
        try { calWeek = await G.bgm.calendar(glFetch); } catch (e) { calWeek = null; }
      }
      week = calWeek && calWeek.week;
      seasons = (calWeek && calWeek.seasons) || [];
    } else {
      const list = ((calWeek && calWeek.seasons) || []);
      const idx = calSeasonIdx - 1;
      const s = list[idx];
      if (!s) { calSeasonIdx = 0; return loadCalendarView(); }
      label = s;
      const m = String(s).match(/(Spring|Summer|Fall|Winter|秋|夏|春|冬)\s*(\d{4})|(\d{4})\s*[-\/年.]\s*(\d{1,2})/i);
      let y = null, mo = null;
      if (m) {
        if (m[4]) { y = Number(m[3]); mo = Number(m[4]); }
        else {
          y = Number(m[2]);
          const s2 = (m[1] || '').toLowerCase();
          mo = s2 === 'spring' || m[1] === '春' ? 3 : s2 === 'summer' || m[1] === '夏' ? 6 : s2 === 'fall' || m[1] === '秋' ? 9 : 12;
        }
      }
      if (y && mo) {
        try { const c = await G.bgm.seasonCalendar(y, mo, glFetch); week = c.week; } catch (e) { week = null; }
      }
    }
    $('gl-cal-label').textContent = label;
    const list = $('gl-calendar-list');
    list.innerHTML = '';
    if (!week || !week.length) {
      list.innerHTML = '<div class="empty-state" style="padding:20px 0">本时段暂无番剧数据</div>';
      return;
    }
    week.forEach((daySubjects, di) => {
      const col = document.createElement('div');
      col.className = 'gl-cal-day';
      const h = document.createElement('div');
      h.className = 'gl-cal-dayname';
      h.textContent = DAY_NAMES[di] || ('周' + (di + 1));
      col.appendChild(h);
      (daySubjects || []).forEach((s) => col.appendChild(subjectCard(s)));
      list.appendChild(col);
    });
  }

  function renderCalendarView() { loadCalendarView(); }

  // ================= 搜索 =================
  function fillSourceSelect() {
    const sel = $('gl-source-select');
    sel.innerHTML = '';
    const addOpt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    addOpt('bgm', '番剧数据（按名/片名检索）');
    addOpt('all', '全部源（' + plugins.length + ' 个）');
    for (const p of plugins) addOpt('p|' + p.name, p.name || '(未命名规则)');
  }

  async function doSearch() {
    const src = $('gl-source-select').value;
    const kw = String($('gl-keyword').value || '').trim();
    const box = $('gl-search-results');
    box.innerHTML = '';
    if (src === 'bgm') {
      if (!kw) { showToast('输入作品名', 'info'); return; }
      box.innerHTML = '<div class="empty-state" style="padding:16px 0">检索中…</div>';
      try {
        const list = await G.bgm.search(kw, glFetch);
        pushSearchHistory(kw);
        fillCardGrid(box, list);
        if (!list.length) box.innerHTML = '<div class="empty-state" style="padding:16px 0">没有检索到「' + esc(kw) + '」</div>';
      } catch (e) {
        box.innerHTML = '<div class="empty-state" style="padding:16px 0">' + esc(e.message) + '</div>';
      }
      return;
    }
    if (!plugins.length) { showToast('还没有规则，先去「规则」页添加', 'info'); return; }
    if (src === 'all' && !kw) { showToast('输入关键词', 'info'); return; }
    box.innerHTML = '<div class="empty-state" style="padding:16px 0">检索中…</div>';
    try {
      if (src === 'all') {
        pushSearchHistory(kw);
        const { results, errors } = await G.searchAll(plugins, kw, glFetch, 4);
        box.innerHTML = '';
        let any = false;
        for (const name of Object.keys(results)) {
          const r = results[name];
          if (!r.items.length) continue;
          any = true;
          const block = document.createElement('div');
          block.className = 'gl-result-group';
          const h = document.createElement('div');
          h.className = 'gl-result-group-title';
          h.textContent = name + '（' + r.items.length + '）';
          block.appendChild(h);
          for (const it of r.items) block.appendChild(searchItemRow(it, findPluginByName(name)));
          box.appendChild(block);
        }
        for (const name of Object.keys(errors)) {
          const d = document.createElement('div');
          d.className = 'gl-result-error';
          d.textContent = name + '：' + errors[name];
          box.appendChild(d);
        }
        if (!any) box.insertAdjacentHTML('beforeend', '<div class="empty-state" style="padding:16px 0">没有检索到「' + esc(kw) + '」</div>');
      } else {
        const p = findPluginByName(src.slice(3));
        if (!p) return;
        pushSearchHistory(kw);
        const r = await G.searchPlugin(p, kw, glFetch);
        box.innerHTML = '';
        r.items.forEach((it) => box.appendChild(searchItemRow(it, p)));
        if (r.diagnostics && r.diagnostics.length) {
          const d = document.createElement('div');
          d.className = 'gl-result-error';
          d.textContent = r.diagnostics.slice(0, 3).join('；');
          box.appendChild(d);
        }
        if (!r.items.length) box.insertAdjacentHTML('beforeend', '<div class="empty-state" style="padding:16px 0">没有检索到「' + esc(kw) + '」</div>');
      }
    } catch (e) {
      box.innerHTML = '<div class="empty-state" style="padding:16px 0">' + esc(e.message) + '</div>';
    }
  }

  function findPluginByName(name) { return plugins.find((p) => p.name === name) || null; }

  function pushSearchHistory(kw) {
    if (!kw) return;
    const h = (store.searchHistory = store.searchHistory || []).filter((x) => x.keyword !== kw);
    h.unshift({ keyword: kw, at: Date.now() });
    store.searchHistory = h.slice(0, 20);
    saveStore({ searchHistory: store.searchHistory });
  }

  // 规则搜索命中项 → 详情（带来源页，可用于取集数）
  function searchItemRow(item, plugin) {
    const row = document.createElement('div');
    row.className = 'gl-result-item';
    row.innerHTML =
      '<span class="gl-result-item-name" title="' + esc(item.name) + '"></span>' +
      '<span class="gl-result-item-src"></span>' +
      '<button class="secondary-button small">打开</button>';
    row.querySelector('.gl-result-item-name').textContent = item.name;
    row.querySelector('.gl-result-item-src').textContent = (item.src || '').slice(0, 60);
    row.querySelector('button').addEventListener('click', (ev) => {
      ev.stopPropagation();
      openDetailBySearch(item, plugin);
    });
    row.addEventListener('click', () => openDetailBySearch(item, plugin));
    return row;
  }

  // 识图（本地图片 / 封面 URL）
  function bindTrace() {
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = 'image/*'; fi.id = 'gl-trace-file'; fi.style.display = 'none';
    $('page-ganlu').appendChild(fi);
    fi.addEventListener('change', () => {
      const f = fi.files && fi.files[0];
      fi.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { if (reader.result) runTrace(String(reader.result), null); };
      reader.readAsDataURL(f);
    });
  }

  async function runTrace(fileBase64, url, target) {
    const box = target || $('gl-search-results');
    if (!target) switchGlTab('search');
    box.innerHTML = '<div class="empty-state" style="padding:16px 0">识图中…</div>';
    try {
      const list = await G.traceImage(fileBase64, url, glFetch);
      box.innerHTML = '';
      if (!list.length) { box.innerHTML = '<div class="empty-state" style="padding:16px 0">没有识别到作品</div>'; return; }
      for (const r of list.slice(0, 10)) {
        const row = document.createElement('div');
        row.className = 'gl-result-item';
        const nameTxt = r.anime ? r.anime + (r.title && r.title !== r.anime ? ' ' + r.title : '') : (r.title || '(未命名)');
        row.innerHTML =
          '<span class="gl-result-item-name" title="' + esc(nameTxt) + '"></span>' +
          '<span class="gl-result-item-src"></span>' +
          '<button class="secondary-button small">打开</button>';
        row.querySelector('.gl-result-item-name').textContent = nameTxt;
        row.querySelector('.gl-result-item-src').textContent = r.bgmId ? ('番剧 #' + r.bgmId + (r.score != null ? ' · 相似度 ' + Math.round(r.score * 100) + '%' : '')) : (r.filename || '');
        const btn = row.querySelector('button');
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!r.bgmId) { showToast('该结果没有番剧数据编号', 'info'); return; }
          try { const subj = await G.bgm.subject(r.bgmId, glFetch); openDetailBySubject(subj); }
          catch (e) { showToast('作品数据加载失败：' + e.message, 'error'); }
        });
        row.addEventListener('click', async () => {
          if (!r.bgmId) return;
          try { const subj = await G.bgm.subject(r.bgmId, glFetch); openDetailBySubject(subj); }
          catch (e) { showToast('作品数据加载失败：' + e.message, 'error'); }
        });
        box.appendChild(row);
      }
    } catch (e) {
      box.innerHTML = '<div class="empty-state" style="padding:16px 0">' + esc(e.message) + '</div>';
    }
  }

  // ================= 详情面板 =================
  function openDetailBySubject(subj) {
    curDetail = {
      title: subj.nameCn || subj.name || '',
      cover: subj.cover || '',
      bgmId: subj.id != null ? subj.id : null,
      subject: subj,
      src: '',
      plugin: null,
      roads: [],
      roadIdx: 0,
      epIdx: 0,
      rawUrl: '',
      ua: '',
      referer: '',
    };
    renderDetail();
  }

  async function openDetailBySearch(item, plugin) {
    curDetail = {
      title: item.name || '',
      cover: '',
      bgmId: null,
      subject: null,
      src: item.src || '',
      plugin,
      roads: [],
      roadIdx: 0,
      epIdx: 0,
      rawUrl: '',
      ua: G.randomUA(),
      referer: plugin.referer || '',
    };
    renderDetail();
    // 异步补番剧数据（同名匹配则带封面/评分/弹幕能力）
    G.bgm.search(curDetail.title, glFetch).then((list) => {
      const hit = list.find((s) => s.id != null && (s.nameCn === curDetail.title || s.name === curDetail.title)) || list[0];
      if (hit && curDetail && curDetail.title === item.name) {
        if (hit.id != null && curDetail.bgmId == null) curDetail.bgmId = hit.id;
        curDetail.cover = hit.cover || curDetail.cover;
        curDetail.subject = hit;
        renderDetail();
      }
    }).catch(() => {});
    loadChaptersForDetail(plugin);
  }

  async function loadChaptersForDetail(plugin) {
    if (!curDetail || !plugin) return;
    const box = $('gl-detail-body');
    const holder = $('gl-roads');
    if (holder) holder.innerHTML = '<div class="empty-state" style="padding:10px 0">取集数中…</div>';
    let src = curDetail.src;
    if (!src) {
      try {
        const r = await G.searchPlugin(plugin, curDetail.title, glFetch);
        src = (r.items[0] && r.items[0].src) || '';
      } catch (e) { src = ''; }
      if (!src) {
        if (holder) holder.innerHTML = '<div class="empty-state" style="padding:10px 0">该源未检索到「' + esc(curDetail.title) + '」，换个源试试</div>';
        return;
      }
      curDetail.src = src;
    }
    try {
      const c = await G.chaptersPlugin(plugin, src, glFetch);
      if (!curDetail || curDetail.plugin !== plugin) return; // 已切走
      curDetail.roads = c.roads || [];
      curDetail.roadIdx = 0;
      renderRoads();
    } catch (e) {
      if (holder) holder.innerHTML = '<div class="gl-result-error">' + esc(e.message) + '</div>';
    }
  }

  function renderDetail() {
    const panel = $('gl-detail');
    const body = $('gl-detail-body');
    if (!curDetail) { panel.hidden = true; return; }
    panel.hidden = false;
    const d = curDetail;
    const subj = d.subject;
    const collectSt = d.bgmId != null && store.collect && store.collect[String(d.bgmId)]
      ? store.collect[String(d.bgmId)].type : 0;

    let h = '';
    h += '<div class="gl-detail-head">' +
      (d.cover ? '<img class="gl-detail-cover" src="' + esc(d.cover) + '" onerror="this.style.display=\'none\'" alt="">' : '<div class="gl-detail-cover gl-detail-cover-empty"></div>') +
      '<div class="gl-detail-info"><h3></h3><div class="gl-detail-meta"></div><div class="gl-detail-tags"></div></div>' +
      '</div>';
    body.innerHTML = h;
    body.querySelector('h3').textContent = d.title || '(未命名)';
    const metaBits = [];
    if (subj && subj.rating != null) metaBits.push(star(subj.rating) + '（' + (subj.ratingCount || 0) + ' 人）');
    if (subj && subj.eps) metaBits.push(subj.eps + ' 集');
    if (subj && subj.season) metaBits.push(subj.season);
    if (subj && subj.aired) metaBits.push(subj.aired);
    body.querySelector('.gl-detail-meta').textContent = metaBits.join(' · ');
    body.querySelector('.gl-detail-tags').textContent = (subj && subj.tags ? subj.tags.slice(0, 8).join(' / ') : '');

    // 操作行：追番 + 弹幕/一起看/投屏提示 + 识图 + 下载
    const act = document.createElement('div');
    act.className = 'gl-detail-actions';
    const collectBtn = document.createElement('button');
    collectBtn.className = 'secondary-button small';
    collectBtn.textContent = collectSt ? GL_STATUS[collectSt] || '追番' : '＋ 追番';
    collectBtn.addEventListener('click', () => cycleCollect(d));
    act.appendChild(collectBtn);
    if (d.cover) {
      const tr = document.createElement('button');
      tr.className = 'secondary-button small';
      tr.textContent = '📷 识图';
      tr.addEventListener('click', () => runTrace(null, d.cover, $('gl-detail-trace')));
      act.appendChild(tr);
    }
    body.appendChild(act);
    const trBox = document.createElement('div');
    trBox.id = 'gl-detail-trace';
    trBox.className = 'gl-detail-subbox';
    body.appendChild(trBox);

    // 来源选择
    const srcRow = document.createElement('div');
    srcRow.className = 'gl-detail-subbox';
    const sel = document.createElement('select');
    sel.className = 'field-input gl-detail-srcselect';
    sel.innerHTML = '<option value="">— 选择播放源 —</option>';
    for (const p of plugins) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name || '(未命名规则)';
      sel.appendChild(o);
    }
    if (d.plugin && findPluginByName(d.plugin.name)) sel.value = d.plugin.name;
    sel.addEventListener('change', () => {
      const p = findPluginByName(sel.value);
      if (!p) return;
      curDetail.plugin = p;
      curDetail.roads = [];
      curDetail.ua = G.randomUA();
      curDetail.referer = p.referer || '';
      loadChaptersForDetail(p);
    });
    srcRow.appendChild(sel);
    srcRow.id = 'gl-sources';
    body.appendChild(srcRow);

    // 线路 + 集数
    const roadsBox = document.createElement('div');
    roadsBox.id = 'gl-roads';
    roadsBox.className = 'gl-detail-subbox';
    body.appendChild(roadsBox);
    if (d.roads.length) renderRoads();

    // 简介 / 评论
    if (subj && subj.summary) {
      const box = document.createElement('div');
      box.className = 'gl-detail-subbox';
      box.innerHTML = '<div class="gl-detail-subtitle">简介</div><div class="gl-detail-summary"></div>';
      box.querySelector('.gl-detail-summary').textContent = subj.summary.slice(0, 400);
      body.appendChild(box);
    }
    if (d.bgmId != null) {
      G.bgm.comments(d.bgmId, glFetch).then((cs) => {
        if (!cs || !cs.length) return;
        if (!$('gl-detail-comments') && curDetail && curDetail.bgmId === d.bgmId) {
          const c = document.createElement('div');
          c.className = 'gl-detail-subbox';
          c.id = 'gl-detail-comments';
          c.innerHTML = '<div class="gl-detail-subtitle">评论（节选）</div>';
          for (const x of cs) {
            const r = document.createElement('div');
            r.className = 'gl-comment';
            r.innerHTML = '<div class="gl-comment-head"></div><div class="gl-comment-body"></div>';
            r.querySelector('.gl-comment-head').textContent = (x.user || '匿名') + (x.score != null ? ' · ' + x.score : '');
            r.querySelector('.gl-comment-body').textContent = String(x.content || '').slice(0, 200);
            c.appendChild(r);
          }
          body.appendChild(c);
        } else if ($('gl-detail-comments')) { /* 已渲染 */ }
      }).catch(() => {});

      // 角色 / 制作人员 / 相关条目（p1 公开数据，失败静默）
      const relBox = document.createElement('div');
      relBox.id = 'gl-detail-rel';
      relBox.className = 'gl-detail-subbox gl-detail-rel';
      relBox.innerHTML =
        '<div class="gl-detail-subtitle">角色</div>' +
        '<div class="gl-rel-chips gl-rel-row" data-k="characters"></div>' +
        '<div class="gl-detail-subtitle">制作人员</div>' +
        '<div class="gl-rel-chips gl-rel-row" data-k="staff"></div>' +
        '<div class="gl-detail-subtitle">相关条目</div>' +
        '<div class="gl-rel-chips gl-rel-row" data-k="relations"></div>';
      body.appendChild(relBox);
      const drawChips = (k, arr, isRel) => {
        if (curDetail && curDetail.bgmId !== d.bgmId) return;
        const row = relBox.querySelector('[data-k="' + k + '"]');
        if (!row || !arr || !arr.length) { if (row) row.textContent = arr && arr.length ? '' : '（无数据）'; return; }
        row.textContent = '';
        for (const x of arr.slice(0, isRel ? 12 : 12)) {
          const chip = document.createElement('span');
          chip.className = 'gl-chip';
          if (x.pic) {
            const im = document.createElement('img');
            im.className = 'gl-chip-pic';
            im.src = x.pic;
            im.referrerPolicy = 'no-referrer';
            im.addEventListener('error', () => im.remove());
            chip.appendChild(im);
          }
          const t = document.createElement('span');
          t.textContent = isRel ? ((x.relation ? x.relation + ' · ' : '') + x.name) : (x.role ? (x.name + ' ' + x.role) : x.name);
          chip.appendChild(t);
          chip.title = t.textContent;
          if (isRel && x.id != null) {
            chip.classList.add('gl-chip-link');
            chip.addEventListener('click', () => G.bgm.subject(x.id, glFetch).then((s) => openDetailBySubject(s)).catch(() => {}));
          }
          row.appendChild(chip);
        }
      };
      G.bgm.characters(d.bgmId, glFetch).then((r) => drawChips('characters', r)).catch(() => {
        const row = relBox.querySelector('[data-k="characters"]');
        if (row) row.textContent = '（获取失败）';
      });
      G.bgm.staff(d.bgmId, glFetch).then((r) => drawChips('staff', r)).catch(() => {});
      G.bgm.relations(d.bgmId, glFetch).then((r) => drawChips('relations', r, true)).catch(() => {});
    }
  }

  function cycleCollect(d) {
    if (d.bgmId == null) { showToast('该作品没有番剧数据编号，无法追番', 'info'); return; }
    const k = String(d.bgmId);
    const cur = store.collect[k] ? Number(store.collect[k].type) || 0 : 0;
    const next = cur >= 5 ? 0 : cur + 1;
    if (next === 0) delete store.collect[k];
    else store.collect[k] = { id: d.bgmId, name: d.title, cover: d.cover || '', type: next, updatedAt: Date.now() };
    saveStore({ collect: store.collect });
    showToast(next ? '已标记「' + GL_STATUS[next] + '」' : '已取消追番', 'info');
    renderDetail();
    if ($('gl-collect-list') && !$('page-ganlu').classList.contains('active')) { /* 无需 */ }
  }

  function renderRoads() {
    const d = curDetail;
    const box = $('gl-roads');
    if (!d || !box) return;
    box.innerHTML = '';
    if (!d.roads.length) { box.innerHTML = '<div class="empty-state" style="padding:10px 0">该源没有可用线路</div>'; return; }
    if (!d.roads[d.roadIdx]) d.roadIdx = 0; // 线路列表变化（续播旧历史）时回落到第一条
    const tabs = document.createElement('div');
    tabs.className = 'gl-road-tabs';
    d.roads.forEach((road, i) => {
      const b = document.createElement('button');
      b.className = 'gl-road-tab' + (i === d.roadIdx ? ' active' : '');
      b.textContent = road.name || ('线路 ' + (i + 1));
      b.addEventListener('click', () => { d.roadIdx = i; d.epIdx = 0; renderRoads(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    const road = d.roads[d.roadIdx];
    const head = document.createElement('div');
    head.className = 'gl-road-head';
    head.innerHTML = '<span class="gl-road-count"></span><span class="gl-spacer"></span>';
    head.querySelector('.gl-road-count').textContent = road.identifier.length + ' 集';
    const dlBtn = document.createElement('button');
    dlBtn.className = 'secondary-button small';
    dlBtn.textContent = '⬇ 下载本线路';
    dlBtn.addEventListener('click', () => startDownloadRoad(d, d.roadIdx));
    head.appendChild(dlBtn);
    box.appendChild(head);

    const list = document.createElement('div');
    list.className = 'gl-ep-list';
    road.data.forEach((url, i) => {
      const r = document.createElement('div');
      r.className = 'gl-ep-row' + (i === d.epIdx ? ' current' : '');
      r.innerHTML = '<span class="gl-ep-idx">' + (i + 1) + '</span><span class="gl-ep-name"></span><span class="gl-ep-go">播放</span>';
      r.querySelector('.gl-ep-name').textContent = (road.identifier && road.identifier[i]) || ('第 ' + (i + 1) + ' 集');
      r.addEventListener('click', () => { d.epIdx = i; playDetailEp(d.roadIdx, i); });
      list.appendChild(r);
    });
    box.appendChild(list);
  }

  // 播放：预解析当前 + 下一集，交给播放器（懒解析后续集由 player.js 承担）
  async function playDetailEp(roadIdx, epIdx, resumePosMs) {
    const d = curDetail;
    if (!d || !d.plugin || !d.roads[roadIdx]) return;
    const road = d.roads[roadIdx];
    const eps = road.data.map((u, i) => ({
      type: 'stream',
      value: '',
      page: u,
      label: (road.identifier && road.identifier[i]) || ('第 ' + (i + 1) + ' 集'),
      streamOpts: { ua: d.ua, referer: d.referer },
    }));
    const directRe = /\.(m3u8|m3u|mp4|mov|webm|flv|mp3)([?#]|$)/i;
    const pick = (i) => {
      const e = eps[i];
      if (directRe.test(e.page)) { e.value = e.page; e._kind = /\.(m3u8|m3u)([?#]|$)/i.test(e.page) ? 'hls' : 'media'; }
      return e;
    };
    pick(epIdx);
    const ep0 = eps[epIdx];
    if (!ep0.value) {
      const r = await resolvePage(ep0.page, { referer: d.referer });
      if (!r) { showToast('解析不到播放地址，试试其它线路', 'error'); return; }
      ep0.value = r.url;
      ep0._kind = r.kind;
    }
    if (eps[epIdx + 1]) pick(epIdx + 1); // 背景预解析下一集（未直链则交给播放器懒解析）

    glSession = {
      key: d.plugin.name + '|' + (d.src || ('bgm:' + d.bgmId)),
      bgmId: d.bgmId,
      title: d.title,
      cover: d.cover || '',
      pluginName: d.plugin.name,
      src: d.src,
      roadIdx,
      epIndex: epIdx,
      roadLabel: road.name,
      rawUrl: ep0.value,
      resumePosMs,
      at: Date.now(),
    };
    saveHistory(glSession, 0);

    const ctx = {
      file: ep0.value,
      title: (d.title || '甘露影视源') + ' ' + ep0.label + (d.plugin && d.plugin.name ? ' · ' + d.plugin.name : ''),
      stream: ep0._kind === 'hls' ? 'hls' : true,
      streamOpts: ep0.streamOpts,
      episodes: eps,
      epIndex: epIdx,
      autoNext: true,
      _gl: glSession,
    };
    XVP.open(ctx);
    markDetailEp(roadIdx, epIdx);
  }

  function markDetailEp(roadIdx, epIdx) {
    curDetail.roadIdx = roadIdx;
    curDetail.epIdx = epIdx;
    renderRoads();
  }

  // 剧集页 → 媒体地址（直接 m3u8/直链放行；否则走主进程解析窗）
  function resolvePage(url, opts) {
    const directRe = /\.(m3u8|m3u|mp4|mov|webm|flv|mp3)([?#]|$)/i;
    if (directRe.test(url)) {
      return Promise.resolve({ url, kind: /\.(m3u8|m3u)([?#]|$)/i.test(url) ? 'hls' : 'media' });
    }
    const tag = 'gl_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    return new Promise((resolve) => {
      const cap = (p) => {
        if (!p || p.tag !== tag) return;
        api.offGanluResolveCapture(cap);
        api.offGanluResolveTimeout(to);
        resolve(p.url ? { url: p.url, kind: /\.(m3u8|m3u)([?#]|$)/i.test(p.url) ? 'hls' : 'media' } : null);
      };
      const to = (p) => {
        if (!p || p.tag !== tag) return;
        api.offGanluResolveCapture(cap);
        api.offGanluResolveTimeout(to);
        resolve(null);
      };
      if (!api.onGanluResolveCapture) { resolve(null); return; }
      api.onGanluResolveCapture(cap);
      api.onGanluResolveTimeout(to);
      api.ganluResolve({ url, tag, referer: (opts && opts.referer) || '', timeoutMs: 20000 }).catch(() => {
        api.offGanluResolveCapture(cap);
        api.offGanluResolveTimeout(to);
        resolve(null);
      });
    });
  }

  // ================= 追番 =================
  function renderCollectView() {
    const filters = $('gl-collect-filters');
    const list = $('gl-collect-list');
    if (!store.collect) store.collect = {};
    const entries = Object.values(store.collect);
    filters.innerHTML = '';
    const mkFilter = (label, type) => {
      const b = document.createElement('button');
      b.className = 'gl-filter' + (type === 'all' ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        filters.querySelectorAll('.gl-filter').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderCollectList(type);
      });
      filters.appendChild(b);
    };
    mkFilter('全部 ' + entries.length, 'all');
    for (const t of [1, 2, 3, 4, 5]) {
      const n = entries.filter((x) => Number(x.type) === t).length;
      if (n) mkFilter(GL_STATUS[t] + ' ' + n, t);
    }
    renderCollectList('all');
  }

  function renderCollectList(type) {
    const list = $('gl-collect-list');
    list.innerHTML = '';
    let entries = Object.values(store.collect || {});
    if (type !== 'all') entries = entries.filter((x) => Number(x.type) === type);
    if (!entries.length) {
      list.innerHTML = '<div class="empty-state" style="padding:16px 0">还没有追番记录</div>';
      return;
    }
    for (const x of entries) {
      const c = document.createElement('div');
      c.className = 'gl-card';
      c.innerHTML =
        '<div class="gl-card-cover"><img src="' + esc(x.cover || '') + '" loading="lazy" onerror="this.style.display=\'none\'"></div>' +
        '<div class="gl-card-name"></div><div class="gl-card-meta"></div>' +
        '<div class="gl-card-actions"><select class="field-input small"></select><button class="secondary-button small">播放</button><button class="secondary-button small danger">移除</button></div>';
      c.querySelector('.gl-card-name').textContent = x.name || ('#' + x.id);
      c.querySelector('.gl-card-meta').textContent = GL_STATUS[Number(x.type)] || '';
      const sel = c.querySelector('select');
      for (const t of [1, 2, 3, 4, 5]) {
        const o = document.createElement('option');
        o.value = t; o.textContent = GL_STATUS[t];
        if (Number(x.type) === t) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        x.type = Number(sel.value);
        x.updatedAt = Date.now();
        saveStore({ collect: store.collect });
        renderCollectView();
      });
      c.querySelector('.gl-card-actions button:not(.danger)').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (x.id == null) { showToast('该条没有番剧数据编号', 'info'); return; }
        try {
          const subj = await G.bgm.subject(x.id, glFetch);
          openDetailBySubject(subj);
        } catch (e) { showToast('加载失败：' + e.message, 'error'); }
      });
      c.querySelector('.danger').addEventListener('click', (ev) => {
        ev.stopPropagation();
        delete store.collect[String(x.id)];
        saveStore({ collect: store.collect });
        renderCollectView();
      });
      list.appendChild(c);
    }
  }

  // ================= 历史 =================
  function renderHistoryView() {
    const list = $('gl-history-list');
    list.innerHTML = '';
    const entries = Object.entries(store.history || {});
    if (!entries.length) {
      list.innerHTML = '<div class="empty-state" style="padding:16px 0">还没有观看历史</div>';
      return;
    }
    entries.sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0)).forEach(([key, h]) => {
      const row = document.createElement('div');
      row.className = 'gl-history-row';
      const pos = h.progresses && h.progresses[String(h.lastEp != null ? h.lastEp : 0)];
      row.innerHTML =
        '<div class="gl-history-title"></div><div class="gl-history-meta"></div>' +
        '<button class="secondary-button small">继续</button>' +
        '<button class="secondary-button small danger">清除</button>';
      row.querySelector('.gl-history-title').textContent = h.title || key;
      row.querySelector('.gl-history-meta').textContent =
        (h.pluginName ? h.pluginName + ' · ' : '') + '第 ' + (h.lastEp + 1) + ' 集' +
        (pos && pos.posMs ? ' · ' + Math.floor(pos.posMs / 1000) + 's' : '') + ' · ' + fmtWhen(h.lastAt);
      row.querySelector('.danger').addEventListener('click', () => {
        delete store.history[key];
        saveStore({ history: store.history });
        renderHistoryView();
      });
      row.querySelector('button:not(.danger)').addEventListener('click', () => resumeHistory(key, h));
      list.appendChild(row);
    });
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  async function resumeHistory(key, h) {
    const p = findPluginByName(h.lastSrc || '');
    if (!p) { showToast('原播放源已删除，无法续播', 'error'); return; }
    curDetail = {
      title: h.title || '', cover: h.cover || '', bgmId: h.bgmId != null ? h.bgmId : null,
      subject: null, src: h.lastPage || '', plugin: p, roads: [], roadIdx: Number(h.lastRoad) || 0,
      epIdx: Number(h.lastEp) || 0, rawUrl: '', ua: G.randomUA(), referer: p.referer || '',
    };
    renderDetail();
    await loadChaptersForDetail(p);
    const pos = h.progresses && h.progresses[String(curDetail.epIdx)];
    playDetailEp(curDetail.roadIdx, curDetail.epIdx, pos && pos.posMs ? pos.posMs : 0);
  }

  function saveHistory(gl, posMs) {
    if (!gl || !store) return;
    const key = gl.key;
    const h = store.history[key] || { progresses: {} };
    h.lastEp = gl.epIndex;
    h.lastRoad = gl.roadIdx;
    h.lastSrc = gl.pluginName || '';
    h.lastPage = gl.src || '';
    h.lastAt = Date.now();
    h.title = gl.title;
    h.cover = gl.cover || '';
    h.bgmId = gl.bgmId;
    if (posMs) h.progresses[String(gl.epIndex)] = { road: gl.roadIdx, posMs, at: Date.now() };
    store.history[key] = h;
    saveStore({ history: store.history });
  }

  // ================= 下载 =================
  function renderDownloadDir() {
    const dir = (store.settings && store.settings.download && store.settings.download.dir) || '';
    $('gl-download-dir').textContent = dir ? '（' + dir + '）' : '（默认：数据目录/downloads）';
  }

  function startDownloadRoad(d, roadIdx) {
    const road = d.roads[roadIdx];
    const dl = (store.settings && store.settings.download) || {};
    api.ganluDownloadStart({
      pluginName: d.plugin.name,
      title: d.title,
      episodes: road.identifier || road.data.map((_, i) => '第 ' + (i + 1) + ' 集'),
      urls: road.data,
      headers: { 'user-agent': d.ua || G.randomUA(), referer: d.referer || '' },
      dir: dl.dir || '',
      episodeParallel: dl.episodeParallel,
      segmentParallel: dl.segmentParallel,
    }).then((r) => {
      if (!r || !r.taskId) return;
      dlLive.set(r.taskId, { running: true, episodes: [] });
      showToast('下载任务已创建（' + road.data.length + ' 集）', 'info');
      refreshStore().then(() => { renderDownloadList(); switchGlTab('download'); });
    }).catch((e) => showToast('下载任务创建失败：' + e.message, 'error'));
  }

  function renderDownloadList() {
    const box = $('gl-download-list');
    box.innerHTML = '';
    const tasks = Object.values(store.downloads || {});
    tasks.sort((a, b) => (b.task.createdAt || 0) - (a.task.createdAt || 0));
    if (!tasks.length) {
      box.innerHTML = '<div class="empty-state" style="padding:16px 0">还没有下载任务（在详情里点「下载本线路」）</div>';
      return;
    }
    for (const t of tasks) {
      const live = dlLive.get(t.task.taskId);
      const eps = (live && live.episodes.length) ? live.episodes : (t.task.episodes || []);
      const running = live ? live.running : false;
      const card = document.createElement('div');
      card.className = 'gl-dl-card' + (running ? ' running' : '');
      card.innerHTML =
        '<div class="gl-dl-head"><span class="gl-dl-title"></span><span class="gl-dl-state"></span>' +
        '<span class="gl-spacer"></span>' +
        (running ? '<button class="secondary-button small gl-dl-pause">暂停</button><button class="secondary-button small gl-dl-cancel">取消</button>' : '<button class="secondary-button small gl-dl-remove">移除</button>') +
        '</div><div class="gl-dl-eps"></div>';
      card.querySelector('.gl-dl-title').textContent = t.task.title + (t.task.pluginName ? ' · ' + t.task.pluginName : '');
      const doneCount = eps.filter((e) => e.status === 'completed').length;
      card.querySelector('.gl-dl-state').textContent = running ? '下载中 ' + doneCount + '/' + eps.length : (doneCount === eps.length && eps.length ? '已完成' : '已暂停');
      const epBox = card.querySelector('.gl-dl-eps');
      for (const e of eps) {
        const r = document.createElement('div');
        r.className = 'gl-dl-ep';
        const p = Math.round((e.progress || 0) * 100);
        const stTxt = e.status === 'completed' ? '完成' : e.status === 'failed' ? (e.error || '失败') : e.status === 'resolving' ? '解析中' : e.status === 'paused' ? '已暂停' : e.status === 'downloading' ? Math.min(p, 99) + '%' : '等待';
        r.innerHTML = '<span class="gl-dl-ep-label"></span><div class="gl-dl-bar"><div class="gl-dl-bar-in" style="width:' + p + '%"></div></div><span class="gl-dl-ep-state"></span>';
        r.querySelector('.gl-dl-ep-label').textContent = (e.label || ('第 ' + (e.i + 1) + ' 集'));
        r.querySelector('.gl-dl-ep-state').textContent = stTxt;
        epBox.appendChild(r);
      }
      const tid = t.task.taskId;
      const bp = card.querySelector('.gl-dl-pause');
      if (bp) bp.addEventListener('click', () => { api.ganluDownloadPause(tid); });
      const bc = card.querySelector('.gl-dl-cancel');
      if (bc) bc.addEventListener('click', () => { api.ganluDownloadCancel(tid); dlLive.delete(tid); refreshStore().then(renderDownloadList); });
      const br = card.querySelector('.gl-dl-remove');
      if (br) br.addEventListener('click', async () => {
        const ok = await showConfirm('移除该下载任务记录？（已下载文件保留）');
        if (!ok) return;
        delete store.downloads[tid];
        dlLive.delete(tid);
        saveStore({ downloads: store.downloads });
        renderDownloadList();
      });
      box.appendChild(card);
    }
  }

  function onDownloadProgress(p) {
    if (!p || !p.taskId) return;
    dlLive.set(p.taskId, { running: !!p.running, episodes: p.episodes || [] });
    if ($('gl-download').classList.contains('active')) renderDownloadList();
  }

  // ================= 规则 =================
  function renderRuleList() {
    const box = $('gl-rule-list');
    box.innerHTML = '';
    if (!plugins.length) {
      box.innerHTML = '<div class="empty-state" style="padding:16px 0">还没有规则。点「新建规则」手工配置，或「导入」粘贴规则文本。</div>';
      return;
    }
    plugins.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'gl-rule-row';
      row.innerHTML =
        '<div class="gl-rule-info"><div class="gl-rule-name"></div><div class="gl-rule-meta"></div></div>' +
        '<button class="secondary-button small gl-rule-edit">编辑</button>' +
        '<button class="secondary-button small gl-rule-test">测试</button>' +
        '<button class="secondary-button small danger gl-rule-del">删除</button>';
      row.querySelector('.gl-rule-name').textContent = p.name || '(未命名规则)';
      row.querySelector('.gl-rule-meta').textContent =
        (p.searchMode === 'api' ? '搜索·API' : '搜索·XPath') + ' / ' +
        (p.chapterMode === 'api' ? '集数·API' : '集数·XPath') +
        (p.baseUrl ? ' · ' + p.baseUrl : '');
      row.querySelector('.gl-rule-edit').addEventListener('click', () => openRuleEditor(i));
      row.querySelector('.gl-rule-test').addEventListener('click', () => {
        const kw = prompt('测试搜索关键词：', '');
        if (kw == null) return;
        G.searchPlugin(p, kw.trim(), glFetch).then((r) => {
          showToast('「' + p.name + '」检索到 ' + r.items.length + ' 条' + (r.diagnostics.length ? '（' + r.diagnostics.slice(0, 2).join('；') + '）' : ''), 'info');
        }).catch((e) => showToast('测试失败：' + e.message, 'error'));
      });
      row.querySelector('.gl-rule-del').addEventListener('click', async () => {
        const ok = await showConfirm('删除规则「' + (p.name || '(未命名)') + '」？');
        if (!ok) return;
        plugins.splice(i, 1);
        savePlugins();
        renderRuleList();
        fillSourceSelect();
      });
      box.appendChild(row);
    });
  }

  let ruleEditIdx = -1;
  function openRuleEditor(idx) {
    ruleEditIdx = idx;
    const p = idx >= 0 ? plugins[idx] : G.pluginFromTemplate();
    const ed = $('gl-rule-editor');
    ed.hidden = false;
    ed.innerHTML =
      '<div class="gl-rule-edit-head"><h4>' + (idx >= 0 ? '编辑规则' : '新建规则') + '</h4><button id="gle-close" class="secondary-button small">收起</button></div>' +
      '<div class="gl-rule-grid">' +
      '<label class="field-label">名称<input type="text" id="gle-name" class="field-input" value="' + esc(p.name) + '"></label>' +
      '<label class="field-label">Base URL<input type="text" id="gle-base" class="field-input" value="' + esc(p.baseUrl) + '" placeholder="https://…"></label>' +
      '<label class="field-label">Referer<input type="text" id="gle-referer" class="field-input" value="' + esc(p.referer) + '"></label>' +
      '<label class="field-label">UserAgent<input type="text" id="gle-ua" class="field-input" value="' + esc(p.userAgent) + '" placeholder="留空则随机"></label>' +
      '<label class="gl-check"><input type="checkbox" id="gle-usepost"' + (p.usePost ? ' checked' : '') + '> 搜索用 POST</label>' +
      '<label class="field-label">搜索模式<select id="gle-searchmode" class="field-input">' +
      '<option value="xpath"' + (p.searchMode === 'api' ? '' : ' selected') + '>XPath</option>' +
      '<option value="api"' + (p.searchMode === 'api' ? ' selected' : '') + '>API</option></select></label>' +
      '<label class="field-label">搜索 URL（@keyword 占位）<input type="text" id="gle-searchurl" class="field-input" value="' + esc(p.searchURL) + '"></label>' +
      '<label class="field-label">结果列表 XPath<input type="text" id="gle-searchlist" class="field-input" value="' + esc(p.searchList) + '"></label>' +
      '<label class="field-label">结果名称 XPath（可选）<input type="text" id="gle-searchname" class="field-input" value="' + esc(p.searchName) + '"></label>' +
      '<label class="field-label">搜索 API 配置（JSON，API 模式）<textarea id="gle-searchapi" class="field-input" rows="5" spellcheck="false"></textarea></label>' +
      '<label class="field-label">集数模式<select id="gle-chapmode" class="field-input">' +
      '<option value="xpath"' + (p.chapterMode === 'api' ? '' : ' selected') + '>XPath</option>' +
      '<option value="api"' + (p.chapterMode === 'api' ? ' selected' : '') + '>API</option></select></label>' +
      '<label class="field-label">线路 XPath<input type="text" id="gle-roadxpath" class="field-input" value="' + esc(p.chapterRoads) + '"></label>' +
      '<label class="field-label">集数 XPath（线路内）<input type="text" id="gle-epxpath" class="field-input" value="' + esc(p.chapterResult) + '"></label>' +
      '<label class="field-label">集数 API 配置（JSON，API 模式）<textarea id="gle-chapapi" class="field-input" rows="6" spellcheck="false"></textarea></label>' +
      '</div>' +
      '<div class="gl-rule-actions">' +
      '<button id="gle-test" class="secondary-button">测试搜索</button>' +
      '<input type="text" id="gle-test-kw" class="field-input" placeholder="测试关键词">' +
      '<span id="gle-test-out" class="gl-rule-test-out"></span>' +
      '<span class="gl-spacer"></span>' +
      '<button id="gle-cancel" class="secondary-button">取消</button>' +
      '<button id="gle-save" class="action-button">保存规则</button>' +
      '</div>';
    $('gle-searchapi').value = p.searchApiConfig && p.searchApiConfig.request ? JSON.stringify(p.searchApiConfig, null, 2) : '';
    $('gle-chapapi').value = p.chapterApiConfig && p.chapterApiConfig.request ? JSON.stringify(p.chapterApiConfig, null, 2) : '';

    const buildPlugin = () => {
      const np = G.pluginFromJson(JSON.parse(JSON.stringify(G.pluginToJson(p))));
      np.name = $('gle-name').value.trim() || np.name || '规则' + (plugins.length + 1);
      np.baseUrl = $('gle-base').value.trim();
      np.referer = $('gle-referer').value.trim();
      np.userAgent = $('gle-ua').value.trim();
      np.usePost = $('gle-usepost').checked;
      np.searchMode = $('gle-searchmode').value;
      np.searchURL = $('gle-searchurl').value.trim();
      np.searchList = $('gle-searchlist').value.trim();
      np.searchName = $('gle-searchname').value.trim();
      np.chapterMode = $('gle-chapmode').value;
      np.chapterRoads = $('gle-roadxpath').value.trim();
      np.chapterResult = $('gle-epxpath').value.trim();
      const sa = $('gle-searchapi').value.trim();
      if (sa) {
        let cfg;
        try { cfg = JSON.parse(sa); } catch (e) { throw new Error('搜索 API 配置不是有效 JSON'); }
        np.searchApiConfig = cfg;
        for (const path of [cfg.listPath, cfg.namePath, cfg.sourcePath]) if (path) G.jsonPathValidate(path);
      } else { np.searchApiConfig = {}; }
      const ca = $('gle-chapapi').value.trim();
      if (ca) {
        let cfg;
        try { cfg = JSON.parse(ca); } catch (e) { throw new Error('集数 API 配置不是有效 JSON'); }
        np.chapterApiConfig = cfg;
        for (const path of [cfg.roadsPath, cfg.episodesPath, cfg.episodeNamePath, cfg.episodeUrlPath, cfg.roadNamesPath, cfg.roadEpisodesPath]) if (path) G.jsonPathValidate(path);
      } else { np.chapterApiConfig = {}; }
      return np;
    };

    $('gle-save').addEventListener('click', () => {
      try {
        const np = buildPlugin();
        if (ruleEditIdx >= 0) plugins[ruleEditIdx] = np;
        else plugins.push(np);
        savePlugins();
        $('gl-rule-editor').hidden = true;
        renderRuleList();
        fillSourceSelect();
        showToast('规则已保存：' + np.name, 'info');
      } catch (e) { showToast(e.message, 'error'); }
    });
    $('gle-test').addEventListener('click', async () => {
      const kw = $('gle-test-kw').value.trim();
      const out = $('gle-test-out');
      if (!kw) { out.textContent = '先输入关键词'; return; }
      out.textContent = '测试中…';
      try {
        const np = buildPlugin();
        const r = await G.searchPlugin(np, kw, glFetch);
        out.textContent = '命中 ' + r.items.length + ' 条' + (r.diagnostics.length ? '（' + r.diagnostics[0] + '）' : '');
      } catch (e) { out.textContent = '失败：' + e.message; }
    });
    const closeEd = () => { $('gl-rule-editor').hidden = true; };
    $('gle-cancel').addEventListener('click', closeEd);
    $('gle-close').addEventListener('click', closeEd);
  }

  function importRules() {
    const text = prompt('粘贴规则文本（JSON 对象 / 数组 / 分享文本 / base64）：');
    if (text == null || !text.trim()) return;
    try {
      const added = G.importRuleText(text);
      const arr = Array.isArray(added) ? added : [added];
      for (const p of arr) {
        const pp = G.pluginFromJson(p);
        const ex = plugins.findIndex((x) => x.name === pp.name && x.version === pp.version);
        if (ex >= 0) plugins[ex] = pp; else plugins.push(pp);
      }
      savePlugins();
      renderRuleList();
      fillSourceSelect();
      showToast('已导入 ' + arr.length + ' 条规则', 'info');
    } catch (e) { showToast('导入失败：' + e.message, 'error'); }
  }

  function shareAll() {
    if (!plugins.length) { showToast('没有可导出的规则', 'info'); return; }
    const text = G.shareText(plugins.map((p) => G.pluginToJson(p)));
    prompt('导出文本（复制后发给他人；再次导入即可还原）：', text);
  }

  // ================= 在线源目录（官方 + 国内镜像双通道，逐源拉 JSON 一键导入）=================
  let catalogItems = null;
  async function loadCatalog() {
    const box = $('gl-catalog-list');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="empty-state" style="padding:12px 0">正在获取在线源目录…</div>';
    try {
      catalogItems = await G.catalog.list(glFetch);
      box.innerHTML = '';
      if (!catalogItems.length) { box.innerHTML = '<div class="empty-state" style="padding:12px 0">目录为空</div>'; return; }
      for (const it of catalogItems) {
        const ex = plugins.findIndex((x) => x.name === it.name && String(x.version) === String(it.version));
        const has = ex >= 0 ? ex : plugins.findIndex((x) => x.name === it.name);
        const row = document.createElement('div');
        row.className = 'gl-result-item';
        row.innerHTML =
          '<span class="gl-result-item-name"></span>' +
          '<span class="gl-result-item-src"></span>' +
          '<button class="secondary-button small"></button>';
        row.querySelector('.gl-result-item-name').textContent = it.name + (it.version ? ' v' + it.version : '');
        const upd = it.lastUpdate ? String(new Date(it.lastUpdate < 1e12 ? it.lastUpdate : it.lastUpdate / 1000).toLocaleDateString('zh-CN')) : '';
        row.querySelector('.gl-result-item-src').textContent = [it.author, upd, has >= 0 ? '（已安装' + (has === ex ? '，同版本' : '旧版' ) + '）' : ''].filter(Boolean).join(' · ');
        const btn = row.querySelector('button');
        btn.textContent = has === ex ? '更新' : (has >= 0 ? '覆盖' : '导入');
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = '导入中…';
          try {
            const p = await G.catalog.get(it.name, glFetch);
            const parsed = p && p.name ? p : G.pluginFromJson({ name: it.name });
            const exi = plugins.findIndex((x) => x.name === parsed.name && String(x.version) === String(parsed.version || ''));
            const any = exi >= 0 ? exi : plugins.findIndex((x) => x.name === parsed.name);
            if (any >= 0) plugins[any] = parsed; else plugins.push(parsed);
            savePlugins();
            renderRuleList();
            fillSourceSelect();
            showToast('已导入源「' + (parsed.name || it.name) + '」', 'info');
            loadCatalog();
          } catch (e2) {
            btn.disabled = false;
            btn.textContent = '重试';
            showToast('导入失败：' + e2.message, 'error');
          }
        });
        box.appendChild(row);
      }
    } catch (e) {
      box.innerHTML = '<div class="empty-state" style="padding:12px 0">在线目录获取失败：' + esc(e.message) + '（网络不通时换网络或稍后再试）</div>';
    }
  }

  // ================= 源设置 =================
  function renderGlSettings() {
    const s = (store.settings = store.settings || {});
    s.danmaku = Object.assign({ enabled: true, top: true, bottom: true, rolling: true, fontSize: 22, opacity: 0.9, speed: 1, dedupe: true }, s.danmaku || {});
    s.syncplay = Object.assign({ host: 'syncplay.pl', port: 8996, username: '', tls: true }, s.syncplay || {});
    s.download = Object.assign({ dir: '', episodeParallel: 2, segmentParallel: 3 }, s.download || {});
    s.credentials = Object.assign({ appId: '', appKey: '' }, s.credentials || {});
    store.shields = store.shields || [];

    const set = (id, v) => { $(id).value = v == null ? '' : v; };
    const chk = (id, v) => { $(id).checked = !!v; };
    chk('gl-dan-enabled', s.danmaku.enabled);
    chk('gl-dan-rolling', s.danmaku.rolling);
    chk('gl-dan-top', s.danmaku.top);
    chk('gl-dan-bottom', s.danmaku.bottom);
    chk('gl-dan-dedupe', s.danmaku.dedupe);
    set('gl-dan-size', s.danmaku.fontSize);
    set('gl-dan-opacity', s.danmaku.opacity);
    set('gl-sp-host', s.syncplay.host);
    set('gl-sp-port', s.syncplay.port);
    set('gl-sp-user', s.syncplay.username);
    chk('gl-sp-tls', s.syncplay.tls);
    set('gl-dl-ep', s.download.episodeParallel);
    set('gl-dl-seg', s.download.segmentParallel);
    set('gl-cred-id', s.credentials.appId);
    set('gl-cred-key', s.credentials.appKey);
    $('gl-shields').value = (store.shields || []).join('\n');
    renderDownloadDir();
  }

  function saveGlSettings() {
    const s = store.settings || {};
    s.danmaku = {
      enabled: $('gl-dan-enabled').checked,
      rolling: $('gl-dan-rolling').checked,
      top: $('gl-dan-top').checked,
      bottom: $('gl-dan-bottom').checked,
      dedupe: $('gl-dan-dedupe').checked,
      fontSize: Number($('gl-dan-size').value) || 22,
      opacity: Number($('gl-dan-opacity').value) || 0.9,
      speed: 1,
    };
    s.syncplay = {
      host: $('gl-sp-host').value.trim() || 'syncplay.pl',
      port: Number($('gl-sp-port').value) || 8996,
      username: $('gl-sp-user').value.trim().slice(0, 32),
      tls: $('gl-sp-tls').checked,
    };
    s.download = Object.assign(s.download || {}, {
      episodeParallel: Number($('gl-dl-ep').value) || 2,
      segmentParallel: Number($('gl-dl-seg').value) || 3,
    });
    s.credentials = { appId: $('gl-cred-id').value.trim(), appKey: $('gl-cred-key').value.trim() };
    const shields = $('gl-shields').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 200);
    saveStore({ settings: s, shields }).then(() => showToast('源设置已保存', 'info'));
  }

  // ================= 弹幕渲染（canvas 叠在视频上） =================
  const DM = {
    items: [],
    active: false,
    raf: 0,
    cacheTimer: 0,
    lastCacheKey: '',
    dedupe: new Map(), // text → 最后出现时间（去重窗口 30s）
  };

  function dmCanvas() {
    const c = $('player-danmaku');
    if (!c) return null;
    if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
      c.width = c.clientWidth || 1280;
      c.height = c.clientHeight || 720;
    }
    return c;
  }

  // bgm 番剧 ID → 弹幕分剧 ID 解析缓存（byBgmId 请求结果，按 bgmId 记）
  const danmakuAnimeIdCache = {};

  async function fetchDanmakuList(gl) {
    const key = gl.bgmId != null ? ('bgm_' + gl.bgmId + '_' + gl.epIndex) : ('t_' + encodeURIComponent(gl.title) + '_' + gl.epIndex);
    if (DM.lastCacheKey === key && DM.items.length) return DM.items;
    if (DM.cacheTimer) return DM.items; // 正在拉
    DM.cacheTimer = setTimeout(() => { DM.cacheTimer = 0; }, 8000);
    const creds = (store.settings && store.settings.credentials) || {};
    let entries = [];
    try {
      if (gl.bgmId != null) {
        // 先换弹幕侧分剧 ID（auto-matching 约定只对弹幕自生 ID 生效），再拼 4 位补零集数
        let animeId = danmakuAnimeIdCache[String(gl.bgmId)];
        if (animeId == null) {
          const info = await G.dandan.byBgmId(gl.bgmId, glFetch, creds);
          animeId = info && info.success ? info.animeId : 0;
          danmakuAnimeIdCache[String(gl.bgmId)] = animeId;
        }
        if (animeId) entries = await G.dandan.danmaku(G.dandan.episodeId(animeId, gl.epIndex + 1), glFetch, creds);
      } else {
        const animes = await G.dandan.search(gl.title, glFetch, creds);
        const an = animes[gl.epIndex] || animes[0];
        if (an) {
          const eps = await G.dandan.episodes(an.animeId, glFetch, creds);
          const ep = (eps && eps.episodes ? eps.episodes : [])[gl.epIndex] || (eps && eps.episodes ? eps.episodes[0] : null);
          if (ep && ep.episodeId) entries = await G.dandan.danmaku(ep.episodeId, glFetch, creds);
        }
      }
    } catch (e) { entries = []; }
    DM.cacheTimer = 0;
    const shields = store.shields || [];
    const items = (Array.isArray(entries) ? entries : []).filter((it) => {
      const text = String(it.text || '');
      if (!text || text.length > 120) return false;
      if (shields.some((s) => s && text.includes(s))) return false;
      return true;
    }).map((it) => ({ text: String(it.text), time: Number(it.time) || 0, color: it.color || '', mode: it.mode || 'scroll' }));
    items.sort((a, b) => a.time - b.time);
    DM.items = items;
    DM.lastCacheKey = key;
    return items;
  }

  function startDanmakuFor(gl) {
    const s = (store.settings && store.settings.danmaku) || {};
    if (!s.enabled || !video) return;
    fetchDanmakuList(gl).then((items) => {
      if (!XVP.isOpen || !glSession || glSession !== gl) return;
      if (!items.length) return;
      DM.active = true;
      DM.dedupe.clear();
      dmLoop();
    }).catch(() => {});
  }

  function stopDanmaku() {
    DM.active = false;
    if (DM.raf) cancelAnimationFrame(DM.raf);
    DM.raf = 0;
    const c = $('player-danmaku');
    if (c && c._ctx) c._ctx.clearRect(0, 0, c.width, c.height);
  }

  function dmLoop() {
    if (!DM.active) return;
    const c = dmCanvas();
    if (c) {
      const ctx = c._ctx || (c._ctx = c.getContext('2d'));
      const s = (store.settings && store.settings.danmaku) || {};
      const fontSize = Number(s.fontSize) || 22;
      ctx.clearRect(0, 0, c.width, c.height);
      const t = video ? video.currentTime : 0;
      const paused = video ? video.paused : false;
      const speed = Number(s.speed) || 1;
      const lanes = Math.max(2, Math.floor((c.height * 0.6) / (fontSize + 10)));
      let laneTill = new Array(lanes).fill(0);
      const activeItems = DM.items.filter((it) => it.time > t - 12 && it.time < t + 6);
      for (const it of activeItems) {
        const age = t - it.time;
        if (age < 0) continue;
        if (s.dedupe) {
          const last = DM.dedupe.get(it.text) || -1e9;
          if (age - last < 30) continue;
          if (age < 1) DM.dedupe.set(it.text, age);
        }
        ctx.globalAlpha = (s.opacity != null ? Number(s.opacity) : 0.9);
        ctx.font = fontSize + 'px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = it.color && /^#[0-9a-f]{6}$/i.test(it.color) ? it.color : '#ffffff';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 2;
        const tw = ctx.measureText(it.text).width;
        if (it.mode === 'scroll' && s.rolling !== false) {
          const travel = 9 / speed;
          const x = c.width + tw - ((age / travel) * (c.width + tw + 40));
          if (x < -tw) continue;
          const lane = Math.abs(hashStr(it.text)) % lanes;
          if (age < laneTill[lane] + 1.2) continue;
          laneTill[lane] = age;
          const y = 24 + lane * (fontSize + 10);
          ctx.strokeText(it.text, x, y);
          ctx.fillText(it.text, x, y);
        } else if (it.mode === 'top' && s.top !== false) {
          if (age > 4) continue;
          const x = c.width / 2 - tw / 2;
          ctx.strokeText(it.text, x, 30 + fontSize);
          ctx.fillText(it.text, x, 30 + fontSize);
        } else if (s.bottom !== false) {
          if (age > 4) continue;
          const x = c.width / 2 - tw / 2;
          ctx.strokeText(it.text, x, c.height - 20 - fontSize);
          ctx.fillText(it.text, x, c.height - 20 - fontSize);
        }
      }
      ctx.globalAlpha = 1;
      if (!paused && DM.active) DM.raf = requestAnimationFrame(dmLoop);
      else if (DM.active) { // 暂停时也保持一帧重绘（等待恢复）
        DM.raf = requestAnimationFrame(dmLoop);
      }
    }
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // ================= 一起看 =================
  function videoRef() { return video; } // 主窗叠层形态才有本地视频

  function spToggle() {
    if (spSession) { spStop(); return; }
    const s = (store.settings && store.settings.syncplay) || {};
    if (!glSession) { showToast('先播放一个作品再开启一起看', 'info'); return; }
    const room = glSession.bgmId != null ? String(glSession.bgmId) : encodeURIComponent(glSession.title).slice(0, 24);
    api.ganluSyncplayConnect({
      host: s.host || 'syncplay.pl',
      port: Number(s.port) || 8996,
      username: (s.username || 'LG' + Math.floor(Math.random() * 1e4)).slice(0, 32),
      room,
      tls: s.tls !== false,
    }).then((r) => {
      if (!r || !r.id) return;
      spSession = { id: r.id, room };
      showSpChat(true);
      showToast('已进入一起看房间「' + room + '」', 'info');
      spTick = setInterval(() => {
        const v = videoRef();
        if (v && !v.paused && isFinite(v.currentTime)) {
          api.ganluSyncplayState({ id: spSession.id, position: v.currentTime, paused: false }).catch(() => {});
        }
      }, 3000);
      const btn = $('pc-syncplay');
      if (btn) btn.classList.add('on');
    }).catch((e) => showToast('一起看连接失败：' + e.message, 'error'));
  }

  function spStop() {
    if (!spSession) return;
    api.ganluSyncplayClose({ id: spSession.id }).catch(() => {});
    spSession = null;
    clearInterval(spTick);
    spTick = 0;
    showSpChat(false);
    const btn = $('pc-syncplay');
    if (btn) btn.classList.remove('on');
  }

  function onSpEvent(p) {
    if (!spSession || !p || p.id !== spSession.id) return;
    switch (p.type) {
      case 'state': {
        const v = videoRef();
        if (v && p.adjusted != null && Math.abs(p.adjusted - v.currentTime) > 1) {
          v.currentTime = p.adjusted;
        }
        break;
      }
      case 'chat': appendSpChat(p.username || '某人', p.message || ''); break;
      case 'room-event': showToast((p.username || '?') + ' ' + p.event, 'info'); break;
      case 'joined': showToast('一起看：' + (p.username || '') + ' 加入了房间', 'info'); break;
      case 'closed': spStop(); break;
    }
  }

  function showSpChat(show) {
    let box = $('gl-sp-chat');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gl-sp-chat';
      box.className = 'gl-sp-chat';
      box.innerHTML = '<div class="gl-sp-chat-lines"></div><div class="gl-sp-chat-in"><input class="field-input" placeholder="说点什么…"><button class="action-button small">发送</button></div>';
      (layer || document.body).appendChild(box);
      box.querySelector('button').addEventListener('click', () => {
        const inp = box.querySelector('input');
        const msg = inp.value.trim();
        if (!msg || !spSession) return;
        inp.value = '';
        api.ganluSyncplayChat({ id: spSession.id, message: msg }).catch(() => {});
        appendSpChat('我', msg);
      });
    }
    box.classList.toggle('hidden', !show);
  }

  function appendSpChat(user, msg) {
    const box = $('gl-sp-chat');
    if (!box) return;
    const lines = box.querySelector('.gl-sp-chat-lines');
    const r = document.createElement('div');
    r.className = 'gl-sp-line';
    r.innerHTML = '<span class="gl-sp-user"></span> <span class="gl-sp-msg"></span>';
    r.querySelector('.gl-sp-user').textContent = user;
    r.querySelector('.gl-sp-msg').textContent = msg;
    lines.appendChild(r);
    while (lines.children.length > 80) lines.removeChild(lines.firstChild);
    lines.scrollTop = lines.scrollHeight;
  }

  // ================= 投屏 =================
  async function castToggle() {
    if (castPopEl) { castPopEl.remove(); castPopEl = null; return; }
    if (!glSession || !glSession.rawUrl) { showToast('先播放一个作品再投屏', 'info'); return; }
    const tip = document.createElement('span');
    tip.className = 'gl-tip';
    tip.textContent = '发现中…';
    document.body.appendChild(tip);
    setTimeout(() => { if (tip.parentNode) tip.remove(); }, 8000);
    let devices = [];
    try {
      const r = await api.ganluDlnaDiscover();
      devices = (r && r.devices) || [];
    } catch (e) { /* 忽略 */ }
    if (!devices.length) { tip.textContent = '没有找到投屏设备（需在同一局域网）'; setTimeout(() => tip.remove(), 3000); return; }
    const pop = document.createElement('div');
    pop.className = 'gl-cast-pop';
    pop.innerHTML = '<div class="gl-cast-title">投屏到</div>';
    for (const d of devices) {
      const b = document.createElement('button');
      b.className = 'secondary-button small';
      b.textContent = d.name || '未知设备';
      b.addEventListener('click', async () => {
        pop.remove();
        castPopEl = null;
        const r2 = await api.ganluDlnaCast({ deviceId: d.id, url: glSession.rawUrl }).catch((e) => ({ ok: false, error: e.message }));
        showToast(r2 && r2.ok ? '已投屏到「' + d.name + '」' : ('投屏失败：' + ((r2 && r2.error) || '未知')), r2 && r2.ok ? 'info' : 'error');
      });
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    castPopEl = pop;
    setTimeout(() => { if (castPopEl === pop && pop.parentNode) { pop.remove(); castPopEl = null; } }, 10000);
  }

  // ================= 播放器 ext 挂载（只在有 _gl 会话时激活） =================
  function setGlButtons(enabled) {
    for (const id of ['pc-danmaku', 'pc-syncplay', 'pc-cast']) {
      const b = $(id);
      if (b) b.hidden = !enabled;
    }
  }

  function bindPlayerExt() {
    XVP.ext.onStreamResolved = (rawUrl) => { if (glSession) glSession.rawUrl = rawUrl; };
    XVP.ext.onOpen = (ctx) => {
      const gl = ctx && ctx._gl;
      if (gl) {
        glSession = gl;
        setGlButtons(true);
        startDanmakuFor(gl);
        if (gl.resumePosMs && video) {
          const apply = () => {
            if (video.currentTime < 2 && gl.resumePosMs > 5) video.currentTime = gl.resumePosMs;
            video.removeEventListener('loadeddata', apply);
          };
          video.addEventListener('loadeddata', apply, { once: true });
        }
      } else {
        glSession = null;
        setGlButtons(false);
        stopDanmaku();
      }
    };
    XVP.ext.onClose = () => {
      if (glSession) saveHistory(glSession, video ? Math.floor(video.currentTime * 1000) : 0);
      glSession = null;
      setGlButtons(false);
      stopDanmaku();
    };
    // 定期存历史进度（播放中 10s 一次）
    setInterval(() => {
      if (glSession && XVP.isOpen && XVP.isOpen() && video && !video.paused && isFinite(video.currentTime)) {
        saveHistory(glSession, Math.floor(video.currentTime * 1000));
      }
    }, 10000);

      const bDan = $('pc-danmaku');
    if (bDan) bDan.addEventListener('click', () => {
      const s = store.settings && store.settings.danmaku;
      if (!s) return;
      s.enabled = !s.enabled;
      saveStore({ settings: store.settings });
      setChecked('gl-dan-enabled', s.enabled);
      if (s.enabled && glSession) startDanmakuFor(glSession);
      else stopDanmaku();
      bDan.classList.toggle('on', s.enabled);
    });
    const bSp = $('pc-syncplay');
    if (bSp) bSp.addEventListener('click', spToggle);
    const bC = $('pc-cast');
    if (bC) bC.addEventListener('click', castToggle);
  }

  // ================= Tab 切换与事件绑定 =================
  function switchGlTab(name) {
    document.querySelectorAll('#gl-tabs .gl-tab').forEach((b) => b.classList.toggle('active', b.dataset.gl === name));
    document.querySelectorAll('#page-ganlu .gl-view').forEach((v) => v.classList.toggle('active', v.id === 'gl-' + name));
    if (name === 'download') renderDownloadList();
    if (name === 'collect') renderCollectView();
    if (name === 'history') renderHistoryView();
    if (name === 'rules') renderRuleList();
    if (name === 'calendar') loadCalendarView();
    if (name === 'gl-settings') renderGlSettings();
  }

  function bindTabs() {
    document.querySelectorAll('#gl-tabs .gl-tab').forEach((b) => b.addEventListener('click', () => switchGlTab(b.dataset.gl)));
  }

  function bindAll() {
    bindTabs();
    $('gl-refresh').addEventListener('click', () => {
      const active = document.querySelector('#gl-tabs .gl-tab.active');
      const name = active ? active.dataset.gl : 'home';
      if (name === 'home' || name === 'calendar') loadHome();
      else if (name === 'collect') renderCollectView();
      else if (name === 'download') refreshStore().then(renderDownloadList);
      else if (name === 'history') renderHistoryView();
      else if (name === 'rules') { refreshPlugins().then(() => { renderRuleList(); fillSourceSelect(); }); }
    });

    // 搜索
    $('gl-search-btn').addEventListener('click', doSearch);
    $('gl-keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    $('gl-trace-btn').addEventListener('click', () => $('gl-trace-file').click());
    bindTrace();

    // 日历
    $('gl-cal-prev').addEventListener('click', () => { calSeasonIdx = Math.max(-9, calSeasonIdx - 1); loadCalendarView(); });
    $('gl-cal-next').addEventListener('click', () => { calSeasonIdx = Math.min(9, calSeasonIdx + 1); loadCalendarView(); });

    // 追番
    renderCollectView();

    // 历史
    renderHistoryView();

    // 下载
    $('gl-download-dir-pick').addEventListener('click', async () => {
      const dirs = await api.openDirsDialog().catch(() => []);
      if (dirs && dirs[0]) {
        store.settings = store.settings || {};
        store.settings.download = Object.assign({ dir: '', episodeParallel: 2, segmentParallel: 3 }, store.settings.download || {});
        store.settings.download.dir = dirs[0];
        saveStore({ settings: store.settings });
        renderDownloadDir();
      }
    });
    renderDownloadList();
    api.onGanluDownloadProgress(onDownloadProgress);

    // 规则
    $('gl-rule-add').addEventListener('click', () => openRuleEditor(-1));
    $('gl-rule-import').addEventListener('click', importRules);
    $('gl-rule-share').addEventListener('click', shareAll);
    $('gl-rule-catalog').addEventListener('click', loadCatalog);
    renderRuleList();

    // 源设置
    $('gl-settings-save').addEventListener('click', saveGlSettings);

    // 详情面板
    $('gl-detail-close').addEventListener('click', () => {
      curDetail = null;
      $('gl-detail').hidden = true;
    });

    // 一起看事件
    api.onGanluSyncplayEvent(onSpEvent);
    api.onGanluSyncplayConnectFailed((p) => showToast('一起看连接失败：' + (p.error || ''), 'error'));

    // 播放器钩子
    bindPlayerExt();

    fillSourceSelect();
  }

  // ================= 初始化 =================
  async function init() {
    await refreshStore();
    await refreshPlugins();
    bindAll();
    loadHome().catch(() => {});
  }

  window.XVGanlu = { init, refreshStore };
})();
