# XingyuVideo

星语视频（XingyuVideo）——影视解析 / 第三方导航 / 本地视频 桌面端。

## 来源与基线

- **代码基底**：解包自 `example/AudioVisual-1.0.9-x64.exe`（NSIS 内 `app-64.7z` → Electron 树 → `resources/app.asar`），应用代码在 `app/`。解析引擎（平台链接 + 解析接口 + iframe 注入）与 Widevine 注入链路保留。
- **UI 基底**：XingyuMusic 的 xingyu（紫金黑）主题元素 + 液态玻璃（WebGL SDF 折射 + 7 色色散 + 边缘流光 + 指针高光，vanilla 移植自 XingyuMusic-desktop LiquidGlass）。
- **第二轮（功能大改）设计参照**：Pointers-BOX（固定左导航 + 卡片流设置 + `<webview>` 多标签内嵌浏览器 + 内存会话 + 标签休眠 + 关窗藏托盘/单实例锁 + 双渠道更新）；XingyuMusic（关于页文案 + 主题 `:root` 整包变量注入/取色器机制）。

## 页面（左侧固定导航，Ctrl+1..4 切换）

| 页面 | 内容 |
|---|---|
| 解析&浏览器 | 顶行解析选项（普通解析：平台+接口+解析；第三方导航：导航站点，默认空）→ 多标签 webview（拖拽排序/关闭/休眠 0/2/5/15min 可配）→ 工具栏（后退/前进/刷新/重置会话+地址框+进度发丝线） |
| 本地 | 添加/移除视频目录（多目录），主进程递归扫描，文件列表点播；格式自动实测（`<video>.canPlayType`），不支持的灰显 |
| 我的影视 | 创建影视条目（名称/介绍/封面/自定义集数，每集选 URL 或本地文件），集数列表点播；URL 集回浏览器标签打开 |
| 设置 | 卡片流：关于 / 主题（3 内置+自定义取色×10）/ 解析接口管理 / 影视导航管理（默认空）/ 浏览器设置 / 播放器设置 / 更新检查（双渠道） |

## 播放器（精雕）

窗口内全屏叠层（默认，可切独立新窗口）：进度（缓冲段+悬停预览+拖拽）、音量/静音、倍速、A-B 循环、上一/下一集、全屏（F/双击）、快捷键（空格/K、←→5s、J/L 10s、↑↓音量、M、0-9 定位、Esc 退出）、3s 自动隐藏、**进度记忆**（按文件存 `positions.json`，重开续播）、自动续播（可关）、出错态。控制条挂液态玻璃（player 参数）。

## 主题

3 内置：xingyu 紫金黑（默认，液态玻璃开）/ 纯白 / 纯黑（玻璃关）；自定义：主色/字体色/应用背景/面板背景 取色 + 深色/玻璃开关，上限 10。机制 = XingyuMusic 的 `:root` 整包 CSS 变量即时注入；持久化 `settings.json`。

## 更新（双渠道 + 首启选择）

- 渠道：全球官方（GitHub `PointersMZX/XingyuVideo`）/ 国内镜像（Gitee `PointersMZX/XingyuVideo`），设置卡片可切；**首次启动强制弹窗选择**（`updateChannel` 空 = 未选）。
- 检查/下载均为手动 API（`releases/latest` + 流式下载 + 大小校验），安装 = 唤起 NSIS 安装器后退出（照 Pointers-BOX；Win7 构建自动挑 win7 命名资产）。
- **发布流程**：两个 Release 页各上传 NSIS 安装器（命名带 `win7` 字样区分即可），无 latest.yml 需求。

## 托盘（照 Pointers-BOX）

托盘菜单（显示窗口 / 4 页跳转 / 退出）、双击显示、**关窗 = 隐藏到托盘（防误关）**、单实例锁（第二实例聚焦现窗）。图标 = `build/tray.png`（extraResources → `resources/icons/tray.png`）。

## 构建（两个完整安装目录，NSIS 由维护者自行制作）

```
npm install          # electron 33.4.11 + electron-builder（npmmirror）
npm run build:win    # = node scripts/build-win.mjs
```

产物与体积（2026-09-26 实测，locale 已精简 zh-CN/zh-TW/en-US）：

| 目录 | Electron | 解包 | 7z -mx=9 压缩（≈NSIS single-7z 上界） |
|---|---|---|---|
| `release/win-64` | 33.4.11（Chromium 130） | 256M | **71 MB** |
| `release/win7-64` | 22.3.27（Chromium 108） | 222M | **≈65 MB** |

两个预算都 < 100MB ✓。NSIS 侧建议：`SetCompress /solid on /lzma` 可再压一档；勿删 `vk_swiftshader.dll`（液态玻璃软渲染兜底依赖）。

## 兼容性备注（Win7 版 = Electron 22 / Chromium 108）

- 新增 UI 全用具体色值，无 `color-mix`/`startViewTransition` 依赖。
- `<webview>`、Tray、`net.request` 更新下载在 e22 均可用。
- 格式实测：本机 e33 下 mp4/m4v/webm/mov/mkv/avi/flv/ts/m2ts/3gp/mpg/mpeg 全部通过 `canPlayType`（Electron ffmpeg 自带 matroska/avi/flv demuxer）；e22 实测结果以 `console.log [XVLocal] 可播放格式实测` 为准。

## 目录

```
app/                  # 打包源（main.js / index.html / player-window.html / assets/）
  assets/js/          # browser.js（多标签 webview）local.js library.js player.js
                      # settings.js themes.js renderer.js liquid-glass.js（vanilla）
                      # preload-ui.js preload-player.js preload-web.js（站点注入）
  assets/css/         # style.css（新壳+紫金黑）player.css liquid-glass.css drama-style.css
build/                # icon.ico + tray.png
scripts/build-win.mjs # 双版本构建
docs/glass-reference/ # Metric v1.4.3 GLSL 原文 6 段（重写参考）
example/              # 原始安装包（本地参考，不入 git）
release/              # 构建输出（不入 git）
```

## 验证记录（2026-09-26）

- dev（e33）：`[LiquidGlass] WebGL 叠层已启用（.titlebar / #player-controls）`、`[XVLocal] 可播放格式实测` 全绿，30s 运行无 JS 报错。
- asar 品牌残留 grep -a 零命中；`userData/` 已排除出包。
- 真机 GPU 实拍（液态玻璃观感、播放器效果）= 维护者确认项。
