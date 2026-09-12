// server/routes/credentials.test.mjs
// e2e:spawn 真网关(照 routes/workbench-projects.test.mjs harness)。断言 CRUD/reveal/三态/审计/密文落库。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 54000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-cred-routes-'))
const DB_PATH = join(DIR, 'wb.db')

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: DB_PATH,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR,
    ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})
const j = t => ({ 'content-type': 'application/json', 'x-platform-token': t })

test('凭据全链:CRUD/reveal/三态/审计/密文落库', { timeout: 90000 }, async () => {
  for (let i = 0; i < 60; i++) { try { await fetch(`${BASE}/api/health`); break } catch { await new Promise(r => setTimeout(r, 300)) } }
  const adminTok = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()).token
  await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: j(adminTok), body: JSON.stringify({ username: 'u2', password: 'y'.repeat(12), role: 'user' }) })
  const u2 = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'u2', password: 'y'.repeat(12) }) })).json()).token

  // 非 admin 403
  assert.equal((await fetch(`${BASE}/api/workbench/credentials`, { headers: j(u2) })).status, 403)
  // 创建
  const cr = await (await fetch(`${BASE}/api/workbench/credentials`, { method: 'POST', headers: j(adminTok),
    body: JSON.stringify({ name: 'gh-token', description: 'GitHub CI', tags: ['git'], exposeToAi: true, fields: [
      { key: 'user', type: 'text', value: 'liang' }, { key: 'token', type: 'password', value: 'ghp_hunter2secret' }] }) })).json()
  const id = cr.credential.id
  // 列表 sanitize
  const ls = await (await fetch(`${BASE}/api/workbench/credentials`, { headers: j(adminTok) })).json()
  assert.ok(!JSON.stringify(ls).includes('ghp_hunter2secret'), '列表零值')
  // 详情:text 明文 + password 指纹
  const det = await (await fetch(`${BASE}/api/workbench/credentials/${id}`, { headers: j(adminTok) })).json()
  const f = Object.fromEntries(det.credential.fields.map(x => [x.key, x.value]))
  assert.equal(f.user, 'liang')
  assert.match(f.token, /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/)
  // reveal
  const rv = await (await fetch(`${BASE}/api/workbench/credentials/${id}/reveal`, { method: 'POST', headers: j(adminTok), body: JSON.stringify({ fieldKey: 'token' }) })).json()
  assert.equal(rv.value, 'ghp_hunter2secret')
  // 三态:password 留空保持
  await fetch(`${BASE}/api/workbench/credentials/${id}`, { method: 'PATCH', headers: j(adminTok),
    body: JSON.stringify({ fields: [{ key: 'user', type: 'text', value: 'liang2' }, { key: 'token', type: 'password' }] }) })
  const rv2 = await (await fetch(`${BASE}/api/workbench/credentials/${id}/reveal`, { method: 'POST', headers: j(adminTok), body: JSON.stringify({ fieldKey: 'token' }) })).json()
  assert.equal(rv2.value, 'ghp_hunter2secret', '留空保持')
  // 掩码回写 400
  const maskRes = await fetch(`${BASE}/api/workbench/credentials/${id}`, { method: 'PATCH', headers: j(adminTok),
    body: JSON.stringify({ fields: [{ key: 'user', type: 'text', value: '*** (3 chars, #abcd1234)' }] }) })
  assert.equal(maskRes.status, 400)
  // 密文落库(须在 DELETE 前读——store 层是硬删,行删了读不到)
  const adb = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = adb.prepare('SELECT fields FROM workbench_credentials WHERE id=?').get(id)
  assert.ok(!row.fields.includes('ghp_hunter2secret') && row.fields.includes('v1:'), '库内只有密文')
  adb.close()
  // DELETE 确认名
  assert.equal((await fetch(`${BASE}/api/workbench/credentials/${id}`, { method: 'DELETE', headers: j(adminTok), body: JSON.stringify({ confirmName: 'x' }) })).status, 400)
  assert.equal((await fetch(`${BASE}/api/workbench/credentials/${id}`, { method: 'DELETE', headers: j(adminTok), body: JSON.stringify({ confirmName: 'gh-token' }) })).status, 200)
  // 审计
  const adb2 = new DatabaseSync(DB_PATH, { readOnly: true })
  const tools = adb2.prepare("SELECT tool FROM audit_log WHERE tool LIKE 'credential_%' ORDER BY rowid").all().map(r => r.tool)
  adb2.close()
  // 用例调用序:create → detail(无审计) → reveal → PATCH → reveal → 掩码 400(无审计) → DELETE 400(无审计) → DELETE
  assert.deepEqual(tools, ['credential_create', 'credential_reveal', 'credential_update', 'credential_reveal', 'credential_delete'])
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
