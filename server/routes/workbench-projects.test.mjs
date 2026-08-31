// 工作台项目生命周期路由集成测试:spawn 真网关(模式同 ssh/job-policy-routes.test.mjs)。
// 覆盖(2026-08-31 生命周期 spec):DELETE 确认名不符 400 / 非 owner 403 / 404 /
// 成功删除(列表不含+对话 GET 404+审计)/ PATCH 改名 / recap 写入+空串清空 / 全缺 400。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GW_PORT = 52000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-proj-routes-'))
const DB_PATH = join(DIR, 'wb.db')

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: DB_PATH,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR,
    ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

async function login(username, password) {
  return (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) })).json()).token
}

async function mkProject(token, name) {
  const r = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-platform-token': token },
    body: JSON.stringify({ name }) })).json()
  return r.project
}

const j = t => ({ 'content-type': 'application/json', 'x-platform-token': t })

test('项目 DELETE/PATCH 生命周期路由', { timeout: 90000 }, async () => {
  await waitUp()
  const adminTok = await login('admin', 'x'.repeat(12))
  // 造两个普通用户:u2(项目 owner)/u3(旁观者 → 403)
  await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: j(adminTok),
    body: JSON.stringify({ username: 'u2', password: 'y'.repeat(12), role: 'user' }) })
  await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: j(adminTok),
    body: JSON.stringify({ username: 'u3', password: 'z'.repeat(12), role: 'user' }) })
  const u2 = await login('u2', 'y'.repeat(12))
  const u3 = await login('u3', 'z'.repeat(12))

  const proj = await mkProject(u2, 'edge-gateway')
  const PID = proj.id
  const C_BASE = `${BASE}/api/workbench/projects/${PID}`

  // 直插两条对话(running + done)+ 一条消息,不经 LLM
  const wdb = new DatabaseSync(DB_PATH)
  const now = Date.now()
  const cidRun = 'conv-run-1', cidDone = 'conv-done-1'
  wdb.prepare("INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?,?,?)").run(cidRun, PID, 'running', now, now)
  wdb.prepare("INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?,?,?)").run(cidDone, PID, 'done', now, now)
  wdb.prepare("INSERT INTO workbench_messages (id,conversationId,role,content,seq,createdAt) VALUES (?,?,?,?,?,?)").run('m1', cidDone, 'user', 'hi', 1, now)
  wdb.close()

  // DELETE:确认名不符 → 400
  assert.equal((await fetch(C_BASE, { method: 'DELETE', headers: j(u2),
    body: JSON.stringify({ confirmName: 'wrong' }) })).status, 400)
  // 非 owner(正确确认名)→ 403
  assert.equal((await fetch(C_BASE, { method: 'DELETE', headers: j(u3),
    body: JSON.stringify({ confirmName: 'edge-gateway' }) })).status, 403)
  // 不存在 → 404
  const nf = await fetch(`${BASE}/api/workbench/projects/nope`, { method: 'DELETE', headers: j(u2),
    body: JSON.stringify({ confirmName: 'x' }) })
  assert.equal(nf.status, 404, await nf.clone().text())

  // DELETE 成功:running 对话被取消后删;对话 GET 404;列表不含;repo 目录清除
  const del = await (await fetch(C_BASE, { method: 'DELETE', headers: j(u2),
    body: JSON.stringify({ confirmName: 'edge-gateway' }) })).json()
  assert.equal(del.ok, true)
  assert.equal(del.repoRemoved, true)
  assert.equal(typeof del.removedConversations, 'number')
  assert.equal((await fetch(`${BASE}/api/workbench/conversations/${cidRun}`, { headers: j(adminTok) })).status, 404)
  assert.equal((await fetch(`${BASE}/api/workbench/conversations/${cidDone}`, { headers: j(adminTok) })).status, 404)
  const list = await (await fetch(`${BASE}/api/workbench/projects`, { headers: j(u2) })).json()
  assert.ok(!list.projects.some(p => p.id === PID))

  // 审计 project_delete
  const adb = new DatabaseSync(DB_PATH, { readOnly: true })
  const delAudit = adb.prepare("SELECT tool, verb, source FROM audit_log WHERE tool='project_delete'").all()
  adb.close()
  assert.equal(delAudit.length, 1)
  assert.equal(delAudit[0].verb, 'write')
  assert.equal(delAudit[0].source, 'platform')
})

test('项目 PATCH:name 改名 / recap 写入与空串清空 / 校验 400', { timeout: 60000 }, async () => {
  await waitUp()
  const u2 = await login('u2', 'y'.repeat(12))
  const proj = await mkProject(u2, 'patch-target')
  const C_BASE = `${BASE}/api/workbench/projects/${proj.id}`

  // 改名生效
  const r1 = await (await fetch(C_BASE, { method: 'PATCH', headers: j(u2),
    body: JSON.stringify({ name: 'renamed' }) })).json()
  assert.equal(r1.ok, true)
  assert.equal(r1.project.name, 'renamed')

  // recap 写入(GET 详情可见)
  await fetch(C_BASE, { method: 'PATCH', headers: j(u2), body: JSON.stringify({ recap: 'manual recap' }) })
  const detail = await (await fetch(C_BASE, { headers: j(u2) })).json()
  assert.equal(detail.project.projectRecap, 'manual recap')

  // recap 空串 → 清空
  const r3 = await (await fetch(C_BASE, { method: 'PATCH', headers: j(u2),
    body: JSON.stringify({ recap: '' }) })).json()
  assert.equal(r3.ok, true)
  const detail2 = await (await fetch(C_BASE, { headers: j(u2) })).json()
  assert.equal(detail2.project.projectRecap, null)

  // 校验:全缺 400 / 空名 400 / 超长名(81)400 / 超长 recap 透传 400
  for (const bad of [{}, { name: '  ' }, { name: 'a'.repeat(81) }, { recap: 'r'.repeat(65537) }]) {
    const r = await fetch(C_BASE, { method: 'PATCH', headers: j(u2), body: JSON.stringify(bad) })
    assert.equal(r.status, 400, JSON.stringify(bad))
  }

  // 非 owner → 403;审计 project_update
  const adminTok = await login('admin', 'x'.repeat(12))
  assert.equal((await fetch(C_BASE, { method: 'PATCH', headers: j(adminTok),
    body: JSON.stringify({ name: 'by-admin' }) })).status, 200) // admin 旁路
  const adb = new DatabaseSync(DB_PATH, { readOnly: true })
  const upd = adb.prepare("SELECT tool, verb FROM audit_log WHERE tool='project_update'").all()
  adb.close()
  assert.equal(upd.length, 4) // 改名 + recap 写 + recap 清空 + admin 改名
})

test('cleanup', async () => {
  gw.kill('SIGKILL')
  await new Promise(r => setTimeout(r, 200))
  try { rmSync(DIR, { recursive: true, force: true }) } catch {}
})
