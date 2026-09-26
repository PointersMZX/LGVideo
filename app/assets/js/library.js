// library.js — 我的影视页（条目 CRUD + 集数编辑器 + 播放入口）
// 数据模型：[{ id, name, intro, cover?, episodes:[{label,type:'url'|'file',value}], createdAt }]
;(function initLibrary() {

  const $ = (id) => document.getElementById(id);
  const libList = $('lib-list');
  const libDetail = $('lib-detail');
  const libDetailInfo = $('lib-detail-info');
  const libEpisodes = $('lib-episodes');
  const editor = $('lib-editor');
  const editorTitle = $('lib-editor-title');
  const nameInput = $('lib-name');
  const introInput = $('lib-intro');
  const coverInput = $('lib-cover');
  const epCountInput = $('lib-ep-count');
  const epRows = $('lib-ep-rows');

  let items = [];
  let selectedId = null;
  let editingId = null; // null = 新建；条目 id = 编辑
  let epMetaRows = []; // 编辑器内集数行 DOM

  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderItem(item) {
    const card = document.createElement('div');
    card.className = 'lib-card' + (item.id === selectedId ? ' active' : '');
    card.dataset.id = item.id;
    const name = document.createElement('div');
    name.className = 'lib-card-name';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'lib-card-meta';
    const fileEps = item.episodes.filter(e => e.type === 'file').length;
    const urlEps = item.episodes.length - fileEps;
    meta.textContent = `${item.episodes.length} 集（本地 ${fileEps} / 链接 ${urlEps}）· 创建于 ${fmtDate(item.createdAt)}`;
    const del = document.createElement('button');
    del.className = 'lib-card-del';
    del.textContent = '✕';
    del.title = '删除条目';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await showConfirm(`确定删除「${item.name}」？\n其 ${item.episodes.length} 集记录将被移除（本地文件不删除）。`);
      if (!ok) return;
      items = items.filter(x => x.id !== item.id);
      if (selectedId === item.id) { selectedId = null; renderDetail(null); }
      await window.voidAPI.setLibrary(items);
      renderList();
    });
    card.appendChild(name);
    card.appendChild(meta);
    card.appendChild(del);
    card.addEventListener('click', () => selectItem(item.id));
    return card;
  }

  function renderList() {
    libList.innerHTML = '';
    if (!items.length) {
      libList.innerHTML = '<div class="empty-state" style="flex:none;padding:20px 0">还没有影视条目，点右上角「创建影视」开始</div>';
      renderDetail(null);
      return;
    }
    for (const it of items) libList.appendChild(renderItem(it));
  }

  function selectItem(id) {
    selectedId = id;
    renderDetail(items.find(i => i.id === id) || null);
    libList.querySelectorAll('.lib-card').forEach(c => c.classList.toggle('active', c.dataset.id === id));
  }

  function renderDetail(item) {
    libDetailInfo.innerHTML = '';
    libEpisodes.innerHTML = '';
    if (!item) {
      libDetailInfo.innerHTML = '<div class="empty-state" style="height:200px">选择一个影视条目查看集数</div>';
      return;
    }
    const box = document.createElement('div');
    if (item.cover) {
      const img = document.createElement('img');
      img.className = 'lib-cover';
      img.src = item.cover;
      img.alt = item.name;
      img.onerror = () => img.remove();
      box.appendChild(img);
    }
    const h = document.createElement('h3');
    h.textContent = item.name;
    box.appendChild(h);
    if (item.intro) {
      const p = document.createElement('p');
      p.textContent = item.intro;
      box.appendChild(p);
    }
    libDetailInfo.appendChild(box);

    item.episodes.forEach((ep, i) => {
      const row = document.createElement('div');
      row.className = 'lib-ep-row';
      const idx = document.createElement('span');
      idx.className = 'ep-idx';
      idx.textContent = String(i + 1);
      const type = document.createElement('span');
      type.className = 'ep-type';
      type.textContent = ep.type === 'file' ? '本地' : '链接';
      const name = document.createElement('span');
      name.className = 'ep-name';
      name.textContent = ep.label || (ep.type === 'file' ? ep.value.split(/[\\/]/).pop() : ep.value);
      row.appendChild(idx);
      row.appendChild(type);
      row.appendChild(name);
      row.addEventListener('click', () => playEpisode(item, i));
      libEpisodes.appendChild(row);
    });
  }

  function playEpisode(item, epIdx) {
    const ep = item.episodes[epIdx];
    if (!ep) return;
    if (ep.type === 'file') {
      const fileEps = item.episodes.filter(e => e.type === 'file');
      const ctx = {
        file: ep.value,
        title: `${item.name} · ${ep.label || ('第 ' + (epIdx + 1) + ' 集')}`,
        list: fileEps.map(e => e.value),
        index: fileEps.indexOf(ep),
        episodes: item.episodes.map((e, i2) => ({ ...e, item: item.id })),
        epIndex: epIdx,
        autoNext: true,
        nextItem: item,
      };
      const mode = (window.XVSettings && window.XVSettings.getSettings().player.mode) || 'overlay';
      if (mode === 'window') window.voidAPI.openPlayerWindow(ctx);
      else window.XVPlayer.open(ctx);
    } else {
      // URL 集数 → 浏览器页新标签打开（可被解析链路处理）
      window.BrowserX.openUrl(ep.value);
    }
  }

  // ---------- 编辑器 ----------
  function epRowMarkup(i, ep) {
    const row = document.createElement('div');
    row.className = 'lib-ep-row-edit';
    const idx = document.createElement('span');
    idx.className = 'ep-edit-idx';
    idx.textContent = '第 ' + (i + 1) + ' 集';

    const typeSel = document.createElement('select');
    typeSel.innerHTML = '<option value="url">链接</option><option value="file">本地</option>';
    typeSel.value = ep ? ep.type : 'url';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ep-edit-input';
    input.placeholder = typeSel.value === 'url' ? 'https://...' : '本地文件路径';
    input.value = ep ? ep.value : '';

    const pickBtn = document.createElement('button');
    pickBtn.className = 'ep-pick-file';
    pickBtn.textContent = '选择…';

    function syncRow() {
      const isFile = typeSel.value === 'file';
      input.placeholder = isFile ? '本地文件路径' : 'https://...';
      pickBtn.hidden = !isFile;
      input.disabled = isFile;
    }
    syncRow();
    typeSel.addEventListener('change', syncRow);
    pickBtn.addEventListener('click', async () => {
      const picked = await window.voidAPI.openFileDialog();
      if (picked.length) { input.value = picked[0]; input.dispatchEvent(new Event('change')); }
    });

    row.appendChild(idx);
    row.appendChild(typeSel);
    row.appendChild(input);
    row.appendChild(pickBtn);
    return row;
  }

  function openEditor(item) {
    editingId = item ? item.id : null;
    editorTitle.textContent = item ? `编辑「${item.name}」` : '创建影视';
    nameInput.value = item ? item.name : '';
    introInput.value = item ? (item.intro || '') : '';
    coverInput.value = item ? (item.cover || '') : '';
    epCountInput.value = item ? item.episodes.length : 1;
    epRows.innerHTML = '';
    epMetaRows = [];
    const count = Math.min(Math.max(parseInt(epCountInput.value, 10) || 1, 1), 999);
    for (let i = 0; i < count; i++) {
      epRows.appendChild(epRowMarkup(i, item ? item.episodes[i] : null));
      epMetaRows.push(epRows.lastChild);
    }
    editor.hidden = false;
  }

  function regenEpRows() {
    const count = Math.min(Math.max(parseInt(epCountInput.value, 10) || 1, 1), 999);
    epRows.innerHTML = '';
    epMetaRows = [];
    for (let i = 0; i < count; i++) {
      const row = epRowMarkup(i, null);
      epRows.appendChild(row);
      epMetaRows.push(row);
    }
  }

  function closeEditor() { editor.hidden = true; editingId = null; }

  async function saveEditor() {
    const name = nameInput.value.trim();
    if (!name) { showToast('请填写名称', 'error'); return; }
    const episodes = [];
    for (let i = 0; i < epMetaRows.length; i++) {
      const row = epMetaRows[i];
      const typeSel = row.querySelector('select');
      const input = row.querySelector('.ep-edit-input');
      const value = input.value.trim();
      if (!value) {
        showToast(`第 ${i + 1} 集缺少 ${typeSel.value === 'file' ? '本地文件' : '链接'}`, 'error');
        return;
      }
      episodes.push({ label: `第 ${i + 1} 集`, type: typeSel.value, value });
    }
    if (!episodes.length) { showToast('至少需要 1 集', 'error'); return; }
    let target;
    if (editingId) {
      target = items.find(i => i.id === editingId);
      Object.assign(target, { name, intro: introInput.value.trim(), cover: coverInput.value.trim(), episodes });
    } else {
      target = {
        id: 'item-' + Date.now(),
        name,
        intro: introInput.value.trim(),
        cover: coverInput.value.trim(),
        episodes,
        createdAt: Date.now(),
      };
      items.push(target);
    }
    await window.voidAPI.setLibrary(items);
    closeEditor();
    selectedId = target.id;
    renderList();
    showToast(editingId ? '已保存' : '已创建', 'success');
  }

  window.XVLibrary = {
    async init() {
      items = (await window.voidAPI.getLibrary()) || [];
      renderList();

      $('lib-create').addEventListener('click', () => openEditor(null));
      $('lib-editor-cancel').addEventListener('click', closeEditor);
      $('lib-editor-save').addEventListener('click', saveEditor);
      epCountInput.addEventListener('input', regenEpRows);
    },
    reload: async () => {
      items = (await window.voidAPI.getLibrary()) || [];
      renderList();
    },
  };
})()
