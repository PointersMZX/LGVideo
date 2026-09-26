# XingyuVideo

星语视频（XingyuVideo）——影视解析/播放桌面端。

## 来源与基线

- **代码基底**：解包自 `example/AudioVisual-1.0.9-x64.exe`（NSIS 安装包内 `app-64.7z` → Electron 树 → `resources/app.asar`），应用代码原样保留在 `app/`（原 asar 根布局：`package.json` + `main.js` + `index.html` + `assets/` + `node_modules/`），**功能零改动**。
- **UI 基底**：XingyuMusic 的 xingyu（紫金黑）主题元素 + 液态玻璃（WebGL SDF 折射 + 7 色色散 + 边缘流光 + 指针高光，自 XingyuMusic-desktop LiquidGlass 组件整拷为 vanilla JS）。

## 目录

```
app/                  # 打包源（electron-builder files: app/**）
  main.js             # 主进程（frameless 主窗 + BrowserView 池 + Widevine 注入）
  index.html          # UI 外壳（sidebar + top-bar + 设置页）
  assets/js/          # renderer.js / preload-ui.js / preload-web.js / toastify
  assets/js/liquid-glass.js        # ★ 液态玻璃 WebGL 叠层（vanilla 移植，自 XingyuMusic LiquidGlass）
  assets/js/liquid-glass-shaders.js# ★ GLSL（vertex/fragment，Metric 移植版）
  assets/css/liquid-glass.css      # ★ CSS 兜底玻璃（WebGL 不可用时生效）
  assets/css/style.css            # UI 配色（xingyu 紫金黑色板 + 玻璃主题键）
  node_modules/       # 随包携带的纯 JS 依赖（electron-updater 等，无 native 模块）
resources/app-update.yml          # 自动更新源（GitHub: PointersMZX/XingyuVideo，发布 Release 后生效）
build/icon.ico        # XingyuVideo 图标（exe 注入）
scripts/build-win.mjs # 双版本构建
docs/glass-reference/ # Metric v1.4.3 抽出的 6 段 GLSL 原文（重写/移植参考）
example/              # 原始安装包（本地参考，不入 git）
release/              # 构建输出（win-64 / win7-64 完整安装目录，不入 git）
```

## 液态玻璃（重点）

- 组件读 `:root` 的 `--liquid-glass`（开关键）与 `--color-glass-edge / --color-glass-tint / --color-glass-base`（玻璃三色）；值来自 XingyuMusic xingyu 主题。
- 折射源 = 舞台光背景（`--stage-background`，body 的三层 radial 渐变，紫金黑原值）经 CPU 栅格化 + 高斯磨砂副本上传为纹理。
- 挂层：`.top-bar`（顶栏，toolbar 参数）；侧边导航按 XingyuMusic 规范不做磨砂（清晰面板 + 金色发丝边）。
- 主进程已加 `--enable-unsafe-swiftshader`：无硬件 GPU 时 SoftGPU 兜底。
- WebGL 编译失败/不可用时自动回落 `liquid-glass.css` 纯 CSS 玻璃（backdrop-filter 磨砂 + 玻璃三色）。

## 构建（两个完整安装目录，NSIS 由维护者自行制作）

```
npm install          # 拉 electron 33.4.11 + electron-builder（走 npmmirror）
npm run build:win    # = node scripts/build-win.mjs
```

产物：

| 目录 | Electron | 场景 |
|---|---|---|
| `release/win-64` | 33.4.11（Chromium 130，与原版一致） | Win10/11 |
| `release/win7-64` | 22.3.27（最后支持 Win7 的线，node 16.17） | Win7 兼容 |

构建时自动做 locale 精简（保留 zh-CN/zh-TW/en-US）。

## 开发运行

```
npm run dev          # electron app
```

验证前请先杀掉所有旧的 electron/XingyuVideo 进程（单实例/窗口抢占陷阱）。

## 已知边界

- **Win7 版**：主进程 Node API 面 = electron-updater 6.6.2（纯 JS，node16 兼容已审计）；`document.startViewTransition`（Chrome 111+）在 Win7 版 Chromium 108 下不可用，renderer.js 已有 `if (!document.startViewTransition)` 兜底分支；CSS `color-mix()`（Chromium 111+）在 Win7 版上相关声明被忽略（按钮 hover 不变色，不影响功能）。
- **Widevine**：主进程从本机 Chrome 目录读 Widevine CDM 注入；Win7 版（Chromium 108）若本机装的是新版 Chrome，新版 CDM 可能不兼容 e22，DRM 站点降级。
- **自动更新**：`resources/app-update.yml` 指向 `PointersMZX/XingyuVideo`；该仓库有 Release 之前点「检查更新」会报"已是最新版本/错误"（不弹自动更新，不影响使用）。
- **免责声明与 GitHub 链接**：index.html 侧栏保留原 AudioVisual 开源免责声明与仓库链接（归属原作者），是否替换为 XingyuVideo 自有信息待维护者定夺。
- **真机 GPU 实拍**：液态玻璃折射/色散视觉效果需在有硬件 GPU 的 Windows 上确认（headless 环境无 WebGL，只能验证 shader 编译与 CSS 兜底路径）。
