import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// probe-app-keys.mjs — **真机**键位验证（2026-09-21）
// 为什么要单独一套：无头浏览器 ≠ 应用。壳（Electron main.js）的 before-input-event 会在按键
// 到达页面**之前**拦掉它，浏览器里根本复现不出来 —— 用户报的 "Ctrl+A 全选无效" 就是这么来的。
// 本脚本做两件事：
//   ① CDP 注入键（会走壳的 before-input-event，用 Ctrl+R 做对照证明这条路径是活的）
//   ② **真 OS 按键**（user32 keybd_event，窗口必须先在前台；脚本每次都核对前台窗口标题，
//      不是天工就拒发，避免把按键打到用户别的窗口里）
// 用法: node tools\probe-app-keys.mjs
//   （会自动启动 <安装目录>\天工.exe --remote-debugging-port=9223，跑完关掉它）
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const EXE = `${__TIANGONG_INSTALL}\\天工.exe`
const CDP_PORT = 9223
const WS = `${__TIANGONG_ROOT}\\.smoke-ws-keys`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
function log(s) { console.log(s); out.push(s) }
function verdict(name, ok, detail) { log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`) }

const PS_HEAD = `Add-Type -Namespace K -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
'@
function Title([IntPtr]$h){ $sb=New-Object System.Text.StringBuilder 512; [void][K.N]::GetWindowText($h,$sb,512); return $sb.ToString() }
function FindApp(){ Get-Process -Name '天工' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
`
const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, a: 0x41, b: 0x42, n: 0x4E, s: 0x53, oem3: 0xC0, esc: 0x1B, r: 0x52 }

function osKey(names) {
  const downs = names.map((n) => `[K.N]::keybd_event(${VK[n]},0,0,[UIntPtr]::Zero)`).join('; ')
  const ups = names.slice().reverse().map((n) => `[K.N]::keybd_event(${VK[n]},0,2,[UIntPtr]::Zero)`).join('; ')
  const script = `${PS_HEAD}
$p = FindApp
if (-not $p) { 'NOAPP'; exit 0 }
$h = $p.MainWindowHandle
if ([K.N]::IsIconic($h)) { [void][K.N]::ShowWindow($h, 9) }
[void][K.N]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 350
$t = Title([K.N]::GetForegroundWindow())
if ($t -notlike '*天工*') { 'SKIP:' + $t; exit 0 }
${downs}
Start-Sleep -Milliseconds 80
${ups}
Start-Sleep -Milliseconds 120
'OK:' + $t`
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).trim()
}

async function main() {
  if (!existsSync(EXE)) throw new Error('找不到 ' + EXE)
  rmSync(`${__TIANGONG_ROOT}\\_probe_app_keys.log`, { force: true })
  // 起应用（带调试端口）
  const app = spawn(EXE, ['--remote-debugging-port=' + CDP_PORT], { detached: true, stdio: 'ignore' })
  app.unref()
  await sleep(1000)

  let target = null
  for (let i = 0; i < 90 && !target; i++) {
    await sleep(1000)
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      target = (list || []).find((t) => t.type === 'page' && /3081/.test(t.url || ''))
    } catch { /* not up */ }
  }
  if (!target) throw new Error('CDP target 没出来（应用没起来？）')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  ws.onclose = () => { for (const [, f] of pending) f({ error: { message: 'ws closed' } }); pending.clear() }
  function cdp(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++msgId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 20000)
      pending.set(id, (m) => { clearTimeout(timer); resolve(m.result || { error: m.error }) })
      try { ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) { clearTimeout(timer); reject(e) }
    })
  }
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval threw' }
    return r.result && r.result.value
  }
  async function waitFor(expr, ms) {
    const t = Date.now()
    while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(400) }
    return null
  }
  const VKS = { KeyA: 65, KeyN: 78, KeyR: 82, KeyB: 66, KeyP: 80, Enter: 13, Backquote: 192, Escape: 27 }
  async function cdpKey(code, keyChar, mods) {
    const base = { modifiers: mods || 0, code, key: keyChar, windowsVirtualKeyCode: VKS[code] || 0, nativeVirtualKeyCode: VKS[code] || 0 }
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
    await sleep(500)
  }

  try {
    await cdp('Runtime.enable')
    await cdp('Page.enable')
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 120000)
    verdict('A1 应用主界面就绪（IDE + monaco）', !!ready)
    if (!ready) throw new Error('IDE 没挂载')
    log('  版本标记：' + JSON.stringify(await evalJs(`(function(){ var b=document.querySelector('.dside-upd'); return b? b.textContent : '(无)' })()`)))

    // ── 对照：CDP 注入键到底走不走壳的 before-input-event？Ctrl+R 是壳注册的（preventDefault+重载）
    await evalJs('window.__kp = 1')
    await cdpKey('KeyR', 'r', 2)
    await sleep(2500)
    const survived = await evalJs('window.__kp === 1 ? 1 : 0')
    const shellPath = survived === 1
    log(`  [对照] CDP 注入 Ctrl+R 后页面${shellPath ? '没重载 → 壳确实拦到了 → CDP 注入走壳路径 ✓' : '重载了 → 壳没拦到（CDP 绕过了 before-input-event）'}`)
    if (!shellPath) {
      // 页面重载过，重新等就绪
      await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 90000)
    }

    // 准备：打开一个文件（Ctrl+A 需要 model）。
    // ⚠ 应用里当前会话的 cwd 是 D:\（整盘），客户端会不断把 active-root 覆盖回会话 cwd（§6 69），
    //   所以不折腾文件树，直接走应用自己的 **Ctrl+P 快速打开**（页面级快捷键，CDP 注入即可）：
    //   Ctrl+P → 输入文件名 → 回车 = 用真实 UI 把文件打开成标签。
    await cdpKey('KeyP', 'p', 2)
    await sleep(900)
    await cdp('Input.insertText', { text: 'a.txt' })
    await sleep(900)
    const palHit = await evalJs(`(function(){ var it=document.querySelectorAll('.dside-opt'); return it.length })()`)
    await cdpKey('Enter', 'Enter', 0)
    await sleep(2500)
    const modelOk = await waitFor(`(function(){ var e=monaco.editor.getEditors()[0]; return !!(e&&e.getModel()) })()`, 20000)
    verdict('A2 用 Ctrl+P 快速打开文件、编辑器挂上 model', !!modelOk,
      JSON.stringify({ palHit, tabs: await evalJs(`document.querySelectorAll('.dside-tab').length`) }))
    // 焦点给编辑器（点一下编辑区）
    const box = await evalJs(`(function(){ var e=document.querySelector('.dside-editor-monaco'); if(!e) return null; var r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+30)} })()`)
    if (box) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await sleep(500)
    }
    log('  注册表：Ctrl+N → ' + JSON.stringify(await evalJs(`window.__dsideKeys ? window.__dsideKeys.resolved('file.newFile') : 'no-hook'`)))

    // ── CDP 注入三轮 ─────────────────────────────────────────────────────
    await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.setSelection(new monaco.Selection(1,1,1,1)); return 1 })()`)
    await cdpKey('KeyA', 'a', 2)
    const selCdp = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; var m=e.getModel(); return { sel:m.getValueInRange(e.getSelection()).length, total:m.getValueLength() } })()`)
    verdict('A3 [CDP] Ctrl+A 编辑器全选', selCdp && selCdp.sel === selCdp.total && selCdp.total > 0, JSON.stringify(selCdp))

    await cdpKey('Backquote', '`', 2)
    const t1 = await evalJs(`!!document.querySelector('.dside-term')`)
    await cdpKey('Backquote', '`', 2)
    const t2 = await evalJs(`!document.querySelector('.dside-term')`)
    verdict('A4 [CDP] Ctrl+` 开关终端', !!t1 && !!t2, JSON.stringify({ t1, t2 }))

    await cdpKey('KeyN', 'n', 2)
    const d1kind = await waitFor(`(function(){ return document.querySelector('.dside-inline-input') ? 'inline' : (document.querySelector('.dside-dialog input') ? 'dialog' : '') })()`, 4000)
    verdict('A5 [CDP] Ctrl+N 在资源管理器里开出内联新建输入', d1kind === 'inline', String(d1kind))
    await cdpKey('Escape', 'Escape', 0)
    await sleep(400)

    // ── 真 OS 按键（user32 keybd_event）──────────────────────────────────
    log('\n  —— 真 OS 按键（窗口切前台 + 每次核对前台标题）——')
    const focus = osKey(['shift'])   // 只按一下 shift：用来把窗口切前台并核对标题（无副作用）
    log('  前台核对：' + focus)
    if (focus.startsWith('SKIP') || focus === 'NOAPP') {
      verdict('B0 真机按键阶段（前台窗口核对）', false, focus)
    } else {
      await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; e.setSelection(new monaco.Selection(1,1,1,1)); return 1 })()`)
      await sleep(300)
      const r1 = osKey(['ctrl', 'a'])
      await sleep(600)
      const selOs = await evalJs(`(function(){ var e=monaco.editor.getEditors()[0]; var m=e.getModel(); return { sel:m.getValueInRange(e.getSelection()).length, total:m.getValueLength(), domSel:String(window.getSelection().toString()).length } })()`)
      verdict('B1 [真机] Ctrl+A 编辑器全选（不是整页 DOM 全选）',
        selOs && selOs.sel === selOs.total && selOs.total > 0, JSON.stringify({ r1, selOs }))

      const r2 = osKey(['ctrl', 'oem3'])
      await sleep(1500)
      const s1 = await evalJs(`(function(){ return { term: !!document.querySelector('.dside-term'), phase: (document.querySelector('.dside-term-head .st')||{}).textContent || '', centerKids: document.querySelectorAll('.dside-centercol > *').length } })()`)
      log('    [真机] 第 1 次 Ctrl+` 之后：' + JSON.stringify(s1))
      const r3 = osKey(['ctrl', 'oem3'])
      await sleep(1500)
      const s2 = await evalJs(`(function(){ return { term: !!document.querySelector('.dside-term'), phase: (document.querySelector('.dside-term-head .st')||{}).textContent || '' } })()`)
      log('    [真机] 第 2 次 Ctrl+` 之后：' + JSON.stringify(s2))
      const r4 = osKey(['ctrl', 'oem3'])
      await sleep(1500)
      const s3 = await evalJs(`(function(){ return { term: !!document.querySelector('.dside-term'), phase: (document.querySelector('.dside-term-head .st')||{}).textContent || '' } })()`)
      log('    [真机] 第 3 次 Ctrl+` 之后：' + JSON.stringify(s3))
      const t3 = s1.term || s3.term
      const t4 = !!s1.term !== !!s2.term || !!s3.term
      verdict('B2 [真机] Ctrl+` 呼出 / 收起终端（三次按键的状态序列）',
        (s1.term && !s2.term) || (!s1.term && s2.term), JSON.stringify({ r2, r3, r4, s1, s2, s3 }))

      const rN = osKey(['ctrl', 'n'])
      await sleep(900)
      const d2 = await evalJs(`(function(){ return document.querySelector('.dside-inline-input') ? 'inline' : (document.querySelector('.dside-dialog input') ? 'dialog' : 'none') })()`)
      verdict('B3 [真机] Ctrl+N 开出内联新建输入（光标在名字上）', d2 === 'inline', JSON.stringify({ rN, d2 }))
      osKey(['esc'])
      await sleep(400)

      const r5 = osKey(['ctrl', 'b'])
      await sleep(700)
      const b1 = await evalJs(`!document.querySelector('.dside-leftpanel')`)
      await sleep(200)
      osKey(['ctrl', 'b'])
      await sleep(700)
      const b2 = await evalJs(`!!document.querySelector('.dside-leftpanel')`)
      verdict('B4 [真机] Ctrl+B 显隐侧边栏（对照组）', !!b1 && !!b2, JSON.stringify({ r5, b1, b2 }))
      // 轨迹佐证：router 命中会写 kind=shortcut 埋点（用户下次报障也靠它一眼定位）
      try {
        const logTxt = (await import('node:fs')).readFileSync(`${__TIANGONG_ROOT}\\app-home\\logs\\ide-trace.log`, 'utf8').trim().split('\n').slice(-400)
          .filter((l) => l.indexOf('"shortcut"') >= 0).slice(-8).map((l) => { try { const o = JSON.parse(l); return o.ts.slice(11, 19) + ' ' + (o.meta && o.meta.id) + '=' + (o.meta && o.meta.keys) } catch { return '' } })
        log('  轨迹里的快捷键命中记录（最近 8 条）：\n    ' + logTxt.join('\n    '))
      } catch (e) { log('  读轨迹失败：' + e.message) }
    }
  } catch (e) {
    verdict('真机探针执行完成', false, e && e.stack ? e.stack : String(e))
  } finally {
    log('\n  —— 收尾：关掉应用 ——')
    spawnSync('taskkill', ['/IM', '天工.exe', '/T', '/F'], { stdio: 'ignore' })
    await sleep(1500)
    const left = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-Process -Name '天工' -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' })
    log('  剩余天工进程：' + String(left.stdout || '').trim())
    console.log('\n===== 真机键位验证结束 =====')
  }
}
main().catch((e) => { console.log('PROBE ERROR: ' + (e && e.stack ? e.stack : e)); process.exit(1) })
