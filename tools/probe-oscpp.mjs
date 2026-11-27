import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// probe-oscpp.mjs — 定点量"真机按一次 Ctrl+` 到底发生了什么"
// 手法：页内 keydown 记录器 + **每 100ms 轮询终端面板是否存在**，画出真实时间线；
//       对比 CDP 注入 vs 真 OS 按键（keybd_event）。
// 用法: node tools\probe-oscpp.mjs
import { spawn, spawnSync } from 'node:child_process'
const EXE = `${__TIANGONG_INSTALL}\\天工.exe`
const CDP_PORT = 9223
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PS_FIND = `Add-Type -Namespace K -Name N -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder t, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
'@
function Title([IntPtr]$h){ $sb=New-Object System.Text.StringBuilder 512; [void][K.N]::GetWindowText($h,$sb,512); return $sb.ToString() }
$p = Get-Process -Name '天工' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { 'NOAPP'; exit 1 }
$h = $p.MainWindowHandle
[void][K.N]::ShowWindow($h, 9); [void][K.N]::SetForegroundWindow($h); Start-Sleep -Milliseconds 1200
$t = Title([K.N]::GetForegroundWindow())
if ($t -notlike '*天工*') { 'SKIP:' + $t; exit 2 }
`
function osBacktick(scan) {
  const s = `${PS_FIND}
[K.N]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[K.N]::keybd_event(0xC0,${scan},0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[K.N]::keybd_event(0xC0,${scan},2,[UIntPtr]::Zero)
[K.N]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
'OK:' + $t`
  const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', s], { encoding: 'utf8' })
  return ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 160)
}

async function main() {
  const app = spawn(EXE, ['--remote-debugging-port=' + CDP_PORT], { detached: true, stdio: 'ignore' })
  app.unref()
  let target = null
  for (let i = 0; i < 90 && !target; i++) {
    await sleep(1000)
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json()
      target = (list || []).find((t) => t.type === 'page' && /3081/.test(t.url || ''))
    } catch { /* not up */ }
  }
  if (!target) throw new Error('CDP target 没出来')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })
  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)) }, 20000)
    pending.set(id, (m) => { clearTimeout(t); resolve(m.result || {}) })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
  async function evalJs(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'threw' }
    return r.result && r.result.value
  }
  async function waitFor(expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { const v = await evalJs(expr); if (v) return v; await sleep(400) } return null }

  // 100ms 轮询 5 秒，画出 .dside-term 的时间线
  async function watch(label, seconds) {
    const samples = []
    const t0 = Date.now()
    while (Date.now() - t0 < seconds * 1000) {
      const v = await evalJs(`(function(){ return { term: !!document.querySelector('.dside-term'),
        kids: document.querySelectorAll('.dside-centercol > *').length,
        head: ((document.querySelector('.dside-term-head')||{}).textContent||'').slice(0,24) } })()`)
      samples.push(`${Date.now() - t0}ms:${v && v.term ? 'T' : '.'}${v && v.kids > 1 ? '+' : ''}`)
      await sleep(100)
    }
    const log = await evalJs('window.__klog')
    console.log(`\n=== ${label} ===`)
    console.log('  面板时间线 :', samples.join(' '))
    console.log('  页面按键   :', JSON.stringify(log))
    await evalJs('window.__kclear()')
    // 复位：用页内合成事件把面板关掉（合成事件不经过 IME，一定能到我们的路由）
    for (let i = 0; i < 4; i++) {
      const open = await evalJs(`!!document.querySelector('.dside-term')`)
      if (!open) break
      await evalJs(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown',{key:'\`',code:'Backquote',ctrlKey:true,bubbles:true,cancelable:true})); return 1 })()`)
      await sleep(700)
    }
    await evalJs('window.__kclear()')
  }

  try {
    await cdp('Runtime.enable')
    const ready = await waitFor(`!!document.querySelector('.dside-explorer') && !!window.monaco`, 120000)
    console.log('IDE ready:', !!ready)
    await evalJs(`(function(){
      window.__klog = []; window.__kclear = function(){ window.__klog.length = 0 };
      if (!window.__krec) { window.__krec = true;
        window.addEventListener('keydown', function(e){
          window.__klog.push({ k: e.key, code: e.code, ctrl: e.ctrlKey, prevented: e.defaultPrevented, t: Math.round(performance.now()) });
        }, true);
      }
      return true })()`)

    // ① CDP 注入一次（基线）
    await evalJs('window.__kclear()')
    const base = { modifiers: 2, code: 'Backquote', key: '`', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 }
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base))
    await cdp('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
    await watch('① CDP 注入 Ctrl+`', 3)

    // ② 真 OS 按键 ×3：bScan=0 / bScan=0x29（带扫描码）
    const tries = [[0, 'bScan=0'], [0x29, 'bScan=0x29（带扫描码）'], [0x29, 'bScan=0x29 再来一次']]
    for (let i = 0; i < tries.length; i++) {
      await evalJs('window.__kclear()')
      const r = osBacktick(tries[i][0])
      await watch(`② 真按键 ${i + 1}：${tries[i][1]}（${r.slice(0, 20)}）`, 4)
    }
  } catch (e) {
    console.log('ERR: ' + (e && e.stack ? e.stack : e))
  } finally {
    spawnSync('taskkill', ['/IM', '天工.exe', '/T', '/F'], { stdio: 'ignore' })
    await sleep(1200)
    console.log('\n[done]')
  }
}
main().catch((e) => { console.log('PROBE ERROR: ' + e); process.exit(1) })
