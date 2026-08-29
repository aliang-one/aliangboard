// SSH 会话回收策略 admin 端点集成测试:spawn 真网关(模式同 routes.test.mjs)。
// 覆盖:GET 空态=默认 / PUT 部分更新 / 越界与非整数 400 且不污染已存值 / 非 admin 401。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 51000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'ssh-session-policy-'))

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

test('SSH 会话策略:GET 空态=默认;PUT 部分更新;越界 400;非 admin 401', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 空态=内置默认
  assert.deepEqual(await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { headers: H })).json(),
    { detachedIdleMin: 10, attachedIdleMin: 0, maxLifetimeMin: 0 })

  // 部分更新:只动 attached,其余保持
  const put1 = await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H,
    body: JSON.stringify({ attachedIdleMin: 30 }) })).json()
  assert.deepEqual(put1.policy, { detachedIdleMin: 10, attachedIdleMin: 30, maxLifetimeMin: 0 })

  // 全量更新 + 0=禁用语义可写回
  const put2 = await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H,
    body: JSON.stringify({ detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 }) })).json()
  assert.deepEqual(put2.policy, { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 })

  // 越界/非整数 → 400
  for (const bad of [{ detachedIdleMin: -1 }, { maxLifetimeMin: 10081 }, { attachedIdleMin: 1.5 }, { attachedIdleMin: 'x' }]) {
    const r = await fetch(`${BASE}/api/admin/ssh-session-policy`, { method: 'PUT', headers: H, body: JSON.stringify(bad) })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  // 失败请求不得污染已存值
  assert.deepEqual((await (await fetch(`${BASE}/api/admin/ssh-session-policy`, { headers: H })).json()),
    { detachedIdleMin: 0, attachedIdleMin: 0, maxLifetimeMin: 720 })

  // 无 token → 401(requireAdmin 在分支内)
  assert.equal((await fetch(`${BASE}/api/admin/ssh-session-policy`)).status, 401)
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
