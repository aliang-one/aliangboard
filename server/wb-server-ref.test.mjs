// @server 搜索端点集成测试:spawn 真网关(骨架逐字照 wb-project-cluster.test.mjs)。
// 覆盖:server 分支 exposedOnly + name/host/description 三路命中 + host 仅 admin;
// 未绑集群项目可用;K8s 分支 admin 门不回退。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GW_PORT = 55000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-server-ref-'))

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

test('@server 搜索:exposedOnly+三路命中+host 仅 admin;未绑集群可用;K8s 分支门不回退', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }
  // 未绑定集群建项目(clusterId 缺省,wb-project-cluster 特性)
  const proj = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'ref-p' }) })).json()
  const pid = proj.project.id
  // 直插两台服务器:一台 exposed(gw/10.0.0.1),一台未暴露(hidden/10.0.0.2)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  const ins = db.prepare('INSERT INTO ssh_servers (id,name,host,port,username,authMethod,description,clusterRef,exposeToAi,aiApprovalPolicy,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('s1', '网关机', '10.0.0.1', 22, 'ops', 'password', '入口网关', 'ck-t1', 1, 'readonly', 'ok', Date.now(), Date.now())
  ins.run('s2', '隐藏机', '10.0.0.2', 22, 'ops', 'password', '不该出现', '', 0, 'always', 'ok', Date.now(), Date.now())
  db.close()

  // admin:name/host/备注 三路命中;未暴露不可见;host 字段在
  const byName = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('网关')}`, { headers: H })).json()
  assert.equal(byName.items.length, 1); assert.equal(byName.items[0].name, '网关机'); assert.equal(byName.items[0].host, '10.0.0.1')
  const byIp = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: H })).json()
  assert.equal(byIp.items.length, 1)
  const byDesc = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('入口')}`, { headers: H })).json()
  assert.equal(byDesc.items.length, 1)

  // 平台用户:可见 exposed;命中同样工作;响应无 host 字段
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const PH = { 'content-type': 'application/json', 'x-platform-token': plogin.token }
  const pRes = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: PH })).json()
  assert.equal(pRes.items.length, 1)
  assert.equal('host' in pRes.items[0], false, '非 admin 响应不得携带 host')
  const pHidden = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('隐藏')}`, { headers: PH })).json()
  assert.equal(pHidden.items.length, 0, '未暴露服务器不可见')

  // K8s 分支回归:非 admin → 401/403(requireAdmin 仍在);server 分支放行不等于 K8s 分支放行
  const k8sGate = await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=pod&q=x`, { headers: PH })
  assert.ok([401, 403].includes(k8sGate.status))
})

// teardown:与 wb-project-cluster.test.mjs 一致,SIGKILL + rmSync
test.after(() => {
  try { gw.kill('SIGKILL') } catch { /* noop */ }
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ }
})
