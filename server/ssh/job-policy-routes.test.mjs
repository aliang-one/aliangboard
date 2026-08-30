// SSH 异步任务策略 admin 端点集成测试:spawn 真网关(模式同 session-policy-routes.test.mjs)。
// 覆盖:GET 空态=默认 / PUT 部分更新 / 越界 400 且不污染已存值 / 非 admin 401 / 审计落库。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 51000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'ssh-job-policy-'))

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

test('SSH 任务策略:GET 空态=默认;PUT 部分更新;越界 400;非 admin 401;审计', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 空态=内置默认
  assert.deepEqual(await (await fetch(`${BASE}/api/admin/ssh-job-policy`, { headers: H })).json(),
    { ttlMin: 120, maxPerServer: 4 })

  // 部分更新:只动 ttlMin,maxPerServer 保持
  const put1 = await (await fetch(`${BASE}/api/admin/ssh-job-policy`, { method: 'PUT', headers: H,
    body: JSON.stringify({ ttlMin: 60 }) })).json()
  assert.deepEqual(put1.policy, { ttlMin: 60, maxPerServer: 4 })

  // 越界 → 400;小数 → 400(终审 I3:`-mmin +1.5` 让 find 报错被 2>/dev/null 吞,该服务器
  // 每轮 sweep 静默 no-op 而 admin 看到成功——小数必须被闸在门外)
  for (const bad of [{ ttlMin: 0 }, { maxPerServer: 99 }, { ttlMin: 10081 }, { maxPerServer: 'x' },
    { ttlMin: 1.5 }, { maxPerServer: 2.5 }, { ttlMin: 60.000001 }]) {
    const r = await fetch(`${BASE}/api/admin/ssh-job-policy`, { method: 'PUT', headers: H, body: JSON.stringify(bad) })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  // 失败请求不得污染已存值
  assert.deepEqual((await (await fetch(`${BASE}/api/admin/ssh-job-policy`, { headers: H })).json()),
    { ttlMin: 60, maxPerServer: 4 })

  // 无 token → 401(requireAdmin 在分支内)
  assert.equal((await fetch(`${BASE}/api/admin/ssh-job-policy`)).status, 401)

  // PUT 落审计 tool=ssh_job_policy
  const adb = new DatabaseSync(join(DIR, 'ssh.db'), { readOnly: true })
  const rows = adb.prepare("SELECT tool, verb, source FROM audit_log WHERE tool = 'ssh_job_policy'").all()
  adb.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'ssh_job_policy')
  assert.equal(rows[0].verb, 'write')
  assert.equal(rows[0].source, 'platform')
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
