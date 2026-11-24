# MeruChat 打包指南（packaging.md）

> 本项目走「**HTML/CSS + WebView 套壳**」方向：一套静态网页（`index.html` / `js/` / `theme.css` 等，位于 `webapp/` 根目录），用 **Capacitor** 套成 Android/iOS 原生 App，用 **Electron** 套成 Windows/macOS/Linux 桌面 App。

本页只讲**怎么打包**。安装依赖/构建命令由 Lead 执行（本文件不跑）。

---

## 0. 目录与前置

```
webapp/
├─ index.html          # 静态 UI（dev-a 维护）
├─ js/ theme.css       # 静态资源（dev-a 维护）
├─ assets/             # 图标、logo
├─ package.json
├─ capacitor.config.json
├─ electron/
│  ├─ main.js
│  └─ preload.js
└─ docs/packaging.md   # 本文件
```

Node.js 要求：**Node ≥ 22**（`@capacitor/cli` 8.x 的 `engines.node` 为 `>=22.0.0`；`electron` 45.x 要求 `>=22.12`）。

### 本机工具链环境变量（Windows）
```powershell
$env:JAVA_HOME    = 'C:\Meru\website\toolchains\jdk17'
$env:ANDROID_HOME = 'C:\Meru\website\toolchains\android-sdk'
# 把 platform-tools 加入 PATH（adb 等）
$env:Path += ';C:\Meru\website\toolchains\android-sdk\platform-tools'
$env:Path += ';C:\Meru\website\toolchains\android-sdk\cmdline-tools\latest\bin'
```
> JDK 必须是 **17**（本文件假设 `toolchains\jdk17` 已就位；注意机器上原有的 `E:\java\JDK` 是 Java 8，不能用）。

---

## 1. Web 预览（最快验证 UI）

在 `webapp/` 目录下：
```powershell
python -m http.server 8911
```
然后浏览器打开 `http://localhost:8911/`。
（也可 `npm run serve` 得到同样的提示。）

---

## 2. Android APK

```powershell
cd C:\Meru\website\meruchat\webapp

# 2.1 安装依赖
npm i

# 2.2 生成 android 原生工程（首次执行一次）
npx cap add android

# 2.3 同步 webDir(".") 的静态资源到 android 工程
npx cap sync android

# 2.4 构建 Release APK（Windows 用 gradlew.bat）
cd android
.\gradlew.bat assembleRelease
```
产物：`android\app\build\outputs\apk\release\app-release.apk`

> 也可 `npm run build:android`（等价于 `cd android && gradlew.bat assembleRelease`）。
>
> 首次 Gradle 需联网拉依赖。`JAVA_HOME`/`ANDROID_HOME` 未设或指向 Java 8 会失败（见 §0）。
>
> **release 签名**：若要可分发/上架的签名 APK，需在 `android/app/build.gradle(.kts)` 配 `signingConfigs.release` + `android/key.properties`（keystore 用 JDK17 的 `keytool` 生成）。未配签名时 `assembleRelease` 会用 debug 签名，仅供内部测试。

---

## 3. iOS

**需要 macOS + Xcode + Apple 开发者账号**（本机 Windows 做不了）。
```bash
cd C:\Meru\website\meruchat\webapp   # 在 Mac 上对应路径
npm i
npx cap add ios
npx cap sync ios
npx cap open ios          # 打开 Xcode，配置签名/Provisioning Profile
# 在 Xcode：Product → Archive → Distribute App
```
> 或纯命令行 `flutter` 无关——这里是 Capacitor：`npx cap open ios` 交给 Xcode 打包 `.ipa`。

---

## 4. Windows 桌面（Electron）

```powershell
cd C:\Meru\website\meruchat\webapp
npm i
npx electron-builder --win
# 或： npm run build:win
```
产物：`dist\` 下的 NSIS 安装包（`MeruChat Setup <ver>.exe`）。
`package.json` 的 `build` 段已配：`appId=pw.ms7.meruchat`、`win.target=nsis`。

本地想先跑起来看效果：
```powershell
npx electron .
```
（`main` 指向 `electron/main.js`，`loadFile` 加载根目录 `index.html`，窗口 1200×800，`contextIsolation:true`、`nodeIntegration:false`、`webSecurity` 默认开启。）

mac/linux 同理：`npm run build:mac`（需 Mac）/ `npm run build:linux`（需 Linux 或有对应交叉工具链）。

---

## 5. 鸿蒙（OpenHarmony）— 后置，非官方

**Capacitor 无官方 OHOS 支持。** 鸿蒙需单独用 OpenHarmony 的 Web 容器（如 ArkWeb）另做一套壳，或走社区方案；与 Capacitor 工程不共用同一条 `cap add` 流程。**列为后置项**，待主线（Android/桌面）稳定后再评估。

---

## 6. 依赖版本（2026-11 查 npm 实价）

| 包 | 版本 | 用途 |
|---|---|---|
| `@capacitor/cli` | **8.6.2** | Capacitor 命令行（`cap`） |
| `@capacitor/core` | **8.6.2** | Capacitor 运行时核心 |
| `@capacitor/android` | **8.6.2** | Android 平台（peer: core ^8.6.0） |
| `@capacitor/ios` | **8.6.2** | iOS 平台（peer: core ^8.6.0） |
| `@capacitor/filesystem` | **8.1.5**（可选） | 本地文件读写，暂无代码引用 |
| `electron` | **45.4.1** | 桌面壳（engines.node >=22.12） |
| `electron-builder` | **26.18.0** | 打 NSIS/DMG/AppImage |

---

## 7. 常见问题

- **`npx cap add android` 报找不到 webDir**：确认 `capacitor.config.json` 的 `webDir` 为 `"."`，且 `index.html` 在 `webapp/` 根目录（不是子目录）。
- **Gradle 报 Java 版本错**：`JAVA_HOME` 必须是 JDK 17（§0）。
- **`adb` 找不到**：`platform-tools` 未加 PATH（§0）。
- **Electron 打包把 `android/`、`dist/` 也塞进去**：当前 `files:["**/*","!node_modules"]` 按需求配置；如需更干净可后续加 `!android`、`!dist` 排除（此项按 Lead 指定未改）。
