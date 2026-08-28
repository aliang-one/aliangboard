// /api/ssh/terminal WS 握手集成测试:spawn 真网关(模式同 routes.test.mjs)。
// 覆盖:坏平台 token → 401 拒绝升级(绝不 open);未知路径 destroy。正向 e2e(真 shell)归手测清单。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 49000 + Math.floor(Math.random() * 2000)
const DIR = mkdtempSync(join(tmpdir(), 'ssh-ws-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'ssh.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${GW_PORT}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

function wsOutcome(path) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}${path}`)
    ws.on('open', () => resolve('opened'))
    ws.on('error', () => resolve('error'))
    ws.on('unexpected-response', (_req, res) => resolve(`http${res.statusCode}`))
  })
}

test('WS 坏 token → 401 拒绝升级', { timeout: 30000 }, async () => {
  await waitUp()
  const ok = await wsOutcome('/api/ssh/terminal?session=badtoken&serverId=x&sid=y')
  assert.equal(ok, 'http401')
})

test('WS 缺 token → 401 拒绝升级', { timeout: 30000 }, async () => {
  const ok = await wsOutcome('/api/ssh/terminal?serverId=x&sid=y')
  assert.equal(ok, 'http401')
})

test('未知 WS 路径 → 非 open(destroy)', { timeout: 30000 }, async () => {
  const ok = await wsOutcome('/api/not-exist?session=z')
  assert.notEqual(ok, 'opened')
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
