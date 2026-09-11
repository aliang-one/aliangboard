// scripts/state-guard.test.mjs
// 状态登记守卫(spec §10):server/ 顶层(缩进 0)的 const/let x = new Map/Set( 必须在 allowlist。
// 三类:PENDING(Wave 1 迁走后删条目,终态清零)/ PROTECTED(宪法保护区,须登记 registry)/
// CONST(加载期只读常量表,豁免交叉核验)。工厂函数内部的 Map 有缩进,天然不误伤。
// 2026-09-11 实测校准:DECL_RE 允许可选 export 前缀(routes/auth.mjs 的 mfaTickets/oidcStates
// 等 4 个票据 Map 是 `export const` 声明——同为模块级状态,漏扫即弱化守卫)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server')

const ALLOWLIST = [
  // --- PROTECTED:宪法保护区/Wave 2 登记(10;Task 14 后须在 registry 出现) ---
  { file: 'server/index.mjs', name: 'sessions', kind: 'protected', reason: '双写会话,宪法红线' },
  { file: 'server/index.mjs', name: 'platformSessions', kind: 'protected', reason: '双写会话,宪法红线' },
  { file: 'server/index.mjs', name: 'idleTracker', kind: 'protected', reason: '重入守卫耦合,红线' },
  { file: 'server/index.mjs', name: 'forwards', kind: 'protected', reason: '活 listener,红线' },
  { file: 'server/workbench-summarize.mjs', name: 'projectSummarizerFedRid', kind: 'protected', reason: 'Tier2 水位不变式' },
  { file: 'server/workbench-repos.mjs', name: '_locks', kind: 'protected', reason: 'Tier2 repo 串行锁' },
  { file: 'server/sa-binding.mjs', name: '_cache', kind: 'protected', reason: 'Tier2 动态窗口' },
  { file: 'server/call-context.mjs', name: 'allowedHosts', kind: 'protected', reason: 'env 派生 lazy' },
  { file: 'server/call-context.mjs', name: '_dispatcherCache', kind: 'protected', reason: '活 Agent 池' },
  { file: 'server/ssh/job-bridge.mjs', name: 'sweepSeenServers', kind: 'protected', reason: 'Tier2 模块级共享' },
  // --- CONST:加载期只读常量表(11,豁免交叉核验) ---
  { file: 'server/agent-runner.mjs', name: 'WRITE_TOOLS', kind: 'const', reason: '常量表' },
  { file: 'server/cluster-certs.mjs', name: 'CA_MISMATCH_CODES', kind: 'const', reason: '常量表' },
  { file: 'server/cluster-certs.mjs', name: 'NET_CODES', kind: 'const', reason: '常量表' },
  { file: 'server/wb-approval-mode.mjs', name: 'WRITES_AUTO_TOOLS', kind: 'const', reason: '常量表' },
  { file: 'server/wb-approval-mode.mjs', name: 'AUTO_TOOLS', kind: 'const', reason: '常量表' },
  { file: 'server/authz.mjs', name: 'SUBRESOURCE_OPERATE', kind: 'const', reason: '常量表' },
  { file: 'server/k8s-path.mjs', name: 'SUBRESOURCES', kind: 'const', reason: '常量表' },
  { file: 'server/k8s-gate.mjs', name: 'SERVER_ROOT_GET', kind: 'const', reason: '常量表' },
  { file: 'server/static.mjs', name: 'COMPRESSIBLE', kind: 'const', reason: '常量表' },
  { file: 'server/ssh/readonly-classifier.mjs', name: 'READONLY', kind: 'const', reason: '常量表' },
  { file: 'server/ssh/readonly-classifier.mjs', name: 'ARG_DENY', kind: 'const', reason: '常量表' },
]
// Task 14 清空(交叉核验激活前的缓冲名单)
const NOT_YET_REGISTERED = ['sessions', 'platformSessions', 'idleTracker', 'forwards',
  'projectSummarizerFedRid', '_locks', '_cache', 'allowedHosts', '_dispatcherCache', 'sweepSeenServers']

function listMjs(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (ent.name === 'test-fixtures' || ent.name === 'state') continue
      listMjs(join(dir, ent.name), out)
    } else if (ent.name.endsWith('.mjs') && !ent.name.endsWith('.test.mjs')) out.push(join(dir, ent.name))
  }
  return out
}

const DECL_RE = /^(?:export\s+)?(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(Map|Set)\s*\(/

function scanTopLevelDecls() {
  const hits = []
  for (const abs of listMjs(SERVER)) {
    const rel = abs.slice(ROOT.length + 1)
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(DECL_RE)
      if (m) hits.push({ file: rel, name: m[2], line: i + 1 })
    }
  }
  return hits
}

test('① 顶层 new Map/Set 必须全部在 allowlist(新状态必须进统一轴向)', () => {
  const hits = scanTopLevelDecls()
  const listed = new Set(ALLOWLIST.map(e => `${e.file}:${e.name}`))
  const stray = hits.filter(h => !listed.has(`${h.file}:${h.name}`))
  assert.deepEqual(stray.map(h => `${h.file}:${h.line} ${h.name}`), [],
    '未登记的模块级状态:迁入 server/state/kernel.mjs 原语,或在本守卫 allowlist 登记(带 reason)')
})

test('② allowlist 无僵尸条目(条目必须仍命中源码)', () => {
  const hits = scanTopLevelDecls()
  const present = new Set(hits.map(h => `${h.file}:${h.name}`))
  const zombies = ALLOWLIST.filter(e => !present.has(`${e.file}:${e.name}`))
  assert.deepEqual(zombies.map(e => `${e.file}:${e.name}`), [],
    'allowlist 条目已不在源码:迁移完成后请同步删除条目')
})

test('③ PROTECTED 交叉核验:必须在 registry.mjs 有 registerState(或暂列 NOT_YET_REGISTERED)', () => {
  const registrySrc = readFileSync(join(SERVER, 'state', 'registry.mjs'), 'utf8')
    + readFileSync(join(SERVER, 'state', 'kernel.mjs'), 'utf8')
    + readFileSync(join(SERVER, 'index.mjs'), 'utf8')
    + readFileSync(join(SERVER, 'rate-limit.mjs'), 'utf8')
    + readFileSync(join(SERVER, 'conv-bus.mjs'), 'utf8')
  const missing = ALLOWLIST
    .filter(e => e.kind === 'protected' && !NOT_YET_REGISTERED.includes(e.name))
    .filter(e => !new RegExp(`registerState\\(\\{[^}]*name:\\s*['"\`]${e.name.replace(/[$]/g, '\\$')}['"\`]`).test(registrySrc))
  assert.deepEqual(missing.map(e => e.name), [],
    '宪法保护区状态必须在 registry 登记(Wave 2 Task 14 完成;完成后清空 NOT_YET_REGISTERED)')
})

test('终态断言:PENDING 与 NOT_YET_REGISTERED 双清零(Task 14/15 后启用本断言)', () => {
  // Wave 1 完成(Task 12 三条 inflight 迁 singleFlight):PENDING 已清零,断言翻 assert.equal;
  // NOT_YET_REGISTERED 仍以 >= 0 占位,Task 14 完成后翻 assert.equal(..., 0)。
  const pending = ALLOWLIST.filter(e => e.kind === 'pending').length
  assert.equal(pending, 0, `pending=${pending}(PENDING 类别已终态清零;新状态须直接迁 kernel 原语或登记 PROTECTED/CONST)`)
  assert.ok(NOT_YET_REGISTERED.length >= 0, `notYetRegistered=${NOT_YET_REGISTERED.length}(Task 14 完成后应翻成 assert.equal(..., 0))`)
})
