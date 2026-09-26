// local.js — 本地视频页（目录管理 + 递归扫描 + 列表播放）
;(function initLocal() {

  const $ = (id) => document.getElementById(id);
  const dirList = $('local-dir-list');
  const fileList = $('local-file-list');
  const addBtn = $('local-add-dir');
  const rescanBtn = $('local-rescan');

  // 扩展名 → MIME（canPlayType 探测用；未知一律按「暂不支持」灰显，不塞 ffmpeg）
  const EXT_MIME = {
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t',
    '3gp': 'video/3gpp',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
  };

  let supportedExts = new Set();
  let dirs = [];
  let files = [];
  let settingsRef = null;

  // 启动时实测 <video> 支持度（自动适配，结果决定灰显名单）
  function probeSupport() {
    const v = document.createElement('video');
    for (const ext of Object.keys(EXT_MIME)) {
      const probe = v.canPlayType(EXT_MIME[ext]);
      if (probe !== 'no') supportedExts.add(ext);
    }
    console.log('[XVLocal] 可播放格式实测:', [...supportedExts].join(', ') || '（无）');
  }

  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function renderDirs() {
    dirList.innerHTML = '';
    if (!dirs.length) {
      dirList.innerHTML = '<div class="empty-state" style="flex:none;padding:8px 0">未添加视频目录，点右上角「添加目录」开始</div>';
      return;
    }
    for (const d of dirs) {
      const row = document.createElement('div');
      row.className = 'local-dir-item';
      const name = document.createElement('span');
      name.className = 'dir-name';
      name.textContent = d;
      name.title = d;
      const del = document.createElement('button');
      del.className = 'dir-remove';
      del.textContent = '×';
      del.title = '移除目录';
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dirs = dirs.filter(x => x !== d);
        await window.voidAPI.setSettings({ localDirs: dirs });
        rescan();
      });
      row.appendChild(name);
      row.appendChild(del);
      dirList.appendChild(row);
    }
  }

  function renderFiles() {
    fileList.innerHTML = '';
    if (!files.length) {
      fileList.innerHTML = dirs.length
        ? '<div class="empty-state">目录中未发现视频文件</div>'
        : '';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of files) {
      const supported = supportedExts.has(f.ext);
      const row = document.createElement('div');
      row.className = 'local-file-row' + (supported ? '' : ' unsupported');
      row.dataset.path = f.path;

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = f.name;

      const badge = document.createElement('span');
      badge.className = 'file-badge';
      badge.textContent = supported ? f.ext : f.ext + '·暂不支持';

      const size = document.createElement('span');
      size.className = 'meta';
      size.textContent = fmtSize(f.size);

      const mtime = document.createElement('span');
      mtime.className = 'meta';
      mtime.textContent = fmtTime(f.mtime);

      const hint = document.createElement('span');
      hint.className = 'file-play-hint';
      hint.textContent = supported ? '▶ 播放' : '';

      row.appendChild(name);
      row.appendChild(badge);
      row.appendChild(size);
      row.appendChild(hint);
      row.insertBefore(mtime, hint);

      row.addEventListener('click', () => {
        if (!supported) {
          showToast('该格式暂不支持：' + f.ext.toUpperCase(), 'error');
          return;
        }
        const ctx = {
          file: f.path,
          title: f.name,
          list: files.map(x => x.path),
          index: files.indexOf(f),
          episodes: null,
        };
        if (settingsRef && settingsRef.player.mode === 'window') {
          window.voidAPI.openPlayerWindow(ctx);
        } else {
          window.XVPlayer.open(ctx);
        }
      });
      frag.appendChild(row);
    }
    fileList.appendChild(frag);
  }

  async function rescan() {
    renderDirs();
    if (!dirs.length) { files = []; renderFiles(); return; }
    files = await window.voidAPI.scanDirs(dirs);
    renderFiles();
  }

  window.XVLocal = {
    async init(settings) {
      settingsRef = settings;
      probeSupport();
      dirs = settings.localDirs || [];
      addBtn.addEventListener('click', async () => {
        const picked = await window.voidAPI.openDirsDialog();
        if (!picked.length) return;
        dirs = [...new Set([...dirs, ...picked])];
        await window.voidAPI.setSettings({ localDirs: dirs });
        await rescan();
      });
      rescanBtn.addEventListener('click', rescan);
      rescan();
    },
    refresh(settings) {
      settingsRef = settings;
      dirs = settings.localDirs || [];
      rescan();
    },
  };
})()
