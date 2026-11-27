import { repoRoot as __TIANGONG_ROOT, installDir as __TIANGONG_INSTALL } from './_paths.mjs'
// DSH IDE ⑥ 第三刀 E2E（CDP 真浏览器 + 真实 Agent 两轮改动）
// 用法: $env:DSH_E2E_TOKEN='<token>'; node tools/e2e6d.mjs   （前置：3081 后端已起）
// 验的是：① 改动历史（折叠=本轮 / 展开=本次会话每一轮）② 一次审多文件（审阅队列：chips + 上一个/下一个 + 队列内撤销自动跳转）
// 自清：fixture _e2e6d_a.ts / _e2e6d_b.ts / _e2e6d_c.ts 建在当前工作空间根，结束即删（踩坑 21）
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = 9700 + Math.floor(Math.random() * 400)
const APP = 'http://127.0.0.1:3081'
const H = 'http://127.0.0.1:' + CDP_PORT
const TOKEN = process.env.DSH_E2E_TOKEN || ''
const AUTH_URL = APP + '/' + (TOKEN ? '?token=' + TOKEN : '')
const TRACE = `${__TIANGONG_ROOT}\\app-home\\logs\\ide-trace.log`

const TC = '// e2e6d fixture\nconst c: number = 1\n'
let ROOT = ''
let FA = ''
let FB = ''
let FC = ''

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' :: ' + String(detail ?? '')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const diskOf = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ]
  for (const c of cands) if (existsSync(c)) return c
  throw new Error('no edge/chrome found')
}
const userDir = join(`${__TIANGONG_ROOT}`, '.edge6d-tmp-' + process.pid)
rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
const proc = spawn(findBrowser(), [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  AUTH_URL,
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`${H}/json/list`)).json()
    target = (list || []).find((t) => t.type === 'page')
  } catch { /* not up yet */ }
}
if (!target) { console.log('CDP target not found'); proc.kill(); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect error')) })
let msgId = 0
const pending = new Map()
let wsDead = false
const consoleErrors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    consoleErrors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300))
  }
}
ws.onclose = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws closed' } }); pending.clear() }
ws.onerror = () => { wsDead = true; for (const [, fn] of pending) fn({ error: { message: 'ws error' } }); pending.clear() }

function cdp(method, params, timeoutMs) {
  if (wsDead) return Promise.reject(new Error('CDP ws dead'))
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs || 15000)
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
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await evalJs(expr)
    if (v && !v.__err) return v
    await sleep(400)
  }
  return null
}

// ── 页内取数/操作 ──────────────────────────────────────────────
const ROOT_VIA_API = `fetch('/dsh-ide/init').then(function(r){ return r.json() }).then(function(j){ return (j && j.root) ? j.root : null })`
const AGENT_TAB_READY = `!!document.querySelector('.dside-agent-input textarea')`
const CLICK_AGENT_TAB = `(function(){ var ts=document.querySelectorAll('.dside-side-tab');
  for (var i=0;i<ts.length;i++){ if (String(ts[i].textContent).indexOf('Agent')>=0){ ts[i].click(); return true; } } return false; })()`
const MODEL_TEXT = (name) => `(function(){ var ms = window.monaco.editor.getModels();
  for (var i=0;i<ms.length;i++){ if (String(ms[i].uri.path).indexOf(${JSON.stringify(name)})>=0) return ms[i].getValue(); } return null; })()`
const SEND = (text) => `(function(){ var ta=document.querySelector('.dside-agent-input textarea'); if(!ta) return 'no-textarea';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  var bs=document.querySelectorAll('.dside-agent-input button');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].className).indexOf('primary')>=0){ bs[i].click(); return 'sent'; } }
  return 'no-send'; })()`
const IDLE = `(function(){ var b=document.querySelector('.dside-agent-head .dside-badge'); return b? String(b.textContent) : ''; })()`
// 底部清单状态：头部标题 + 折叠/展开的轮次头 + 行（名字/图标/状态类）+ 历史链接
const PANEL = `(function(){
  var head=document.querySelector('.dside-changes-head'); var b=head?head.querySelector('b'):null;
  var link=head?head.querySelector('.link'):null;
  var rows=document.querySelectorAll('.dside-change'); var rl=[];
  for (var i=0;i<rows.length;i++){ var n=rows[i].querySelector('.dside-change-name');
    rl.push({ name:n?n.textContent:'', cls:String(rows[i].className), icon:(rows[i].querySelector('.dside-change-icon')||{}).textContent||'' }); }
  var rounds=document.querySelectorAll('.dside-round'); var rd=[];
  for (var j=0;j<rounds.length;j++){ rd.push({ text:String(rounds[j].textContent), cls:String(rounds[j].className) }); }
  return { head: b?b.textContent:'', tail: head?String(head.textContent):'', link: link?link.textContent:'',
    rows: rl, rounds: rd }; })()`
const CLICK_HEAD = (text) => `(function(){ var bs=document.querySelectorAll('.dside-changes-head button, .dside-changes-head .link');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].textContent).indexOf(${JSON.stringify(text)})>=0){ bs[i].click(); return true; } } return false; })()`
const CLICK_ROUND = (roundText, btnText) => `(function(){ var rs=document.querySelectorAll('.dside-round');
  for (var i=0;i<rs.length;i++){ if (String(rs[i].textContent).indexOf(${JSON.stringify(roundText)})<0) continue;
    var bs=rs[i].querySelectorAll('button');
    for (var j=0;j<bs.length;j++){ if (String(bs[j].textContent).indexOf(${JSON.stringify(btnText)})>=0){ bs[j].click(); return true; } }
    return false; }
  return 'no-round'; })()`
const CLICK_ROW = (name, label) => `(function(){ var rows=document.querySelectorAll('.dside-change');
  for (var i=0;i<rows.length;i++){ var n=rows[i].querySelector('.dside-change-name');
    if (!n || n.textContent.indexOf(${JSON.stringify(name)})<0) continue;
    var bs=rows[i].querySelectorAll('button');
    for (var j=0;j<bs.length;j++){ if (bs[j].textContent.indexOf(${JSON.stringify(label)})>=0){ bs[j].click(); return 'btn'; } }
    n.click(); return 'name'; }
  return false; })()`
const DIFF = `(function(){ var d=document.querySelector('.dside-diff'); if(!d) return null;
  var de=(window.monaco.editor.getDiffEditors?window.monaco.editor.getDiffEditors():[]); var m=de.length?de[0].getModel():null;
  var chips=document.querySelectorAll('.dside-diff-chips .dside-chip'); var cl=[];
  for (var i=0;i<chips.length;i++) cl.push({ text:String(chips[i].textContent), cls:String(chips[i].className) });
  var bs=document.querySelectorAll('.dside-diff-head button'); var bt=[];
  for (var j=0;j<bs.length;j++) bt.push(String(bs[j].textContent));
  return { head:(document.querySelector('.dside-diff-head')||{}).textContent||'', n:de.length, chips: cl, buttons: bt,
    original: m?m.original.getValue():null, modified: m?m.modified.getValue():null }; })()`
const CLICK_CHIP = (name) => `(function(){ var cs=document.querySelectorAll('.dside-diff-chips .dside-chip');
  for (var i=0;i<cs.length;i++){ if (String(cs[i].textContent).indexOf(${JSON.stringify(name)})>=0){ cs[i].click(); return true; } } return false; })()`
const CLICK_DIFFBTN = (text) => `(function(){ var bs=document.querySelectorAll('.dside-diff-head button');
  for (var i=0;i<bs.length;i++){ if (String(bs[i].textContent).indexOf(${JSON.stringify(text)})>=0){ bs[i].click(); return true; } } return false; })()`

const idxOfChip = (list, name) => list.findIndex((c) => c.text.indexOf(name) >= 0)

try {
  await cdp('Runtime.enable')
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

  const booted = await waitFor(`!!(window.monaco && window.monaco.editor)`, 60000)
  check('P0 应用外壳启动（monaco 就绪）', !!booted, 'timeout')
  if (!booted) throw new Error('shell not booted')

  // ── 0. 定位工作空间根，建 fixture，深链打开 ──
  ROOT = await waitFor(ROOT_VIA_API, 40000)
  check('P1 读到当前工作空间根（/dsh-ide/init）', !!(ROOT && /^[A-Za-z]:\\/.test(ROOT)), JSON.stringify(ROOT))
  if (!ROOT || !/^[A-Za-z]:\\/.test(ROOT)) throw new Error('no workspace root: ' + ROOT)
  FA = join(ROOT, '_e2e6d_a.ts')
  FB = join(ROOT, '_e2e6d_b.ts')
  FC = join(ROOT, '_e2e6d_c.ts')
  for (const p of [FA, FB]) { if (existsSync(p)) rmSync(p) }
  writeFileSync(FC, TC)
  await cdp('Page.navigate', { url: APP + '/?file=' + encodeURIComponent(FC) })
  await sleep(1500)
  const ready = await waitFor(`(function(){ var t=${MODEL_TEXT('_e2e6d_c.ts')}; return t===null?null:t.indexOf('e2e6d fixture')>=0; })()`, 45000)
  check('P2 深链文件已在编辑器打开', !!ready, 'timeout')

  if (!(await evalJs(AGENT_TAB_READY))) { await evalJs(CLICK_AGENT_TAB); await sleep(600) }

  // ── 1. 第一轮：新建两个文件（同一轮两处改动 → 多文件审阅的素材）──
  const prompt1 = '请用 write 工具新建两个文件（一次做完，不要用 shell 命令）：① ' + FA
    + ' 内容只有一行：const a = 1 ② ' + FB + ' 内容只有一行：const b = 1。改完回复 OK'
  const sent1 = await evalJs(SEND(prompt1))
  check('P3 第一轮提示已发给 Agent', sent1 === 'sent', String(sent1))
  const twoRows = await waitFor(`(function(){ var p=${PANEL}; return p.rows.length>=2 ? p : null; })()`, 240000)
  check('P4 第一轮两处改动都登记进清单', !!(twoRows && twoRows.rows.length === 2), JSON.stringify(twoRows && twoRows.rows))
  if (!twoRows) throw new Error('round1 rows missing')
  const names1 = twoRows.rows.map((r) => r.name).join(',')
  check('P5 清单两行 = a / b', names1.indexOf('_e2e6d_a.ts') >= 0 && names1.indexOf('_e2e6d_b.ts') >= 0, names1)
  const twoCreate = await waitFor(`(function(){ var p=${PANEL};
    return (p.rows.length===2 && p.rows[0].icon.indexOf('＋')>=0 && p.rows[1].icon.indexOf('＋')>=0) ? p : null; })()`, 20000)
  check('P6 两个都判定为"新建"（＋ 图标）', !!twoCreate, JSON.stringify(twoRows && twoRows.rows.map((r) => r.icon)))
  check('P7 折叠态标题 = 本轮改动 2 个文件', /本轮改动\s*2\s*个文件/.test(twoRows.head), twoRows.head)
  check('P8 只有一轮时不显示"历史"入口', twoRows.link === '', JSON.stringify(twoRows.link))
  await waitFor(`(function(){ var t=${IDLE}; return t.indexOf('空闲')>=0 ? t : null; })()`, 90000)
  await sleep(600)

  // ── 2. 第二轮：改既有文件（history 出现两轮）──
  const prompt2 = '请用 edit 工具把 ' + FC + ' 里第 2 行的数字 1 改成 2（只改这一处，不要动别的文件，改完回复 OK）'
  const sent2 = await evalJs(SEND(prompt2))
  check('P9 第二轮提示已发出', sent2 === 'sent', String(sent2))
  const round2 = await waitFor(`(function(){ var p=${PANEL};
    return (p.rows.length===1 && p.rows[0].name.indexOf('_e2e6d_c.ts')>=0) ? p : null; })()`, 240000)
  check('P10 折叠态只显示本轮（第二轮=c 一个文件，第一轮的 a/b 收起来了）', !!round2,
    JSON.stringify(round2 && round2.rows))
  check('P11 折叠态标题 = 本轮改动 1 个文件', !!(round2 && /本轮改动\s*1\s*个文件/.test(round2.head)), round2 && round2.head)
  check('P12 出现"历史 2 轮"入口', !!(round2 && /历史\s*2\s*轮/.test(round2.link)), round2 && round2.link)
  await waitFor(`(function(){ var t=${IDLE}; return t.indexOf('空闲')>=0 ? t : null; })()`, 90000)
  await sleep(600)

  // ── 3. 展开历史：本次会话每一轮 ──
  const clickedHistory = await evalJs(CLICK_HEAD('历史'))
  check('P13 点「历史」展开', clickedHistory === true, String(clickedHistory))
  const hist = await waitFor(`(function(){ var p=${PANEL}; return p.rounds.length>=2 ? p : null; })()`, 8000)
  check('P14 展开后出现 2 个轮次头', !!(hist && hist.rounds.length === 2), JSON.stringify(hist && hist.rounds))
  check('P15 轮次头标出第 2 轮为本轮', !!(hist && hist.rounds[0].text.indexOf('第 2 轮') >= 0 && hist.rounds[0].text.indexOf('本轮') >= 0),
    JSON.stringify(hist && hist.rounds[0]))
  check('P16 第 1 轮头显示 2 个文件', !!(hist && hist.rounds[1].text.indexOf('第 1 轮') >= 0 && hist.rounds[1].text.indexOf('2 个文件') >= 0),
    JSON.stringify(hist && hist.rounds[1]))
  check('P17 展开态列出全部 3 个文件行', !!(hist && hist.rows.length === 3), JSON.stringify(hist && hist.rows.map((r) => r.name)))
  check('P18 展开态标题 = 本次会话改动 3 个文件',
    !!(hist && /本次会话改动\s*3\s*个文件/.test(hist.head) && /2\s*轮/.test(hist.tail)), hist && hist.head)

  // ── 4. 一次审多文件：第 1 轮的「审阅」→ 队列（chips + 上一个/下一个）──
  const clickedRoundReview = await evalJs(CLICK_ROUND('第 1 轮', '审阅'))
  check('P19 点第 1 轮「审阅」触发', clickedRoundReview === true, String(clickedRoundReview))
  const q0 = await waitFor(`(function(){ var d=${DIFF}; return d && d.n>0 && d.chips.length>=2 ? d : null; })()`, 12000)
  check('P20 审阅队列打开（chips = 第 1 轮的 2 个文件）', !!(q0 && q0.chips.length === 2), JSON.stringify(q0 && q0.chips))
  check('P21 头部标出第 1/2 个文件', !!(q0 && /第\s*1\/2\s*个文件/.test(q0.head)), q0 && q0.head)
  const ia = q0 ? idxOfChip(q0.chips, '_e2e6d_a.ts') : -1
  const ib = q0 ? idxOfChip(q0.chips, '_e2e6d_b.ts') : -1
  check('P22 chips 覆盖 a / b 两个文件', ia >= 0 && ib >= 0, JSON.stringify(q0 && q0.chips.map((c) => c.text)))

  // 切到 b：内容应该是 b 的（换文件真的换了 diff 内容）
  const clickedChip = await evalJs(CLICK_CHIP('_e2e6d_b.ts'))
  const qb = await waitFor(`(function(){ var d=${DIFF}; return d && /_e2e6d_b\.ts/.test(d.head) ? d : null; })()`, 8000)
  check('P23 点 chip 切到 b（头部/内容都跟着换）',
    !!(clickedChip && qb && /const b\s*=\s*1/.test(qb.modified || '')),
    JSON.stringify(qb && { head: qb.head, m: (qb.modified || '').slice(0, 30) }))
  check('P24 第 2 个 chip 处于选中态', !!(qb && qb.chips[ib] && qb.chips[ib].cls.indexOf('active') >= 0), JSON.stringify(qb && qb.chips[ib]))
  const clickedPrev = await evalJs(CLICK_DIFFBTN('← 上一个'))
  const qa = await waitFor(`(function(){ var d=${DIFF}; return d && /_e2e6d_a\.ts/.test(d.head) ? d : null; })()`, 8000)
  check('P25 「← 上一个」退回 a', !!(clickedPrev && qa && /const a\s*=\s*1/.test(qa.modified || '')),
    JSON.stringify(qa && { head: qa.head, m: (qa.modified || '').slice(0, 30) }))
  check('P26 新建文件的左侧是"文件不存在"', !!(qa && /文件不存在/.test(qa.head)), qa && qa.head)

  // ── 5. 队列内撤销：删掉新建的 a，并自动跳到下一个未撤销的文件 ──
  const clickedUndo = await evalJs(CLICK_DIFFBTN('撤销这次改动'))
  check('P27 队列内点「撤销这次改动」', clickedUndo === true, String(clickedUndo))
  let deleted = false
  for (let i = 0; i < 25 && !deleted; i++) { await sleep(400); deleted = !existsSync(FA) }
  check('P28 撤销新建 = 磁盘上 a 被删除', deleted, 'still exists')
  const qAfter = await waitFor(`(function(){ var d=${DIFF}; return d && d.chips.length>=2 ? d : null; })()`, 8000)
  const chipA = qAfter ? qAfter.chips[ia] : null
  check('P29 已撤销的 chip 划掉（undone）', !!(chipA && chipA.cls.indexOf('undone') >= 0), JSON.stringify(chipA))
  const rowA = await waitFor(`(function(){ var p=${PANEL};
    for (var i=0;i<p.rows.length;i++) if (p.rows[i].name.indexOf('_e2e6d_a.ts')>=0) return p.rows[i]; return null; })()`, 8000)
  check('P30 清单行同步标为已撤销', !!(rowA && rowA.cls.indexOf('undone') >= 0), JSON.stringify(rowA))
  check('P31 撤销后自动跳到下一个未撤销的文件（b）', !!(qAfter && /_e2e6d_b\.ts/.test(qAfter.head)), qAfter && qAfter.head)

  // ── 6. 保留（本次会话口径）+ 收起历史 ──
  const kept = await evalJs(CLICK_HEAD('全部保留'))
  const keptRows = await waitFor(`(function(){ var p=${PANEL};
    var k=0; for (var i=0;i<p.rows.length;i++) if (p.rows[i].cls.indexOf('kept')>=0) k++;
    return k>=2 ? p : null; })()`, 8000)
  check('P32 「全部保留」把未撤销的行标为已保留', !!(kept && keptRows), JSON.stringify(keptRows && keptRows.rows.map((r) => r.cls)))
  const collapsed = await evalJs(CLICK_HEAD('收起'))
  const back = await waitFor(`(function(){ var p=${PANEL}; return (p.rounds.length===0 && p.rows.length===1) ? p : null; })()`, 8000)
  check('P33 「收起」回到折叠态（只剩本轮 1 行）', !!(collapsed && back), JSON.stringify(back && back.rows))

  // ── 7. 埋点（客户端是 800ms 去抖批量上报 → 给足沉降时间再读日志；读 window.__dshTraceStat 判断发没发出去）──
  await sleep(2500)
  const stat = await evalJs(`(function(){ return window.__dshTraceStat || null; })()`)
  check('P34 客户端轨迹已批量上报（__dshTraceStat.sent > 0 且无失败）',
    !!(stat && stat.sent > 0 && stat.failed === 0), JSON.stringify(stat))
  let logText = readFileSync(TRACE, 'utf8').slice(-200000)
  const wanted = ['change-history-toggle', 'change-review-queue', 'change-review-nav', 'change-review-undo', 'change-undo-ok', 'change-keep-all']
  let missing = wanted.filter((k) => logText.indexOf(k) < 0)
  for (let i = 0; i < 20 && missing.length; i++) {   // 去抖 + 落盘：最多再等 8s
    await sleep(400)
    logText = readFileSync(TRACE, 'utf8').slice(-200000)
    missing = wanted.filter((k) => logText.indexOf(k) < 0)
  }
  check('P35 轨迹日志记录历史/队列/切文件/撤销/保留', missing.length === 0,
    'missing=' + missing.join(',') + ' stat=' + JSON.stringify(stat))

  check('P36 页面无未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
} catch (e) {
  check('E2E 执行未中断', false, String((e && e.message) || e))
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n== ${pass}/${results.length} PASS ==`)
  for (const p of [FA, FB, FC]) { try { if (p && existsSync(p)) rmSync(p) } catch { /* 忽略 */ } }
  try { ws.close() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
  await sleep(400)
  try { rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }) } catch { /* 忽略 */ }
  process.exit(pass === results.length ? 0 : 2)
}
