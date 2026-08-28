// SSH REST 路由集成测试:spawn 真网关(模式同 wb-approval-roundtrip.test.mjs)。
// 覆盖:CRUD + 脱敏(明文 pw 不得出现在任何响应)+ 校验 400 + 试连结构化错误。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 47000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'ssh-routes-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'ssh.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

test('SSH CRUD + 脱敏 + 试连结构化错误', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 创建(password 认证 + 暴露 AI + readonly 策略),host 指向必拒绝端口 → 试连走 unreachable
  const created = await (await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 't1', host: '127.0.0.1', port: 1, username: 'ops',
      authMethod: 'password', password: 'pw', exposeToAi: true, aiApprovalPolicy: 'readonly' }) })).json()
  assert.equal(created.server.name, 't1')
  assert.equal(created.server.hasPassword, true)
  assert.equal(created.server.password, undefined)

  // 列表脱敏:任何响应不得出现明文 pw
  const list = await (await fetch(`${BASE}/api/ssh/servers`, { headers: H })).json()
  assert.equal(list.servers.length, 1)
  assert.ok(!JSON.stringify(list).includes('"pw"'))

  // 校验失败 400
  const bad = await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H, body: JSON.stringify({ name: '' }) })
  assert.equal(bad.status, 400)

  // 试连(已保存行):stub 返回 unreachable(断言必有 errorKind+非 ok)
  const t = await (await fetch(`${BASE}/api/ssh/servers/${created.server.id}/test`, { method: 'POST', headers: H })).json()
  assert.equal(t.ok, false)
  assert.ok(t.errorKind)

  // 未保存表单试连
  const t2 = await (await fetch(`${BASE}/api/ssh/test`, { method: 'POST', headers: H,
    body: JSON.stringify({ host: '127.0.0.1', port: 1, username: 'ops', authMethod: 'password', password: 'x' }) })).json()
  assert.equal(t2.ok, false)

  // 更新(留空密码保持)+ PUT 非法 port 400 + 删除
  const up = await (await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'PUT', headers: H,
    body: JSON.stringify({ description: 'd2' }) })).json()
  assert.equal(up.server.description, 'd2')
  const badPort = await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'PUT', headers: H,
    body: JSON.stringify({ port: 99999 }) })
  assert.equal(badPort.status, 400)
  const del = await fetch(`${BASE}/api/ssh/servers/${created.server.id}`, { method: 'DELETE', headers: H })
  assert.equal(del.status, 200)
  assert.equal((await (await fetch(`${BASE}/api/ssh/servers`, { headers: H })).json()).servers.length, 0)
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
