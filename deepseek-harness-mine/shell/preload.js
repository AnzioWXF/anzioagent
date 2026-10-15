'use strict'
// 渲染层 ↔ 壳 的更新桥（IDE 插件通过 window.anzioUpdater 读版本/查更新/安装）
// 只有在这个壳里（Electron 窗口）才存在；浏览器里打开 3081 时 window.anzioUpdater 是 undefined，
// 插件必须自己判断存在性（开发台就是这样）。

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('anzioUpdater', {
  available: true,
  getState: () => ipcRenderer.invoke('anzio-updater:state'),
  check: () => ipcRenderer.invoke('anzio-updater:check'),
  install: () => ipcRenderer.invoke('anzio-updater:install'),
  applyAndRestart: () => ipcRenderer.invoke('anzio-updater:apply'),
  onState: (cb) => {
    const handler = (_e, state) => { try { cb(state) } catch { /* 忽略 */ } }
    ipcRenderer.on('anzio-updater:state', handler)
    return () => { try { ipcRenderer.removeListener('anzio-updater:state', handler) } catch { /* 忽略 */ } }
  },
})

// 壳能力桥（标签右键菜单用）：在文件资源管理器中显示某个文件。
// 同样只在壳里存在；浏览器里打开 3081 时插件靠特性探测隐藏该菜单项。
contextBridge.exposeInMainWorld('anzioShell', {
  available: true,
  revealInFolder: (p) => ipcRenderer.invoke('anzio-shell:reveal', String(p || '')),
  // ① 拖进编辑区的文件要拿到**本机真实路径**才能当标签打开：Electron 32 起 File.path 已被移除，
  //    官方替代是 webUtils.getPathForFile（它必须在 preload/渲染进程里拿着 File 对象调用）。
  getFilePath: (file) => {
    try { return webUtils.getPathForFile(file) || '' } catch { return '' }
  },
  // ② 天工快捷键最高优先（2026-09-22 铁律）：页面把当前键位表交上去，壳在**窗口有焦点时**
  //    注册成全局快捷键（其它应用冲突时必须让我们），触发后把键位串回调给页面。
  //    setHotkeys 传空数组 = 全部撤下来（录键时要用，否则想录的键收不到）。
  // ③ 打开文件 / 另存为（2026-09-29）：VSCode 走系统原生对话框，天工同样——平台只有 pickDirectory，
  //    选文件/保存这两件事只能由壳提供。浏览器里没有此桥，插件靠特性探测降级提示。
  pickFile: () => ipcRenderer.invoke('anzio-shell:pick-file'),
  pickSavePath: (defaultPath) => ipcRenderer.invoke('anzio-shell:pick-save', String(defaultPath || '')),
  setHotkeys: (chords) => ipcRenderer.invoke('anzio-shell:hotkeys', Array.isArray(chords) ? chords : []),
  onHotkey: (cb) => {
    const handler = (_e, chord) => { try { cb(String(chord || '')) } catch { /* 忽略 */ } }
    ipcRenderer.on('anzio-shell:hotkey', handler)
    return () => { try { ipcRenderer.removeListener('anzio-shell:hotkey', handler) } catch { /* 忽略 */ } }
  },
  // ④ 内置浏览器（2026-09-30）：页面本体是壳里的**原生视图**（WebContentsView），DOM 这层只画工具栏、
  //    上报"原生视图该占哪块矩形"。几何/显隐/导航全部必须经过这里 —— 页面永远拿不到 Electron 的能力。
  browser: {
    available: true,
    create: (id, url) => ipcRenderer.invoke('anzio-browser:create', String(id || ''), String(url || '')),
    destroy: (id) => ipcRenderer.invoke('anzio-browser:destroy', String(id || '')),
    setBounds: (id, rect) => ipcRenderer.invoke('anzio-browser:bounds', String(id || ''), rect || null),
    setVisible: (id, visible) => ipcRenderer.invoke('anzio-browser:visible', String(id || ''), !!visible),
    focus: (id) => ipcRenderer.invoke('anzio-browser:focus', String(id || '')),
    blur: () => ipcRenderer.invoke('anzio-browser:blur'),
    navigate: (id, url) => ipcRenderer.invoke('anzio-browser:navigate', String(id || ''), String(url || '')),
    action: (id, action) => ipcRenderer.invoke('anzio-browser:action', String(id || ''), String(action || '')),
    openExternal: (url) => ipcRenderer.invoke('anzio-browser:open-external', String(url || '')),
    info: (id) => ipcRenderer.invoke('anzio-browser:info', String(id || '')),
    reset: () => ipcRenderer.invoke('anzio-browser:reset'),
    // 壳 → 页面：标题/地址/加载/失败/被遮时的占位截图/新窗口请求（同一页面上所有浏览器标签共用一条事件流）
    onEvent: (cb) => {
      const handler = (_e, ev) => { try { cb(ev) } catch { /* 忽略 */ } }
      ipcRenderer.on('anzio-browser:event', handler)
      return () => { try { ipcRenderer.removeListener('anzio-browser:event', handler) } catch { /* 忽略 */ } }
    },
    // 幻影开关（第三期）：工具栏那一个开关 → **全局**生效（关掉 = 不画指针，但 Agent 的动作照做）
    setPhantom: (opts) => ipcRenderer.invoke('anzio-browser:phantom', opts || {}),
    phantomState: () => ipcRenderer.invoke('anzio-browser:phantom-state'),
    // Agent 的动作记账（第三期）：驱动层记下的按键流 → 天工页面里的「键盘映射面板」。
    // ⚠ 通道名与上面那个 `anzio-browser:action`（渲染层→壳的导航动作）**刻意不同**：同名会让人分不清方向。
    onBrowserAction: (cb) => {
      const handler = (_e, rec) => { try { cb(rec) } catch { /* 忽略 */ } }
      ipcRenderer.on('anzio-browser:agent-action', handler)
      return () => { try { ipcRenderer.removeListener('anzio-browser:action', handler) } catch { /* 忽略 */ } }
    },
    // 浏览器页面里按下的组合键（页面 preload 上报，见 browser-preload.js）→ 交给天工自己的键位路由
    onBrowserKey: (cb) => {
      const handler = (_e, payload) => { try { cb(payload) } catch { /* 忽略 */ } }
      ipcRenderer.on('anzio-browser:key', handler)
      return () => { try { ipcRenderer.removeListener('anzio-browser:key', handler) } catch { /* 忽略 */ } }
    },
  },
})
