// LG Video · LiquidMotion（v1.2.0 液态动效驱动）
// 参考物 01/02 的交互层落地：
//   A. 全局指针 → --mx/--my（lerp 液体阻尼：光斑永远慢半拍、不生硬）
//   B. 卡片级光斑 → hover 目标的局部 --gx/--gy（::after 光斑跟随）
//   C. 降级保护：prefers-reduced-motion / 页面切后台暂停 / 低配机（Chromium<110）关流动层
// 纯 UI 层，零功能逻辑。
;(function initLiquidMotion() {
  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- C1. 低配机分档（06 规范 §6.2）：Chromium<110 关流动背景 ----------
  // Win7 兼容版 = Electron 22 / Chromium 108；正常版 Chromium 130+
  const chromeMajor = (parseInt((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1], 10)) || 999;
  if (chromeMajor < 110) root.classList.add('motion-lite');

  // ---------- C2. 减少动态：指针直贴（stiffness=1, damping=1 等价），不开循环 ----------
  if (reduceMotion) return;

  // ---------- A. 全局指针（液体阻尼 lerp） ----------
  // 目标值由事件写入，当前值每帧向目标平滑逼近 —— 这个差值就是「水感」
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const POINTER_LERP = 0.085; // 06 规范弹簧阻尼推荐档（丝滑微弹）

  addEventListener('pointermove', (e) => {
    pointer.tx = (e.clientX / innerWidth) * 2 - 1; // 归一化 -1 ~ 1
    pointer.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  // ---------- B. 卡片局部光斑 ----------
  // pointermove 委托：对 hover 的最近 .glass-card 写入元素局部归一化坐标（-1~1）
  let hoverCard = null;
  addEventListener('pointermove', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('.glass-card') : null;
    if (card !== hoverCard) {
      if (hoverCard) hoverCard.style.removeProperty('--gx'), hoverCard.style.removeProperty('--gy');
      hoverCard = card;
    }
    if (!hoverCard) return;
    const r = hoverCard.getBoundingClientRect();
    hoverCard.style.setProperty('--gx', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(4));
    hoverCard.style.setProperty('--gy', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(4));
  }, { passive: true });

  // ---------- 主循环（页面切后台自动暂停，省 CPU 省电） ----------
  let rafId = null;
  const loop = () => {
    pointer.x += (pointer.tx - pointer.x) * POINTER_LERP;
    pointer.y += (pointer.ty - pointer.y) * POINTER_LERP;
    root.style.setProperty('--mx', pointer.x.toFixed(4));
    root.style.setProperty('--my', pointer.y.toFixed(4));
    rafId = requestAnimationFrame(loop);
  };
  loop();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId), (rafId = null);
    } else if (!rafId) {
      loop();
    }
  });
})()
