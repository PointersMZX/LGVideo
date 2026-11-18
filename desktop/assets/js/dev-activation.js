// dev-activation.js — 开发者模式两步激活（对齐 Pointers-BOX v2.6.0 DevActivationModal）
// 第 1 步：8 字口令；第 2 步：随机填空「X 代表哪一位？」（故意不做选择题，避免送答案）。
// 每次打开重置并重新出题，进入第 2 步时再抽一次题。验证通过 resolve(true)。
;(function initDevActivation() {

  const DEV_ACTIVATION_CODE = '罗曹甘李王胡周戴';

  // 八个字 → 对应的八位成员（随机题选项）
  const DEV_ROLES = [
    { char: '罗', label: '罗以澄' },
    { char: '曹', label: '曹芷荧' },
    { char: '甘', label: '甘晞彤' },
    { char: '李', label: '李文馨' },
    { char: '王', label: '王雨欣' },
    { char: '胡', label: '胡清瑶' },
    { char: '周', label: '周紫蕊' },
    { char: '戴', label: '戴千珺' },
  ];

  const $ = (id) => document.getElementById(id);
  let active = null; // { resolve, step, expectedLabel }

  function openDevActivation() {
    return new Promise((resolve) => {
      active = { resolve, step: 1, expectedLabel: '' };
      $('dev-step-input').value = '';
      $('dev-step-error').hidden = true;
      $('dev-step-input').placeholder = '输入 8 字激活口令';
      $('dev-steps').textContent = '第 1 / 2 步';
      $('dev-step-tip').textContent = '请输入 8 字激活口令。';
      $('dev-activation-modal').style.display = 'flex';
      setTimeout(() => $('dev-step-input').focus(), 60);
    });
  }

  function close(result) {
    $('dev-activation-modal').style.display = 'none';
    const r = active;
    active = null;
    if (r && r.resolve) r.resolve(!!result);
  }

  function setError(msg) {
    const el = $('dev-step-error');
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function goNext() {
    if (!active) return;
    const value = $('dev-step-input').value.trim();
    if (active.step === 1) {
      if (value !== DEV_ACTIVATION_CODE) {
        setError('激活密码不正确');
        return;
      }
      active.passwordOk = true;
      // 进入第 2 步：重新随机抽题
      const r = DEV_ROLES[Math.floor(Math.random() * DEV_ROLES.length)];
      active.expectedLabel = r.label;
      active.step = 2;
      $('dev-steps').textContent = '第 2 / 2 步';
      $('dev-step-tip').textContent = `「${r.char}」代表哪一位？请输入完整姓名。`;
      $('dev-step-input').value = '';
      $('dev-step-input').placeholder = '输入完整姓名';
      setError('');
      setTimeout(() => $('dev-step-input').focus(), 60);
      return;
    }
    // 第 2 步：口令与答案须同时正确
    if (!active.passwordOk || value !== active.expectedLabel) {
      setError('答案不正确');
      return;
    }
    close(true);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const input = $('dev-step-input');
    $('dev-step-next').addEventListener('click', goNext);
    $('dev-step-cancel').addEventListener('click', () => close(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goNext();
    });
    // 非强制弹窗：点遮罩取消（未激活）
    $('dev-activation-modal').addEventListener('click', (e) => {
      if (e.target === $('dev-activation-modal')) close(false);
    });
  });

  window.XVDevActivation = { openDevActivation };
})();
