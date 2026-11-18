// 生成 android/app/src/main/res 的启动图标与开屏图：
// - mipmap-{mdpi..xxxhdpi}/ic_launcher{,_round}.png ← 512 源图缩放
// - mipmap-*/ic_launcher_foreground.png ← 自适应前景（图标缩至安全区内，居中透明底）
// - drawable*/splash.png（11 个尺寸变体）← 深→黑对角渐变底 + 居中品牌图标
// - values/ic_launcher_background.xml 背景色改深色（Capacitor 默认白底）
// 用法：node scripts/gen-android-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resizeBilinear } from './iconlib.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resDir = join(root, 'android', 'app', 'src', 'main', 'res')
const srcIcon = decodePng(readFileSync(join(root, 'build', 'icon.png')))

// ── mipmap 同步 ──────────────────────────────────────────────
const MIPMAP_SIZES = [
  { density: 'mdpi', size: 48 },
  { density: 'hdpi', size: 72 },
  { density: 'xhdpi', size: 96 },
  { density: 'xxhdpi', size: 144 },
  { density: 'xxxhdpi', size: 192 },
]

for (const { density, size } of MIPMAP_SIZES) {
  const dir = join(resDir, `mipmap-${density}`)
  mkdirSync(dir, { recursive: true })
  const iconSized = resizeBilinear(srcIcon, size, size); const launcher = encodePng(size, size, iconSized.rgba)
  writeFileSync(join(dir, 'ic_launcher.png'), launcher)
  writeFileSync(join(dir, 'ic_launcher_round.png'), launcher)
  // 自适应前景：安全区约 66/108，图标缩至 62% 居中于透明画布
  const fg = size
  const inner = Math.round(fg * 0.62)
  const icon = resizeBilinear(srcIcon, inner, inner)
  const canvas = Buffer.alloc(fg * fg * 4)
  const ox = Math.round((fg - inner) / 2)
  const oy = Math.round((fg - inner) / 2)
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const si = (y * inner + x) * 4
      const di = ((y + oy) * fg + (x + ox)) * 4
      canvas[di] = icon.rgba[si]
      canvas[di + 1] = icon.rgba[si + 1]
      canvas[di + 2] = icon.rgba[si + 2]
      canvas[di + 3] = icon.rgba[si + 3]
    }
  }
  const fgBuf = Buffer.from(canvas); writeFileSync(join(dir, 'ic_launcher_foreground.png'), encodePng(fg, fg, fgBuf))
  console.log(`[gen-android-icons] mipmap-${density}: 3 个文件（${size}px）`)
}

// ── splash 生成 ──────────────────────────────────────────────
const SPLASH_VARIANTS = [
  { dir: 'drawable', w: 480, h: 320 },
  { dir: 'drawable-land-mdpi', w: 480, h: 320 },
  { dir: 'drawable-land-hdpi', w: 800, h: 480 },
  { dir: 'drawable-land-xhdpi', w: 1280, h: 720 },
  { dir: 'drawable-land-xxhdpi', w: 1600, h: 960 },
  { dir: 'drawable-land-xxxhdpi', w: 1920, h: 1280 },
  { dir: 'drawable-port-mdpi', w: 320, h: 480 },
  { dir: 'drawable-port-hdpi', w: 480, h: 800 },
  { dir: 'drawable-port-xhdpi', w: 720, h: 1280 },
  { dir: 'drawable-port-xxhdpi', w: 960, h: 1600 },
  { dir: 'drawable-port-xxxhdpi', w: 1280, h: 1920 },
]

// 深紫→近黑对角渐变（对应解析模式底色 #0d0716 附近），图标居中（短边 34%）
const BG_TOP = [26, 16, 42]
const BG_BOTTOM = [8, 5, 16]

function renderSplash(w, h) {
  const iconSize = Math.round(Math.min(w, h) * 0.34)
  const icon = resizeBilinear(srcIcon, iconSize, iconSize)
  const ix = Math.round((w - iconSize) / 2)
  const iy = Math.round((h - iconSize) / 2)

  const rgba = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1) + y / (h - 1)) / 2
      let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t
      let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t
      let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
      if (y >= iy && y < iy + iconSize && x >= ix && x < ix + iconSize) {
        const si = ((y - iy) * iconSize + (x - ix)) * 4
        const a = icon.rgba[si + 3] / 255
        if (a > 0) {
          r = r * (1 - a) + icon.rgba[si] * a
          g = g * (1 - a) + icon.rgba[si + 1] * a
          b = b * (1 - a) + icon.rgba[si + 2] * a
        }
      }
      const i = (y * w + x) * 4
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = 255
    }
  }
  return encodePng(w, h, Buffer.from(rgba))
}

for (const { dir, w, h } of SPLASH_VARIANTS) {
  const d = join(resDir, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'splash.png'), renderSplash(w, h))
  console.log(`[gen-android-icons] ${dir}/splash.png (${w}x${h})`)
}

// ── adaptive 背景色 ──────────────────────────────────────────
writeFileSync(
  join(resDir, 'values', 'ic_launcher_background.xml'),
  `<?xml version='1.0' encoding='utf-8'?>\n<resources>\n    <color name="ic_launcher_background">#160d24</color>\n</resources>\n`,
)
console.log('[gen-android-icons] ic_launcher_background = #160d24')
