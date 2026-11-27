# 天工 · Tiangong

> **An IDE that owns its agent.** VSCode-style ergonomics, driven natively by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The agent is not a panel bolted onto an editor — it is the reason this editor exists. MIT licensed, Windows.

一个自己完全拥有的桌面 IDE：外形按 VSCode 的手感做，内核由 DSH 引擎直接驱动，**Agent 是它原生的大脑**，而不是挂在编辑器旁边的一个插件。

<sub>当前版本 1.5.57，个人自用阶段。</sub>

---

## 这是什么

打开就是一个三栏工作面，后端自动在本地起好：

```
┌──────────┬─────────────────────────┬────────────────┐
│          │  编辑器（多标签）         │                │
│  文件树   │                         │   Agent 对话    │
│          ├─────────────────────────┤                │
│          │  终端（多标签，各一条 PTY）│                │
└──────────┴─────────────────────────┴────────────────┘
```

左边是你翻文件的地方，中间是你亲手改代码和跑命令的地方，右边是 Agent。**两边都能干活，不是"人看、机器做"。**

## 为什么自己做

现有工具里，Agent 要么是编辑器的一个插件，要么是编辑器外面的一层壳。前者的能力边界、提示词、工具面、会话数据都不在你手里；后者的编辑体验是二等的。

我要的是第三种：**编辑器的地基由我掌控，Agent 作为它的核心器官存在。** 所以这个项目不 fork VSCode，也不做"网页套个窗口"——外壳自己写，引擎直接用官方的。

## 跟官方 DeepSeek Harness 桌面版有什么不同

（据 2026-11-06 的官方桌面版界面）

官方桌面版是一张**会话工作台**：新会话、插件、自动化、工作区列表，中间一个输入框。它替你改文件，但没给你一个能手动干活的工作面——没有文件树、没有编辑器、没有终端。

天工反过来：**工作面是主，Agent 在旁边。** 你随时可以手动接管，Agent 也能在你手上的同一个工作区里动手。同一个引擎，两种用法。

## 现在能做什么

- **文件树 + 编辑器**：Monaco，多标签，按次授权的保存（工作区外的文件也能存）
- **集成终端**：多标签，每个标签一条独立 PTY，关面板不杀进程
- **Agent 对话**：右侧常驻，工具卡、提问卡都在原位
- **能力面板**：插件 / 技能 / MCP 三块，可停用、可编辑；MCP 改装配单后约 2 秒热生效
- **内置浏览器**：壳里真的有一个 Chromium 视图，Agent 能导航、点击、输入、取页面；登录态跨重启保留
- **SSH 终端**：连远程，Agent 能在真终端里执行
- **设置页 / 命令面板 / 快捷键**：快捷键在窗口有焦点时才注册，失焦立刻注销——所以它永远抢得过别的软件
- **内置更新器**：只发变化的文件，重启后自应用

## 它刻意不做什么

不带遥测、不带官方赞踩反馈、不带欢迎页、不带任何账号登录、不内置 Copilot Chat、不做顶部菜单栏、不做 Git 集成、不带 minimap。

这些不是"还没做"，是**永不打算做**。判断标准只有一条：它服务的是"像 VSCode 的地基"还是"这个 Agent"？两者都不服务的，不做。

模型凭证只放在你自己机器的本地配置里，走你自己配的 provider。

## 怎么跑

前置：Windows x64、Node.js（引擎要求 `^22.19.0 || >=24.0.0`）、pnpm 11。

clone 下来只有源码和一份引擎原样快照，**没有构建产物**，所以第一次要先重建引擎：

```powershell
# 1. 快照 → 应用要跑的那棵
Copy-Item -Recurse deepseek-harness-origin deepseek-harness-mine\harness
cd deepseek-harness-mine\harness

# 2. 让它自己当 git 根并提交一次。这两件事都不能省：
#    没有 .git 的话 git apply 会被外层仓库接走、把补丁全部静默跳过；
#    没有提交的话后面的 desktop bundle 读不到提交哈希，直接报错。
git init
git add -A
git commit -m "官方快照 dsh-v0.2.1-alpha.2"

# 3. 套我们对引擎的补丁
git apply ..\..\patches\engine-0.2.1-alpha.2-ours.patch

# 4. 装依赖 + 重建产物（官方 build 脚本会被 pnpm 依赖检查拦住，按下面一步步走）
pnpm install --prefer-offline --ignore-scripts
pnpm exec tsc -b tsconfig.host.json
#   建两个空占位 lib/types/index.js、lib/types/startup.js，内容都是 export {}
pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE host
pnpm --filter @deepseek-ai/dsh-desktop run bundle
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE client
#   网页界面的静态资源是独立一份，不跑这句浏览器打开就是 404
pnpm --filter @deepseek-ai/dsh-web-frontend run build
```

在上面这个目录直接起一个后端看效果（家目录随便给个空目录，端口别和已装的天工冲突）：

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-home-try"
node apps\cli\lib\bin.js web --port 3099 --no-open
# 终端会打印带 token 的地址，浏览器打开即是界面（当前是引擎原装界面，不含天工的 IDE 外壳）
```

然后打包装机（首次要下载 Electron 二进制，直连不通就设镜像，见 [DEVELOPING.md](DEVELOPING.md)）：

```powershell
cd ..\shell
pnpm install
cd ..\..\tools
pwsh -File install-app.ps1 -Build
```

装完双击 `天工.exe` 就是三栏工作面。默认装在 `%LOCALAPPDATA%\Programs\Tiangong`，换位置用 `-InstallDir` 或环境变量 `TIANGONG_INSTALL_DIR`。

**所有脚本的路径都从自己的位置推导**（`tools\_paths.ps1`）：clone 到哪个盘、哪个目录都不用改。安装目录是唯一推导不出来的东西，所以留了上面那两级覆盖。

只想在浏览器里先看一眼界面、不打包：`pwsh -File tools\dev-web.ps1` → `http://127.0.0.1:3080`。那是开发台（引擎原装界面、插件停用），细节在 [DEVELOPING.md](DEVELOPING.md)。

## 技术

| | |
|---|---|
| 外壳 | Electron 43，Windows x64（自建，不是 VSCode fork） |
| 引擎 | DeepSeek Harness（MIT），以"官方原样快照 + 我们的补丁"方式接入 |
| 编辑器 | Monaco |
| 终端 | xterm.js + 独立 PTY |
| 图标 | Tabler Icons（MIT，许可随仓） |

对引擎的改动不止是"加东西"——对话流的节点与分支、输入区、审批面板、快捷键表、设置页的挂载位置、技能可见性、网页搜索计费，都在引擎包里动过（48 个文件）。全部收在一份补丁里，快照永远保持官方原样——跟版时能一条条重放。

## 许可

本仓 MIT，版权 2026 温献丰，见 [LICENSE](LICENSE)。

`deepseek-harness-origin/` 是 DeepSeek 官方引擎的原样快照，版权归 DeepSeek，同为 MIT，其 `LICENSE` 随树携带。第三方依赖各自的许可随仓（如 `shell/assets/licenses/`）。
