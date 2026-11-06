# 开发备忘

> 这份是给"要动手改它的人"看的：东西在哪、改完怎么生效、怎么打包。
> 想先知道它是什么、为什么存在，看 [README.md](README.md)。

本仓放两样东西：**天工自己的源码**（Electron 壳、IDE 插件、辅助工具脚本），以及**一份官方引擎的原样快照** + 我们对引擎所作的改动补丁。两者分开摆：快照永远保持官方原样，我们的改动永远是独立补丁（见下）。

## 仓库结构

```
deepseek-harness-origin\  官方引擎原样快照（dsh-v0.2.1-alpha.2 的提交内容，见下节）
deepseek-harness-mine\
  shell\    Electron 壳：窗口与启动画面、后端管理、内置更新器、内置浏览器、壳桥与幻影驱动
            home-files\ 装机模板（装配单与 AGENTS.md）
  plugin\   IDE 插件真源：lib\index.js（host 半，/dsh-ide API）、lib\client.js（client 半，自建外壳与各面板）
            static\ 前端运行时资源（Monaco / xterm）
tools\      开发台启动、装机、发包、E2E 与各种探针脚本
patches\    引擎补丁（我们对官方 checkout 的改动）
```

## 引擎：原样快照进仓，改动只走补丁

`deepseek-harness-origin\` 是官方引擎的**原样快照**，来源写死在这里，别再猜：

| 项 | 值 |
|---|---|
| 官方仓 | `https://github.com/deepseek-ai/deepseek-harness.git` |
| 版本 | tag `dsh-v0.2.1-alpha.2` |
| 提交 | `d743267388641bc76f17c45ce8b4c231aed1d32c`（2026-10-09） |
| 来历 | 2026-10-12 从官方仓 `git clone` 的干净检出（当时的 reflog 只有一条 clone 记录，工作树 0 改动）；**2026-10-21 拆掉它的 `.git` 后进仓**，好让"本地只留两个引擎目录"这条规矩成立 |
| 规模 | 14,988 个文件 / 约 121 MB（不含 `.git`、不含依赖与构建产物） |
| 一致性 | 与官方该提交逐文件一致：文件名、内容 blob 哈希、符号链接与可执行位全同（进仓时用 `git ls-files -s` 与官方清单逐行对比，0 差异） |

快照里**没有**：`.git`（官方历史 282 MB 压缩 / 306 MB 工作副本，不进仓）、`node_modules`、`lib/`、`*.tsbuildinfo` 等构建产物。这些都在 `.gitignore` 里挡着，将来在快照目录里装依赖、重建产物也不会污染仓库。

**这个目录从今往后当只读的官方原件用**：别在里面装依赖、别在里面改代码 —— 它一改，跟官方比对和跟版重套就都没了基准。

应用实际跑的是 `D:\99DSH\deepseek-harness-mine\harness`，它 = **这份快照 + 我们的补丁**（补丁改动不提交，永久留在工作区）。

**换机 / 重建顺序**：

```powershell
# 1. 把仓里的快照变成应用要跑的那棵
Copy-Item -Recurse D:\99DSH\deepseek-harness-origin D:\99DSH\deepseek-harness-mine\harness
# 2. 套补丁（补丁里的改动：会话与对话节点契约、ui-settings-general 挂主区、快捷键表、host 布局、审批四按钮等）
cd D:\99DSH\deepseek-harness-mine\harness
git apply D:\99DSH\patches\engine-0.2.1-alpha.2-ours.patch
# 3. 装依赖 + 重建产物（见下）
```

想改成"官方 git 仓 + 补丁"的老办法也行：clone 官方、checkout 同一个提交、套同一份补丁 —— 快照就是为"官方仓不可达 / 该提交被删"这种情况留的底，两种做法拿到的树一样。

**跟版**：官方发新版 → 临时 clone 一份官方（或直接用官方仓），checkout 新提交，用它整棵替换 `deepseek-harness-origin\`，把补丁里的改动重放成 `patches\engine-<新版本>-ours.patch`。补丁永远只在最外层，别把改动写进快照里（写进去以后就分不清哪些是官方的、哪些是我们的）。

**许可**：引擎版权归 DeepSeek，MIT，`deepseek-harness-origin\LICENSE` 随树带；`patches\` 里的改动同为 MIT。

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
- 许可证：本项目与引擎补丁均为 MIT（见 [LICENSE](LICENSE)；引擎版权归 DeepSeek，见官方仓库 LICENSE）
- `.gitignore` 是白名单（`/*` 全忽略、逐个放开）：**根目录新增文件必须同步加白名单**，否则 add 会被静默挡掉
