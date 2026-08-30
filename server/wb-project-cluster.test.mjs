// 项目后绑集群端点集成测试:spawn 真网关(模式同 ssh/routes.test.mjs)。
// 覆盖:未绑定建项目(clusterId='' 哨兵)→ 绑不存在集群 404 → 插集群行绑定 → 解绑 '' → 他人 403 + 审计落账。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')  // 本文件在 server/ 直下(ROOT=仓库根),与 server/ssh/routes.test.mjs 的 ../.. 不同
const GW_PORT = 53000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-proj-cluster-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

test('项目后绑集群:未绑定建项目→404 防呆→插集群行→绑定→解绑;他人 403', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 未绑定建项目(clusterId 缺省)
  const created = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'no-cluster-p' }) })).json()
  assert.equal(created.project.clusterId, '')
  const pid = created.project.id

  // 绑定不存在的集群 → 404
  const nf = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'no-such' }) })
  assert.equal(nf.status, 404)

  // 测试直接往网关库插一条集群行(node:sqlite 打开同一 ALIANG_DB),再绑定
  // (clusters 建表列已对 server/index.mjs 核对:authMethod 有默认、createdBy 可空,其余列与 INSERT 对齐)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  db.prepare('INSERT INTO clusters (id, name, apiServer, authHeader, ca, cert, key, insecure, version, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('ck-t1', '测试集群', 'https://127.0.0.1:6443', 'Basic eDp5', '', '', '', 0, 'v1.29', Date.now())
  db.close()
  const bind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'ck-t1' }) })).json()
  assert.equal(bind.project.clusterId, 'ck-t1')
  assert.equal(bind.project.clusterName, '测试集群')

  // 解绑('' 哨兵)→ 恢复未绑定
  const unbind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: '' }) })).json()
  assert.equal(unbind.project.clusterId, '')

  // 他人(非 owner 非 admin)→ 403:建普通用户并登录(POST /api/admin/users 字段 username/password 已核对)
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const forbidden = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-platform-token': plogin.token }, body: JSON.stringify({ clusterId: 'ck-t1' }) })
  assert.equal(forbidden.status, 403)

  // 审计落账
  const db2 = new DatabaseSync(join(DIR, 'wb.db'))
  const row = db2.prepare("SELECT count(*) c FROM audit_log WHERE tool='workbench_project_cluster'").get()
  assert.ok(row.c >= 2)  // 绑定 + 解绑
  db2.close()
})

// teardown:与 ssh/routes.test.mjs 一致,SIGKILL + rmSync
test.after(() => {
  try { gw.kill('SIGKILL') } catch { /* noop */ }
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ }
})
