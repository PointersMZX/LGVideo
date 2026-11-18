// glass-svg.js — 全局液态玻璃折射层（SVG 位移滤镜，全站统一：内容卡+侧栏+底栏）
// 移植自 Pointers-BOX v2.6.0 svgGlass.ts（shuding/liquid-glass，MIT，逐行同源去 TS）：
// 按元素尺寸用 Canvas2D 预计算位移贴图（圆角矩形 SDF 边缘折射场，编码进 R/G 通道），
// 经 feImage + feDisplacementMap 挂到元素的 backdrop-filter 上——扭曲的是元素背后的
// 真实页面内容。零染色：玻璃只折射/磨砂/棱线/光泽，尾串不含任何颜色调整（纯光学）。
// 兼容性：backdrop-filter: url(#svg) 仅 Chromium（Electron E33/E22 / Android WebView 均
// Chromium）；不支持时本模块不启用，元素回落各自 CSS 磨砂配方，降级链不受影响。
;(function initGlassSvg() {

  // ---------- 纯函数（与参考实现逐行同源） ----------
  function smoothStep(a, b, t) {
    const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return x * x * (3 - 2 * x);
  }

  function roundedRectSDF(x, y, w, h, r) {
    const qx = Math.abs(x) - w + r;
    const qy = Math.abs(y) - h + r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  }

  // 果冻回弹曲线（t ∈ [0,1]，带一次过冲）
  function springEase(t) {
    return 1 - Math.exp(-5 * t) * Math.cos(9 * t);
  }

  /**
   * 位移贴图：归一化坐标（半宽 0.3 / 半高 0.2 / 圆角 0.6，边缘阈值 0.15/edge）。
   * 边缘环向中心收缩采样（透镜压缩），中心区原样采样（不折射）。
   * 返回 { width, height, data(Uint8ClampedArray RGBA), maxScale(px) }
   */
  function computeDisplacementMap(w, h, edge) {
    const width = Math.max(2, Math.floor(w));
    const height = Math.max(2, Math.floor(h));
    const data = new Uint8ClampedArray(width * height * 4);
    const raw = [];
    let maxScale = 0;
    for (let i = 0; i < data.length; i += 4) {
      const x = (i / 4) % width;
      const y = Math.floor(i / 4 / width);
      const ix = x / width - 0.5;
      const iy = y / height - 0.5;
      const d = roundedRectSDF(ix, iy, 0.3, 0.2, 0.6);
      const disp = smoothStep(0.8, 0, d - 0.15 / Math.max(edge, 0.01));
      const s = smoothStep(0, 1, disp);
      const px = (ix * s + 0.5) * width;
      const py = (iy * s + 0.5) * height;
      const dx = px - x;
      const dy = py - y;
      maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy));
      raw.push(dx, dy);
    }
    maxScale *= 0.5;
    for (let i = 0, r = 0; i < data.length; i += 4, r += 2) {
      data[i] = (raw[r] / maxScale + 0.5) * 255;
      data[i + 1] = (raw[r + 1] / maxScale + 0.5) * 255;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    return { width, height, data, maxScale };
  }

  function buildBackdropValue(filterId, tail) {
    return `url(#${filterId}) blur(${tail.blur}px) saturate(${tail.saturate}%) brightness(${tail.brightness})`;
  }

  // 运行环境检测：backdrop-filter 引用 SVG 滤镜仅 Chromium 支持
  function canUseSvgFilter() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const chromium = /Chrome\/\d+/.test(ua) || /Chromium\//.test(ua);
    return chromium && typeof ResizeObserver !== 'undefined';
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  // 贴图最长边上限（大卡降采样，feImage preserveAspectRatio=none 拉回，位移场平滑无损观感）
  const MAP_MAX_SIDE = 320;
  // 按压加厚倍率（指针按住时边缘折射环临时变厚）
  const PRESS_THICKEN = 1.6;

  /**
   * 内容卡折射管理器（单例）：
   * - MutationObserver 扫新增目标；ResizeObserver 防抖重建贴图
   * - 每元素一个独立 SVG filter，inline 写目标的 backdrop 变量（覆盖 CSS 配方，
   *   移除后自动回落 → 不支持时的降级链零改动）
   * - 按压加厚：只改 feDisplacementMap scale 属性（不重建贴图），果冻回弹
   */
  class SvgGlassManager {
    constructor() {
      this.entries = new Map();
      this.mo = null;
      this.params = { ref: 1, edge: 1 };
      this.targets = [];
      this.scanTimer = null;
      this.uid = 0;
      this.running = false;
    }

    start(params, targets) {
      if (!canUseSvgFilter()) return;
      const edgeChanged = this.running && this.params.edge !== params.edge;
      const refChanged = this.running && this.params.ref !== params.ref;
      this.params = params;
      this.targets = targets;
      if (!this.running) {
        this.running = true;
        this.mo = new MutationObserver(() => this.scheduleScan());
        this.mo.observe(document.body, { childList: true, subtree: true });
      }
      this.scheduleScan();
      // 厚度变化影响贴图阈值 → 全量重建；强度变化只需重算 scale
      if (edgeChanged) {
        this.entries.forEach((e) => this.rebuild(e));
      } else if (refChanged) {
        this.entries.forEach((e) => e.feDisp.setAttribute('scale', String(e.maxScale * params.ref)));
      }
    }

    stop() {
      if (this.mo) {
        this.mo.disconnect();
        this.mo = null;
      }
      if (this.scanTimer !== null) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
      }
      Array.from(this.entries.keys()).forEach((el) => this.detach(el));
      this.running = false;
    }

    scheduleScan() {
      if (this.scanTimer !== null) return;
      this.scanTimer = window.setTimeout(() => {
        this.scanTimer = null;
        this.scan();
      }, 120);
    }

    scan() {
      if (!this.running) return;
      const sel = this.targets.map((t) => t.selector).join(',');
      document.querySelectorAll(sel).forEach((el) => {
        if (this.entries.has(el)) return;
        // 藏起来的（display:none / 尺寸塌缩）暂不接管，等显示后 resize/重扫触发
        if (el.offsetWidth < 24 || el.offsetHeight < 24) return;
        this.attach(el);
      });
      // 已离屏的元素清掉（防泄漏）
      this.entries.forEach((e, el) => {
        if (!el.isConnected) this.detach(el);
      });
    }

    attach(el) {
      const uid = ++this.uid;
      const fid = `lgv-lg-${uid}`;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
      const filter = document.createElementNS(SVG_NS, 'filter');
      filter.setAttribute('id', fid);
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('x', '0');
      filter.setAttribute('y', '0');
      filter.setAttribute('colorInterpolationFilters', 'sRGB');
      const feImage = document.createElementNS(SVG_NS, 'feImage');
      feImage.setAttribute('id', `${fid}_map`);
      feImage.setAttribute('preserveAspectRatio', 'none');
      const feDisp = document.createElementNS(SVG_NS, 'feDisplacementMap');
      feDisp.setAttribute('in', 'SourceGraphic');
      feDisp.setAttribute('in2', `${fid}_map`);
      feDisp.setAttribute('xChannelSelector', 'R');
      feDisp.setAttribute('yChannelSelector', 'G');
      filter.appendChild(feImage);
      filter.appendChild(feDisp);
      svg.appendChild(filter);
      document.body.appendChild(svg);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        svg.remove();
        return;
      }

      const entry = {
        el,
        svg,
        feDisp,
        maxScale: 0,
        ro: new ResizeObserver(() => this.scheduleResize(entry)),
        resizeTimer: null,
        pressRAF: null,
        onDown: () => {},
        onUp: () => {},
      };
      this.entries.set(el, entry);
      entry.ro.observe(el);

      this.rebuildInto(entry, canvas, ctx, feImage);
      this.applyVars(entry);
      this.bindPress(entry);
    }

    detach(el) {
      const entry = this.entries.get(el);
      if (!entry) return;
      this.entries.delete(el);
      entry.ro.disconnect();
      if (entry.resizeTimer !== null) clearTimeout(entry.resizeTimer);
      if (entry.pressRAF !== null) cancelAnimationFrame(entry.pressRAF);
      entry.svg.remove();
      el.removeEventListener('pointerdown', entry.onDown);
      el.removeEventListener('pointerup', entry.onUp);
      el.removeEventListener('pointerleave', entry.onUp);
      this.targets.forEach((t) => el.style.removeProperty(t.cssVar));
    }

    scheduleResize(entry) {
      if (entry.resizeTimer !== null) return;
      entry.resizeTimer = window.setTimeout(() => {
        entry.resizeTimer = null;
        this.rebuild(entry);
      }, 200);
    }

    rebuild(entry) {
      if (!this.entries.has(entry.el)) return;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      const feImage = entry.svg.querySelector('feImage');
      if (feImage === null) return;
      this.rebuildInto(entry, canvas, ctx, feImage);
      this.applyVars(entry);
    }

    // 生成贴图并写入 feImage/scale
    rebuildInto(entry, canvas, ctx, feImage) {
      const el = entry.el;
      const w = Math.max(2, el.offsetWidth);
      const h = Math.max(2, el.offsetHeight);
      const shrink = Math.min(1, MAP_MAX_SIDE / Math.max(w, h));
      const mw = Math.max(2, Math.round(w * shrink));
      const mh = Math.max(2, Math.round(h * shrink));
      const map = computeDisplacementMap(mw, mh, this.params.edge);
      canvas.width = mw;
      canvas.height = mh;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(map.data), mw, mh), 0, 0);
      feImage.setAttribute('width', String(w));
      feImage.setAttribute('height', String(h));
      feImage.setAttributeNS(XLINK_NS, 'href', canvas.toDataURL());
      entry.maxScale = map.maxScale;
      entry.feDisp.setAttribute('scale', String(entry.maxScale * this.params.ref));
    }

    // inline 覆盖该目标的 backdrop 配方：url 滤镜打头 + 目标磨砂尾串（零染色）
    applyVars(entry) {
      const fid = entry.svg.querySelector('filter').id;
      const target = this.targets.find((t) => entry.el.matches(t.selector));
      if (!target) return;
      entry.el.style.setProperty(target.cssVar, buildBackdropValue(fid, target.tail));
    }

    // 按压加厚 + 果冻回弹（只动 scale 属性；reduced-motion 直接跳变）
    bindPress(entry) {
      const el = entry.el;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const base = () => entry.maxScale * this.params.ref;
      const down = () => {
        if (entry.pressRAF !== null) cancelAnimationFrame(entry.pressRAF);
        const from = Number(entry.feDisp.getAttribute('scale') || base());
        if (reduced) {
          entry.feDisp.setAttribute('scale', String(base() * PRESS_THICKEN));
          return;
        }
        this.animateScale(entry, from, base() * PRESS_THICKEN, 110, (t) => t);
      };
      const up = () => {
        if (entry.pressRAF !== null) cancelAnimationFrame(entry.pressRAF);
        const from = Number(entry.feDisp.getAttribute('scale') || base());
        if (reduced) {
          entry.feDisp.setAttribute('scale', String(base()));
          return;
        }
        this.animateScale(entry, from, base(), 460, springEase);
      };
      entry.onDown = down;
      entry.onUp = up;
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointerleave', up);
    }

    animateScale(entry, from, to, durMs, ease) {
      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / durMs);
        const v = from + (to - from) * ease(t);
        entry.feDisp.setAttribute('scale', String(v));
        if (t < 1) {
          entry.pressRAF = requestAnimationFrame(tick);
        } else {
          entry.pressRAF = null;
        }
      };
      entry.pressRAF = requestAnimationFrame(tick);
    }
  }

  const manager = new SvgGlassManager();

  /**
   * 总开关。targets: [{ selector, tail:{blur,saturate,brightness}, cssVar }]
   * enabled=false 或 ref=0 时清场回落 CSS 磨砂。
   */
  window.LGVGlass = {
    setSvgGlass(enabled, params, targets) {
      if (enabled && params && params.ref > 0) {
        manager.start(params, targets);
      } else {
        manager.stop();
      }
    },
    // 页面切换等 class 级变化不触发 MutationObserver：切页后手动重扫接管新可见目标
    rescan() {
      if (manager.running) manager.scheduleScan();
    },
    springEase,
  };
})();
