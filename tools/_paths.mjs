// _paths.mjs — tools 下 .mjs 脚本共用的路径推导。
//
// 仓库根 = 本文件所在目录（tools）的上一级 ⇒ 换机器、换盘符、换目录名都不用改脚本。
// 安装目录推导不出来（产品本体不在仓库里），走"环境变量 > 既有安装 > 用户级默认"。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = process.env.TIANGONG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const shellDir = path.join(repoRoot, 'deepseek-harness-mine', 'shell')
export const pluginDir = path.join(repoRoot, 'deepseek-harness-mine', 'plugin')
export const harnessDir = path.join(repoRoot, 'deepseek-harness-mine', 'harness')
export const cliBin = path.join(harnessDir, 'apps', 'cli', 'lib', 'bin.js')
export const appHome = path.join(repoRoot, 'app-home')
export const devHome = path.join(repoRoot, 'dev-home')
export const tempDir = path.join(repoRoot, 'temp')
export const e2eLogsDir = path.join(repoRoot, '_e2e-logs')

const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
const legacyInstall = 'D:\\000AnzioAgent'
export const installDir = process.env.TIANGONG_INSTALL_DIR
  || (fs.existsSync(path.join(legacyInstall, '天工.exe')) ? legacyInstall : path.join(localAppData, 'Programs', 'Tiangong'))
