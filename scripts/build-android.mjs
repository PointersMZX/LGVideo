// Android APK 本地一键构建（universal 单件，无按架构分包——壳无原生库，WebView 为系统组件）。
// 流程：组装 android-web/ 暂存（desktop 静态前端）→ 彻底清空 assets/public 再复制
//       （cap copy 只覆盖不清空，旧产物残留会导致 index.html 与 JS 新旧混合 → 404/纯色屏）
//       → cap copy android → gradle assembleRelease（本地签名）→ 产物改名入仓库根 release/。
// 签名：密钥由本脚本从 release/keystore/lgvideo-release.keystore 拷入 android/app/
//       （release/ 整体 gitignore，仓库内不落密钥；换 key 会无法覆盖升级）。
// 环境：JAVA_HOME=D:/java/Java17 + -I mirror-init.gradle（aliyun 镜像绕网络问题，路径必须绝对）。
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopDir = join(root, 'desktop')
const webStaging = join(root, 'android-web')
const androidDir = join(root, 'android')
const assetsPublic = join(androidDir, 'app', 'src', 'main', 'assets', 'public')
const outDir = join(root, 'release')
const mirrorInit = join(androidDir, 'mirror-init.gradle')
const javaHome = process.env.JAVA_HOME_17 ?? 'D:\\java\\Java17'

function fail(msg) {
  console.error(`[build-android] ${msg}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

// 1. 组装 android-web 暂存（零构建静态前端：index.html + player-window.html + assets/）
console.log('[build-android] 组装 android-web 暂存 …')
rmSync(webStaging, { force: true, recursive: true })
mkdirSync(webStaging, { recursive: true })
for (const f of ['index.html', 'player-window.html']) {
  if (!existsSync(join(desktopDir, f))) fail(`desktop/${f} 不存在`)
  cpSync(join(desktopDir, f), join(webStaging, f))
}
cpSync(join(desktopDir, 'assets'), join(webStaging, 'assets'), { recursive: true })

// 校验 index.html 引用的 JS 全部存在（防产物不一致）
{
  const html = readFileSync(join(webStaging, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/src="(\.\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
  for (const ref of refs) {
    if (!existsSync(join(webStaging, ref))) fail(`index.html 引用的 ${ref} 不存在`)
  }
  console.log(`[build-android] 前端布局校验通过（${refs.length} 个 JS 引用全部存在）`)
}

// 2. 彻底清空 assets/public 后重建（旧产物残留是事故根因）
console.log('[build-android] 清空并重建 assets/public …')
rmSync(assetsPublic, { force: true, recursive: true })
mkdirSync(assetsPublic, { recursive: true })
cpSync(webStaging, assetsPublic, { recursive: true })

// cap copy：补 capacitor.config.json / capacitor.plugins.json / cordova 运行时
console.log('[build-android] cap copy android …')
execFileSync('npx', ['cap', 'copy', 'android'], { cwd: root, stdio: 'inherit', shell: true })

// 3. 密钥就位（release/keystore → android/app/）
const keystoreSrc = join(outDir, 'keystore', 'lgvideo-release.keystore')
if (!existsSync(keystoreSrc)) fail(`未找到正式密钥：${keystoreSrc}`)
copyFileSync(keystoreSrc, join(androidDir, 'app', 'lgvideo-release.keystore'))

// 4. local.properties 就位（SDK 路径；文件不入仓）
const localProps = join(androidDir, 'local.properties')
if (!existsSync(localProps)) {
  const sdkDir = process.env.ANDROID_SDK_DIR ?? 'D:/android/Sdk'
  if (!existsSync(sdkDir)) fail(`未找到 Android SDK：${sdkDir}（可用 ANDROID_SDK_DIR 覆盖）`)
  writeFileSync(localProps, `sdk.dir=${sdkDir.replace(/\\/g, '/')}\n`)
  console.log('[build-android] 已生成 local.properties →', sdkDir)
}

// 5. gradle assembleRelease（本地 gradle 8.13，wrapper 会下 zip 被网络环境拦；
//    gradle.bat 是 cmd 脚本须经 cmd /c 启动；-I 镜像注入路径必须绝对）
const gradleBat = process.env.GRADLE_BAT ?? 'D:\\gradle\\gradle-8.13\\bin\\gradle.bat'
if (!existsSync(gradleBat)) fail(`未找到 gradle.bat：${gradleBat}`)
console.log(`[build-android] gradle assembleRelease（${gradleBat} + aliyun 镜像）…`)
execFileSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`,
  ['/c', gradleBat, 'assembleRelease', '-I', mirrorInit, '--stacktrace'], {
    cwd: androidDir,
    env: { ...process.env, JAVA_HOME: javaHome },
    stdio: 'inherit',
  })

// 5. 产物 → 仓库根 release/（android 单件；应用名=中文「甘露影视」，文件名同）
const outputs = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release')
mkdirSync(outDir, { recursive: true })
const apk = readdirSync(outputs).filter((f) => f.endsWith('.apk') && !f.endsWith('.idsig'))[0]
if (!apk) fail(`outputs 目录无 APK：${outputs}`)
const target = join(outDir, `甘露影视_v${version}_android.apk`)
cpSync(join(outputs, apk), target)
console.log('[build-android] 完成 →', target)
