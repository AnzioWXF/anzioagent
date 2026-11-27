'use strict'

// backend.js 逻辑测试（不依赖 Electron）
const { probePort, parseUrl, ensureIdeHome, buildLaunchCommand } = require('./backend.js')

;(async () => {
  let failed = false
  const check = (name, cond) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name)
    if (!cond) failed = true
  }

  // 默认 URL 解析
  const parsed = parseUrl('http://127.0.0.1:3081')
  check('parseUrl 3081', parsed.host === '127.0.0.1' && parsed.port === 3081)

  // 端口探测：3080（开发台）应有服务，3081（应用实例）应无服务
  const dev = await probePort('127.0.0.1', 3080, 1200)
  check('probe 3080 (dev web alive)', dev === true)
  const app = await probePort('127.0.0.1', 3081, 800)
  check('probe 3081 (app instance free)', app === false)

  // 启动命令 --port 追加
  check('launch cmd appends --port',
    buildLaunchCommand('node --import tsx/esm apps/cli/src/bin.ts web', 3081)
      === 'node --import tsx/esm apps/cli/src/bin.ts web --port 3081')
  check('launch cmd keeps explicit --port',
    buildLaunchCommand('node x.js web --port 9999', 3081) === 'node x.js web --port 9999')

  // 独立 home 初始化（共享配置 junction + 独立 settings）
  const fs = require('fs')
  const path = require('path')
  const REPO_ROOT = path.resolve(__dirname, '..', '..')   // 本文件在 deepseek-harness-mine\shell 下
  const APP_HOME = path.join(REPO_ROOT, 'app-home')
  const ok = ensureIdeHome(APP_HOME, path.join(REPO_ROOT, 'dev-home', 'profiles', 'web'))
  check('ensureIdeHome returns ok', ok === true)
  const link = path.join(APP_HOME, 'profiles', 'web')
  check('profiles/web exists', fs.existsSync(link))
  check('shared config visible through junction', fs.existsSync(path.join(link, 'cordis.patch.yml')))
  check('dsh-ide plugin visible through junction', fs.existsSync(path.join(link, 'ide', 'dsh-ide', 'lib', 'client.js')))
  check('independent settings.yaml', fs.existsSync(path.join(APP_HOME, 'settings.yaml')))

  console.log(failed ? 'SOME TESTS FAILED' : 'ALL TESTS PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('TEST ERROR:', e)
  process.exit(1)
})
