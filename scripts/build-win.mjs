// 双版本打包脚本：win-64（Electron 33，Win10/11）+ win7-64（Electron 22，Win7 兼容）
// 基底 = 解包自 AudioVisual 1.0.9 的 app/ 目录（预打包 bundle，无需 renderer 构建步骤）
// 两个完整安装目录直接输出到 release/（win-64 / win7-64），NSIS 安装程序由维护者自行制作
// 用法：node scripts/build-win.mjs
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  statSync,
  readFileSync,
  writeFileSync,
  readdirSync
} from 'node:fs'
import { join } from 'node:path'

const base = process.cwd()
const tmpBase = join(base, '.build-tmp')
const releaseDir = join(base, 'release')
const PKG = join(base, 'package.json')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: base, stdio: 'pipe', encoding: 'utf-8', shell: true })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  return r.status === 0
}

function rmDir(d) {
  if (existsSync(d)) {
    try { rmSync(d, { recursive: true, force: true }) } catch (e) { console.warn(`[warn] 无法删除 ${d}: ${e.message}`) }
  }
}

function copyTree(src, dst) {
  cpSync(src, dst, { recursive: true })
}

const origPkg = readFileSync(PKG, 'utf-8')

function buildVersion(electronVersion, outName) {
  console.log(`\n=== 构建 ${outName}（Electron ${electronVersion}）===`)
  const pkg = JSON.parse(origPkg)
  pkg.devDependencies.electron = electronVersion
  writeFileSync(PKG, JSON.stringify(pkg, null, 2))
  try {
    if (!run('npm', ['install', '--no-audit', '--no-fund'])) return false
    const outPath = join(tmpBase, outName)
    rmDir(outPath)
    if (!run('npx', ['electron-builder', '--dir', '--x64', `-c.directories.output=${outPath}`])) return false
    const exe = join(outPath, 'win-unpacked', 'LGVideo.exe')
    if (!existsSync(exe)) {
      console.error(`未找到 ${exe}`)
      return false
    }
    console.log(`${outName}: ${statSync(exe).size} bytes`)
    return true
  } finally {
    // 恢复 package.json 与依赖
    writeFileSync(PKG, origPkg)
    run('npm', ['install', '--no-audit', '--no-fund'])
  }
}

const E_MODERN = '33.4.11'  // AudioVisual 原版 Electron 33（Chromium 130）
const E_WIN7 = '22.3.27'    // 最后一条支持 Win7 的 Electron 线（node 16.17）

const ok64 = buildVersion(E_MODERN, 'win-64')
const okWin7 = ok64 ? buildVersion(E_WIN7, 'win7-64') : false

if (!ok64 || !okWin7) {
  console.error('\n构建失败')
  process.exit(1)
}

// 双目录输出到 release/（用户自行制作 NSIS 安装程序）
console.log('\n=== 输出到 release/ ===')
rmDir(join(releaseDir, 'win-64'))
rmDir(join(releaseDir, 'win7-64'))
mkdirSync(releaseDir, { recursive: true })
copyTree(join(tmpBase, 'win-64', 'win-unpacked'), join(releaseDir, 'win-64'))
copyTree(join(tmpBase, 'win7-64', 'win-unpacked'), join(releaseDir, 'win7-64'))
rmDir(tmpBase)

// 体积压缩：locale 精简（与 NSIS 打包脚本的 locales 精简保持一致；
// en-US 是 Chromium 必需回退，zh-CN/zh-TW 为中文界面）
const KEEP_LOCALES = ['zh-CN', 'zh-TW', 'en-US']
for (const outName of ['win-64', 'win7-64']) {
  const localesDir = join(releaseDir, outName, 'locales')
  for (const f of readdirSync(localesDir)) {
    const name = f.replace(/\.pak$/, '')
    if (!KEEP_LOCALES.includes(name)) rmSync(join(localesDir, f))
  }
  console.log(`${outName}: locales 精简为 ${KEEP_LOCALES.join('/')}（${readdirSync(localesDir).length} 个）`)
}

// 体积压缩：dxcompiler/dxil 裁剪（仅当 Electron 发行版携带时；swiftshader 兜底保留）
for (const outName of ['win-64', 'win7-64']) {
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    const p = join(releaseDir, outName, f)
    if (existsSync(p)) {
      const size = statSync(p).size
      rmSync(p)
      console.log(`${outName}: 删除 ${f}（${Math.round(size / 1048576)}MB）`)
    }
  }
}

const e33 = statSync(join(releaseDir, 'win-64', 'LGVideo.exe'))
const e22 = statSync(join(releaseDir, 'win7-64', 'LGVideo.exe'))
console.log(`\nwin-64（Electron ${E_MODERN}）: ${e33.size} bytes → release/win-64/`)
console.log(`win7-64（Electron ${E_WIN7}）: ${e22.size} bytes → release/win7-64/`)
console.log('全部完成')
