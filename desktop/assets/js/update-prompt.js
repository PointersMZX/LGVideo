// update-prompt.js — 全局更新提示弹窗（对齐 Pointers-BOX v2.6.0 UpdatePrompt 形态）
// 启动 5s 自动检测（autoCheckUpdate 开关，默认关；失败静默；防重入）
// + 设置页手动检查共用同一弹窗。强制更新 = versionDistance(latest, current) >= 2
// （主版本不同=3，否则 minor+patch 逐级累加），强制版无遮罩逃逸、
// 「暂不更新」替换为「开发者测试」（两步激活后跳过）。
;(function initUpdatePrompt() {

  const AUTO_CHECK_DELAY_MS = 5000;
  const FORCE_DISTANCE = 2;

  const $ = (id) => document.getElementById(id);
  let state = { result: null, forced: false };
  let started = false;

  // 语义化版本距离（照 Pointers-BOX semver.versionDistance）
  function parseVersion(raw) {
    const v = String(raw || '').replace(/^v/i, '').replace(/[+~-].*$/, '');
    const out = [0, 0, 0];
    v.split('.').slice(0, 3).forEach((p, i) => {
      const n = parseInt(String(p).replace(/\D.*$/, ''), 10);
      if (!isNaN(n)) out[i] = n;
    });
    return out;
  }

  function versionDistance(latest, current) {
    const l = parseVersion(latest);
    const c = parseVersion(current);
    if (l[0] !== c[0]) return 3;
    return Math.max(0, l[1] - c[1]) + Math.max(0, l[2] - c[2]);
  }

  function isPlatformAndroid() {
    return document.documentElement.classList.contains('platform-android');
  }

  function openModal(result, forced) {
    state = { result, forced };
    const latest = String(result.latest || '').replace(/^v/i, '');
    const current = String(result.current || '').replace(/^v/i, '');
    $('update-prompt-text').textContent = `最新版本 v${latest}（当前 v${current}）${result.notes ? '，更新内容：' + String(result.notes).slice(0, 160) : ''}`;
    $('update-forced-badge').hidden = !forced;
    $('update-forced-tip').hidden = !forced;
    $('update-skip-btn').hidden = forced;
    $('update-devtest-btn').hidden = !forced;
    $('update-prompt-modal').style.display = 'flex';
  }

  function close() {
    $('update-prompt-modal').style.display = 'none';
  }

  async function runCheck() {
    try {
      const r = await window.voidAPI.checkForUpdates();
      // 桌面 checkForUpdates 直接返回结果；Android 返回 null 且经 update-event 推送
      if (r && r.hasUpdate && r.latest) {
        const d = versionDistance(r.latest, r.current);
        openModal(r, d >= FORCE_DISTANCE);
      }
      return r || null;
    } catch (e) {
      return null; // 失败静默
    }
  }

  function applyUpdate() {
    close();
    try {
      window.voidAPI.downloadUpdate();
    } catch (e) {}
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('update-apply-btn').addEventListener('click', applyUpdate);
    $('update-skip-btn').addEventListener('click', close);
    $('update-devtest-btn').addEventListener('click', async () => {
      const ok = await window.XVDevActivation.openDevActivation();
      if (ok) {
        close();
        showToast('开发者测试已跳过本次更新', 'success');
      }
    });
    // 非强制：点遮罩关闭
    $('update-prompt-modal').addEventListener('click', (e) => {
      if (e.target === $('update-prompt-modal') && !state.forced) close();
    });

    // Android：检测结果经 update-event 推送（无返回值），监听转弹窗
    if (isPlatformAndroid() && window.voidAPI.onUpdateEvent) {
      window.voidAPI.onUpdateEvent((p) => {
        if (p && p.type === 'result' && p.hasUpdate && p.latest) {
          const d = versionDistance(p.latest, p.current);
          openModal(p, d >= FORCE_DISTANCE);
        }
      });
    }
  });

  window.XVUpdatePrompt = {
    // 自动检测（renderer.js 启动后调用；autoCheckUpdate 开、防重入）
    autoCheck(settings) {
      if (started) return;
      started = true;
      if (!settings || !settings.autoCheckUpdate) return;
      setTimeout(() => { runCheck(); }, AUTO_CHECK_DELAY_MS);
    },
    // 手动检查（设置页共用；返回检查结果供设置区展示）
    manualCheck: runCheck,
  };
})();
