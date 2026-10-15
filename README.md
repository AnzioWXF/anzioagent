# 天工（AnzioAgent）

一个独立拥有的桌面 IDE：外形按 VSCode 的手感做，内核由 DSH 引擎直接驱动，Agent 是它原生的大脑，用来取代 VSCode 内置的 Copilot Chat。

本仓只放**天工自己的源码**：Electron 壳、IDE 插件、辅助工具脚本，以及我们对引擎所作的改动补丁。引擎源码本身不进仓（见下）。

## 仓库结构

```
deepseek-harness-mine\
  shell\    Electron 壳：窗口与启动画面、后端管理、内置更新器、内置浏览器、壳桥与幻影驱动
            home-files\ 装机模板（装配单与 AGENTS.md）
  plugin\   IDE 插件真源：lib\index.js（host 半，/dsh-ide API）、lib\client.js（client 半，自建外壳与各面板）
            static\ 前端运行时资源（Monaco / xterm）
tools\      开发台启动、装机、发包、E2E 与各种探针脚本
patches\    引擎补丁（我们对官方 checkout 的改动）
```

## 引擎：不随仓走，靠补丁重套

引擎用官方仓库的检出：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git D:\99DSH\deepseek-harness-mine\harness
cd D:\99DSH\deepseek-harness-mine\harness
git checkout d743267388641bc76f17c45ce8b4c231aed1d32c   # 0.2.1-alpha.2
git apply D:\99DSH\patches\engine-0.2.1-alpha.2-ours.patch
```

补丁里的改动是**引擎侧的必要改动**（会话与对话节点契约、`ui-settings-general` 挂主区、快捷键表、host 布局等）。改动在引擎检出里**不提交**，永远以补丁形式跟版重套：官方发新版就重新检出、重套这份补丁。

改完引擎要重建产物（官方 `build:lib:*` 脚本会被 pnpm 依赖状态检查拦住、无 TTY 直接中止，按下面五步走）：

```powershell
pnpm install --prefer-offline --ignore-scripts
tsc -b tsconfig.host.json
# 建两个空占位 lib/types/index.js、lib/types/startup.js，内容 export {}（绕开根包缺入口）
tsdown --config-loader native --env.DSH_BUILD_FACE host
# 前端面同理：tsc -b tsconfig.client.json → 同一条 tsdown 换 --env.DSH_BUILD_FACE client
```

## 跑起来

- **开发台**（Web 界面调插件）：双击 `tools\dev-web.bat`，起 3080，插件真源直接生效
- **天工应用**：装好的程序在 `D:\000AnzioAgent`，数据在家目录 `D:\99DSH\app-home`（本仓不含数据，含会话与凭证）
- **E2E**：`tools\run-e2e.ps1`，日志落 `_e2e-logs\`

改动生效方式：插件与壳改完都要**重开天工**（插件 bundle 由后端缓存在进程内）。

## 打包与装机

```powershell
# 装机 / 修复（必须现打，不带 -Build 会直接报错停住）
tools\install-app.ps1 -Build

# 发增量更新包到更新源 D:\000AnzioAgent\_updates
tools\publish-update.ps1
```

新增壳侧文件要在**三处**登记（都是硬编码文件名数组，没有自动发现）：`shell\package.json` 的 `build.files`、`tools\install-app.ps1` 的 `$shellFiles`、`tools\publish-update.ps1` 的 `$shellFiles`。

打包要设镜像，Electron 二进制的校验下载直连不通会 `fetch failed`：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

## 约定

- 脚本与壳里的路径**按 `D:\99DSH` 硬编码**（工作目录、数据目录、更新源），换机要连带改
- 界面全部走 `--dsw-*` 主题 token，不硬编码颜色
- 许可证：本项目与引擎补丁均为 MIT（引擎版权归 DeepSeek，见官方仓库 LICENSE）
