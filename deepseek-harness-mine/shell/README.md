# DSH IDE 桌面端（独立的 DSH 应用）

DSH IDE 是一个**全新的独立 DSH 应用**：双击 exe → 自动启动应用自己的后端 → 直接呈现 IDE 界面。
它与 Web 开发台（`http://127.0.0.1:3080`）完全隔离：独立端口、独立数据目录、独立会话。

## 直接使用（无需构建）

| 文件 | 说明 |
|---|---|
| `release/DSH IDE 1.2.2.exe` | **便携版**：双击即用，免安装 |
| `release/DSH IDE Setup 1.2.2.exe` | **安装版**：NSIS 安装器，可创建桌面快捷方式 |

> 首次运行若出现 SmartScreen"未知发布者"提示，点 **"更多信息 → 仍要运行"**（应用未做商业签名）。

## 架构：独立实例 + 解耦配置

```
Web 开发台 (3080, <仓库根>\dev-home)        DSH IDE 应用 (3081, <仓库根>\app-home)
  开发、改进 IDE 的地方                    产品的样子：独立运行
        └────── 配置解耦，互不影响 ──────┘
```

- **独立端口** `3081`：应用自己的 DSH 后端，与开发台互不干扰
- **独立数据** `<仓库根>\app-home`：会话、存储、设置、配置各自独立（应用里的对话与开发台无关）
- **插件只有一份源码**（`<仓库根>\deepseek-harness-mine\plugin`）：两个家目录里的 `dsh-ide` 都是指向它的目录链接，改完重开天工就生效，没有"同步"这一步
- 首次启动自动初始化数据目录，无需手动操作

## 启动行为

1. 探测 `http://127.0.0.1:3081`：有服务则直连（如已开应用）；无服务则自动启动内置后端（`node --import tsx/esm apps/cli/src/bin.ts web --port 3081`，工作目录 `<仓库根>\deepseek-harness-mine\harness`），轮询就绪后加载
2. 退出应用 → 自动停掉应用启动的后端
3. 后端日志写入 `%APPDATA%\dsh-ide-desktop\backend.log`

## 菜单

顶部菜单栏已移除（界面干净）。调试/编辑快捷键在 main.js 的 `before-input-event` 中注册，行为与原菜单一致：

- **F12 / Ctrl+Shift+I**：开发者工具
- **Ctrl+R / F5**：重新加载界面
- **Ctrl+Shift+R**：重启内置后端
- **F11**：全屏切换；**Ctrl+=/-/0**：缩放
- **Ctrl+Z/Y/X/C/V/A**：撤销/重做/剪切/复制/粘贴/全选

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:3081` | 应用后端地址 |
| `DSH_DIR` | `<仓库根>\deepseek-harness-mine\harness` | DSH 源码目录（后端工作目录） |
| `DSH_LAUNCH` | `node --import tsx/esm apps/cli/src/bin.ts web` | 后端启动命令（自动追加 `--port`） |
| `DSH_HOME` | `<仓库根>\app-home` | 应用数据目录 |

## 在应用内开发（自包含开发环境）

应用内右侧 **Agent 助手** 就是完整的开发通道：向 Agent 发送需求 → Agent 修改代码/添加插件 → 应用内刷新即可使用。文件浏览、编辑、保存均在应用内完成。

## IDE 界面（应用本体）

IDE 三栏布局（文件资源管理器 / 文件详情页 / Agent 助手 + 插件面板）是 **DSH 前端正式插件**（`dsh-ide`，源码在 `<仓库根>\deepseek-harness-mine\plugin`），随后端启动自动加载，打开页面直接就是 IDE —— 不是浮层插件，无需任何手动操作。插件管理见 IDE 右侧"🧩 插件"面板。

## 开发与打包

```bash
npm install                 # 安装依赖
npm test                    # 后端管理逻辑测试
npm start                   # 开发模式启动
npm run dist                # 打包（release/ 下生成安装版 + 便携版）
```

受限环境下打包需重定向缓存目录：

```powershell
$env:LOCALAPPDATA = "$PWD\.local-appdata"
$env:ELECTRON_BUILDER_CACHE = "$PWD\.builder-cache"
npm run dist
```
