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

test('合法 token 但缺 sid → 帧级拒绝(missing sid),绝不随机补位造孤儿会话', { timeout: 30000 }, async () => {
  // 2026-08-29 审计:sid 缺失时网关 crypto.randomUUID() 补位 → 客户端永远无从知道 sid,
  // 会话成为任务栏/对账盲区(「泄漏」的出生通道之一)。改为硬性拒绝。
  // 判别点:用真实存在的服务器行(127.0.0.1:1 必 ECONNREFUSED)——旧代码此处错误文案是
  // 连接失败类;新代码在 acquire 之前就被 sid 校验拦截,帧文本恒 'missing sid'。
  await waitUp()
  const login = await (await fetch(`http://127.0.0.1:${GW_PORT}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const created = await (await fetch(`http://127.0.0.1:${GW_PORT}/api/ssh/servers`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-platform-token': login.token },
    body: JSON.stringify({ name: 'ws-t', host: '127.0.0.1', port: 1, username: 'ops',
      authMethod: 'password', password: 'pw' }) })).json()
  const outcome = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/ssh/terminal?session=${login.token}&serverId=${created.server.id}`)
    let errText = null
    ws.on('message', data => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buf.length >= 1 && buf[0] === 4) errText = buf.subarray(1).toString('utf8')   // CH_ERROR = 4
    })
    ws.on('close', () => resolve(errText || 'closed-silent'))
    ws.on('error', () => resolve(errText || 'error'))
    setTimeout(() => resolve(`timeout:${errText}`), 8000)
  })
  assert.equal(outcome, 'missing serverId or sid')
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
