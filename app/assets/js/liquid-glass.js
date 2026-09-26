// XingyuVideo · LiquidGlass（液态玻璃 WebGL 叠层）
// 自 XingyuMusic-desktop LiquidGlass/index.vue（Vue3 + WebGL1，零外部依赖）移植为 vanilla JS：
// - 逻辑与 Vue 版 1:1（主题变量轮询 / 背景栅格化 / 指针追踪 / SDF 折射渲染循环 / CSS 兜底切换）
// - 兜底：WebGL 不可用或着色器编译失败时 canvas 保持隐藏，liquid-glass.css 的纯 CSS 玻璃生效
// - 面板 = .titlebar（顶栏，toolbar 参数）；栅格化层 = body（舞台光背景）+ .shell（内容背景）
const GLASS_CONFIG = {
  targets: [
    { target: '.titlebar', variant: 'toolbar' },
    { target: '#player-controls', variant: 'player' },
  ],
  // 背景堆叠（自下而上）：body 底色 + 舞台光多层 background-image → .shell 内容背景（半透，压一层）
  rootSelector: '.shell',
  layerSelector: 'body',
}

;(function initLiquidGlass() {
  const shaders = window.LiquidGlassShaders || {}
  const vertexSrc = shaders.vertexSrc
  const fragmentSrc = shaders.fragmentSrc
  if (!vertexSrc || !fragmentSrc) {
    console.warn('[LiquidGlass] 缺少着色器（liquid-glass-shaders.js 未加载），保持 CSS 兜底')
    return
  }

  // variant = 'player'（底栏，招牌效果）| 'toolbar'（顶栏，轻一点）
  const VARIANT_PARAMS = {
    player: {
      radius: 14,
      refractionHeight: 40,
      refractionAmount: 10,
      depthEffect: 0.3,
      chromatic: 2.2,
      edgeFalloff: 2.4,
      sheen: 0.85,
      glow: 1.4,
      blur: 2.5,
    },
    toolbar: {
      radius: 10,
      refractionHeight: 26,
      refractionAmount: 6,
      depthEffect: 0.22,
      chromatic: 1.6,
      edgeFalloff: 2.8,
      sheen: 0.7,
      glow: 1.1,
      blur: 2,
    },
  }

  // ---------- 颜色解析（与 Vue 版一致） ----------
  const parseColor = (str, fallback = [0, 0, 0, 0]) => {
    if (!str) return fallback
    str = str.trim()
    if (str == 'transparent' || str == 'none') return [0, 0, 0, 0]
    let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(str)
    if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] == null ? 1 : Number(m[4])]
    m = /^#([0-9a-f]{8})$/i.exec(str)
    if (m) {
      const n = parseInt(m[1], 16)
      return [((n >> 24) & 255) / 255, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
    m = /^#([0-9a-f]{6})$/i.exec(str)
    if (m) {
      const n = parseInt(m[1], 16)
      return [(n >> 16) & 0xff, ((n >> 8) & 0xff), (n & 0xff), 255].map(v => v / 255)
    }
    m = /^#([0-9a-f]{3})$/i.exec(str)
    if (m) {
      const r = parseInt(m[1][0] + m[1][0], 16) / 255
      const g = parseInt(m[1][1] + m[1][1], 16) / 255
      const b = parseInt(m[1][2] + m[1][2], 16) / 255
      return [r, g, b, 1]
    }
    return fallback
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

  // 分割 CSS 多层 background 值（顶层逗号）
  const splitLayers = (s) => {
    const out = []
    let depth = 0
    let cur = ''
    for (const ch of s) {
      if (ch == '(') depth++
      else if (ch == ')') depth--
      if (ch == ',' && depth == 0) {
        out.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  const splitStops = (s) => {
    const out = []
    let depth = 0
    let cur = ''
    for (const ch of s) {
      if (ch == '(') depth++
      else if (ch == ')') depth--
      if (ch == ',' && depth == 0) {
        out.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }

  // 画一个 radial-gradient 层：'radial-gradient(1100px 700px at 18% -10%, c1, c2)'
  const paintRadial = (ctx, layer, W, H) => {
    let m = /radial-gradient\((.*)\)\s*$/s.exec(layer)
    if (!m) return
    const inner = m[1]
    let atDepth = 0
    let atIdx = -1
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch == '(') atDepth++
      else if (ch == ')') atDepth--
      else if (atDepth == 0 && ch == 'a' && inner.slice(i, i + 3) == 'at ') atIdx = i
    }
    let head = inner
    let posStr = ''
    if (atIdx > -1) {
      head = inner.slice(0, atIdx)
      posStr = inner.slice(atIdx + 3)
      atDepth = 0
      let firstComma = -1
      for (let i = posStr.length - 1; i >= 0; i--) {
        const ch = posStr[i]
        if (ch == ')') atDepth++
        else if (ch == '(') atDepth--
        else if (ch == ',' && atDepth == 0) { firstComma = i; break }
      }
      if (firstComma > -1) posStr = posStr.slice(0, firstComma)
    }
    let stopsStr = inner
    const commaAfterAt = atIdx > -1 ? inner.indexOf(',', atIdx) : inner.indexOf(',')
    if (commaAfterAt > -1) stopsStr = inner.slice(commaAfterAt + 1)

    let cx = W * 0.5
    let cy = H * 0.5
    const posTokens = posStr.trim().split(/\s+/)
    if (posTokens.length >= 2) {
      cx = /%$/.test(posTokens[posTokens.length - 2]) ? Number(posTokens[posTokens.length - 2]) / 100 * W : Number(posTokens[posTokens.length - 2])
      cy = /%$/.test(posTokens[posTokens.length - 1]) ? Number(posTokens[posTokens.length - 1]) / 100 * H : Number(posTokens[posTokens.length - 1])
    }
    const sizeTokens = head.split(/\s+/).filter(t => t.endsWith('px'))
    let rx = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 0.8
    let ry = rx
    if (sizeTokens.length >= 1) rx = Number(sizeTokens[0]) || rx
    if (sizeTokens.length >= 2) ry = Number(sizeTokens[1]) || ry
    if (rx < 1) rx = 1

    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(1, ry / rx)
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    const stops = splitStops(stopsStr)
    for (let i = 0; i < stops.length; i++) {
      const sm = /^(rgba?\([^)]*\)|#[0-9a-fA-F]+|transparent)\s*([\d.]+%?)?$/.exec(stops[i].trim())
      let offset = sm?.[2] ? Number(sm[2].replace('%', '')) / 100 : i / Math.max(stops.length - 1, 1)
      let color = sm ? sm[1] : stops[i].trim()
      if (color == 'transparent') color = 'rgba(0,0,0,0)'
      g.addColorStop(Math.min(Math.max(offset, 0), 1), color)
    }
    ctx.fillStyle = g
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2)
    ctx.restore()
  }

  // 画一个 linear-gradient 层：'linear-gradient(180deg, c1, c2)'
  const paintLinear = (ctx, layer, W, H) => {
    let m = /linear-gradient\((.*)\)\s*$/s.exec(layer)
    if (!m) return
    const inner = m[1]
    let depth = 0
    let firstComma = -1
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch == '(') depth++
      else if (ch == ')') depth--
      else if (ch == ',' && depth == 0) { firstComma = i; break }
    }
    const head = (firstComma > -1 ? inner.slice(0, firstComma) : inner).trim()
    const stopsStr = firstComma > -1 ? inner.slice(firstComma + 1) : ''
    let angleDeg = 180
    const dirM = /to\s+(right|left|top|bottom)|(-?[\d.]+)deg/.exec(head)
    if (dirM) {
      if (dirM[1] == 'right') angleDeg = 90
      else if (dirM[1] == 'left') angleDeg = 270
      else if (dirM[1] == 'top') angleDeg = 0
      else if (dirM[2] != null) angleDeg = Number(dirM[2])
    }
    const a = angleDeg * Math.PI / 180
    const dx = Math.sin(a)
    const dy = -Math.cos(a)
    const len = Math.abs(W * dx) + Math.abs(H * dy) || 1
    const x0 = W / 2 - dx * len / 2
    const y0 = H / 2 - dy * len / 2
    const g = ctx.createLinearGradient(x0, y0, x0 + dx * len, y0 + dy * len)
    const stops = splitStops(stopsStr)
    for (let i = 0; i < stops.length; i++) {
      const sm = /^(rgba?\([^)]*\)|#[0-9a-fA-F]+|transparent)\s*([\d.]+%?)?$/.exec(stops[i].trim())
      let offset = sm?.[2] ? Number(sm[2].replace('%', '')) / 100 : i / Math.max(stops.length - 1, 1)
      let color = sm ? sm[1] : stops[i].trim()
      if (color == 'transparent') color = 'rgba(0,0,0,0)'
      g.addColorStop(Math.min(Math.max(offset, 0), 1), color)
    }
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }

  // ---------- 背景栅格化（XingyuVideo DOM 映射） ----------
  // 自下而上：body（内容底色 + 舞台光多层 background-image）→ .container（内容背景，半透压一层）
  let bgCanvas = null
  let blurCanvas = null
  let bgSig = ''
  const rasterizeBackground = (cfg) => {
    const root = document.querySelector(cfg.rootSelector)
    if (!root) return false
    const W = root.clientWidth || 1280
    const H = root.clientHeight || 720
    const layerEl = document.querySelector(cfg.layerSelector)
    const layerCs = layerEl ? getComputedStyle(layerEl) : null
    const rootCs = getComputedStyle(root)
    const layerBgColor = layerCs ? layerCs.backgroundColor : 'rgba(0,0,0,0)'
    const layerBgImage = layerCs ? (layerCs.backgroundImage || 'none') : 'none'
    const rootBg = rootCs.backgroundColor
    const sig = [W, H, layerBgColor, layerBgImage, rootBg].join('|')
    if (sig == bgSig && bgCanvas) return false
    bgSig = sig
    if (!bgCanvas) bgCanvas = document.createElement('canvas')
    bgCanvas.width = W
    bgCanvas.height = H
    const ctx = bgCanvas.getContext('2d')
    ctx.clearRect(0, 0, W, H)
    // 底层：body 底色 + 舞台光渐变层
    ctx.fillStyle = layerBgColor || 'rgba(0,0,0,0)'
    ctx.fillRect(0, 0, W, H)
    if (layerBgImage != 'none' && !layerBgImage.includes('var(')) {
      for (const layer of splitLayers(layerBgImage)) {
        if (layer.startsWith('radial-gradient')) paintRadial(ctx, layer, W, H)
        else if (layer.startsWith('linear-gradient')) paintLinear(ctx, layer, W, H)
      }
    }
    // 上层：.container 内容背景（半透压一层）
    if (rootBg && rootBg != 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = rootBg
      ctx.fillRect(0, 0, W, H)
    }
    // 磨砂（frosted）副本：折射源加轻微高斯模糊，玻璃才有"磨砂折射"的实体感
    if (!blurCanvas) blurCanvas = document.createElement('canvas')
    blurCanvas.width = W
    blurCanvas.height = H
    const bctx = blurCanvas.getContext('2d')
    bctx.clearRect(0, 0, W, H)
    bctx.filter = `blur(${cfg.blur ?? 2}px)`
    bctx.drawImage(bgCanvas, 0, 0)
    bctx.filter = 'none'
    return true
  }

  // ---------- 指针 ----------
  const state = {
    pointerX: 0,
    pointerY: 0,
    smPointerX: 0,
    smPointerY: 0,
    pointerA: 0,
    smPointerA: 0,
  }
  const onPointerMove = (e) => {
    state.pointerX = e.clientX
    state.pointerY = e.clientY
  }

  // ---------- 主题变量（:root 轮询，与 Vue 版一致） ----------
  let themeVars = null
  const readThemeVars = () => {
    const cs = getComputedStyle(document.documentElement)
    const glassEnable = (cs.getPropertyValue('--liquid-glass') || '').trim()
    themeVars = {
      enabled: glassEnable !== 'false',
      edge: parseColor(cssVar('--color-glass-edge'), [0, 0, 0, 0]),
      tint: parseColor(cssVar('--color-glass-tint'), [0, 0, 0, 0]),
      base: parseColor(cssVar('--color-glass-base'), [0, 0, 0, 0]),
    }
  }

  // ---------- 渲染实例（每个 target 一个 canvas） ----------
  const createInstance = (cfg) => {
    const param = VARIANT_PARAMS[cfg.variant] || VARIANT_PARAMS.player
    const canvas = document.createElement('canvas')
    canvas.className = 'liquid-glass-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    document.body.appendChild(canvas)

    let gl = null
    let prog = null
    let uniforms = {}
    let contentTex = null
    let rafId = 0
    let lastW = 0
    let lastH = 0
    let themeTimer = 0
    let meVisible = false

    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[LiquidGlass] shader compile error:', gl.getShaderInfoLog(s))
        return null
      }
      return s
    }

    const initGL = () => {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false, depth: false, stencil: false })
      if (!gl) return false
      const vs = compile(gl.VERTEX_SHADER, vertexSrc)
      const fs = compile(gl.FRAGMENT_SHADER, fragmentSrc)
      if (!vs || !fs) return false
      prog = gl.createProgram()
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[LiquidGlass] link error:', gl.getProgramInfoLog(prog))
        return false
      }
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'a_pos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      for (const name of [
        'u_content', 'u_panelSize', 'u_panelPos', 'u_windowSize',
        'u_radius', 'u_refractionHeight', 'u_refractionAmount', 'u_depthEffect', 'u_chromatic',
        'u_edgeFalloff', 'u_edgeColor', 'u_tint', 'u_base', 'u_glowColor',
        'u_pointer', 'u_pointerA', 'u_sheen', 'u_glow', 'u_time',
      ]) {
        uniforms[name] = gl.getUniformLocation(prog, name)
      }
      contentTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, contentTex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.uniform1i(uniforms.u_content, 0)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      return true
    }

    const uploadContentTex = (changed) => {
      // 折射源用磨砂副本（blurCanvas），无则退回清晰底
      const src = blurCanvas || bgCanvas
      if (!gl || !src || !changed) return
      gl.bindTexture(gl.TEXTURE_2D, contentTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    }

    // 多个 LiquidGlass 实例共用同一开关类：引用计数（与 Vue 版一致）
    let domClassCount = 0
    const syncDomClass = (on) => {
      if (on == meVisible) return
      domClassCount += on ? 1 : -1
      meVisible = on
      if (domClassCount < 0) domClassCount = 0
      document.documentElement.classList.toggle('liquid-glass-on', domClassCount > 0)
    }

    const draw = () => {
      rafId = requestAnimationFrame(draw)
      if (!gl) return

      const target = document.querySelector(cfg.target)
      const root = document.querySelector(cfg.rootSelector)
      if (!themeVars) readThemeVars()
      if (!target || !root || !themeVars) {
        if (canvas.style.display != 'none') canvas.style.display = 'none'
        syncDomClass(false)
        return
      }

      if (!themeVars.enabled) {
        if (canvas.style.display != 'none') canvas.style.display = 'none'
        syncDomClass(false)
        return
      }

      const rect = target.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) {
        canvas.style.display = 'none'
        syncDomClass(false)
        return
      }

      if (canvas.style.display == 'none') {
        canvas.style.display = 'block'
      }
      syncDomClass(true)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssW = Math.round(rect.width)
      const cssH = Math.round(rect.height)
      if (cssW != lastW || cssH != lastH) {
        lastW = cssW
        lastH = cssH
        canvas.width = cssW * dpr
        canvas.height = cssH * dpr
        gl.viewport(0, 0, canvas.width, canvas.height)
      }
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
      canvas.style.left = Math.round(rect.left) + 'px'
      canvas.style.top = Math.round(rect.top) + 'px'

      // 背景纹理
      uploadContentTex(rasterizeBackground({ ...cfg, blur: param.blur }))

      // 指针（面板局部坐标）
      const localX = state.pointerX - rect.left
      const localY = state.pointerY - rect.top
      const inside = localX >= -40 && localX <= rect.width + 40 && localY >= -40 && localY <= rect.height + 40
      state.pointerA = inside ? 1 : 0
      state.smPointerX += (Math.min(Math.max(localX, 0), rect.width) - state.smPointerX) * 0.16
      state.smPointerY += (Math.min(Math.max(localY, 0), rect.height) - state.smPointerY) * 0.16
      state.smPointerA += (state.pointerA - state.smPointerA) * 0.1

      const t = performance.now() / 1000
      gl.useProgram(prog)
      gl.bindTexture(gl.TEXTURE_2D, contentTex)
      gl.uniform2f(uniforms.u_panelSize, rect.width, rect.height)
      gl.uniform1f(uniforms.u_radius, param.radius)
      gl.uniform2f(uniforms.u_windowSize, root.clientWidth || rect.width * 3, root.clientHeight || rect.height * 3)
      gl.uniform2f(uniforms.u_panelPos, rect.left - rootRect.left, rect.top - rootRect.top)
      gl.uniform1f(uniforms.u_refractionHeight, param.refractionHeight)
      gl.uniform1f(uniforms.u_refractionAmount, param.refractionAmount)
      gl.uniform1f(uniforms.u_depthEffect, param.depthEffect)
      gl.uniform1f(uniforms.u_chromatic, param.chromatic)
      gl.uniform1f(uniforms.u_edgeFalloff, param.edgeFalloff)
      gl.uniform4fv(uniforms.u_edgeColor, themeVars.edge)
      gl.uniform4fv(uniforms.u_tint, themeVars.tint)
      gl.uniform4fv(uniforms.u_base, themeVars.base)
      gl.uniform4fv(uniforms.u_glowColor, themeVars.edge)
      gl.uniform2f(uniforms.u_pointer, state.smPointerX, state.smPointerY)
      gl.uniform1f(uniforms.u_pointerA, state.smPointerA)
      gl.uniform1f(uniforms.u_sheen, param.sheen)
      gl.uniform1f(uniforms.u_glow, param.glow ?? 1.2)
      gl.uniform1f(uniforms.u_time, t)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    return {
      destroy() {
        cancelAnimationFrame(rafId)
        clearInterval(themeTimer)
        window.removeEventListener('mousemove', onPointerMove)
        syncDomClass(false)
        canvas.remove()
      },
      _canvas: canvas,
      init() {
        if (!initGL()) {
          // WebGL 不可用：保持 CSS 玻璃兜底（liquid-glass.css 原样）
          canvas.style.display = 'none'
          return false
        }
        state.smPointerX = 0
        state.smPointerY = 0
        themeTimer = setInterval(readThemeVars, 500)
        rafId = requestAnimationFrame(draw)
        return true
      },
    }
  }

  const start = () => {
    window.addEventListener('mousemove', onPointerMove, { passive: true })
    for (const cfg of GLASS_CONFIG.targets) {
      const inst = createInstance(cfg)
      if (inst.init()) {
        console.log(`[LiquidGlass] WebGL 叠层已启用（${cfg.target}）`)
      } else {
        console.log(`[LiquidGlass] WebGL 不可用，${cfg.target} 使用 CSS 兜底玻璃`)
      }
    }
  }

  if (document.readyState == 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
