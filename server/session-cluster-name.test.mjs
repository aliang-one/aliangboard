// 会话端点集群 name 下发(2026-09-10 issue#8 修复):
// POST /api/connect-cluster 与 GET /api/session 的 cluster 对象都须携带 DB 里的集群名,
// 前端以它为集群身份展示(此前只回 apiServer → 前端 hostname 兜底 → 全 UI 显示 IP)。
// 活网关端到端:假 apiserver 答 /version;admin 建集群(别名 prod-alias)→ 连接 → 双端点断言。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_PW = 'x'.repeat(12)

async function startFakeApiserver(t) {
  const srv = createServer((req, res) => {
    if (req.url === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ gitVersion: 'v1.30.1' })); return }
    res.writeHead(404); res.end('{}')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => srv.close(r)))
  return `http://127.0.0.1:${srv.address().port}`
}

async function startGateway(t) {
  // 端口区间避开 session-lifecycle.test.mjs 的 26100 段:node --test 并行跑文件,同段会间歇 EADDRINUSE
  const GW_PORT = 29100 + Math.floor(Math.random() * 2000)
  const DIR = mkdtempSync(join(tmpdir(), 'sess-name-'))
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'o.db'),
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: ADMIN_PW,
      ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { gw.kill('SIGKILL'); rmSync(DIR, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${GW_PORT}`
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PW }) })
  const ptok = (await login.json()).token
  const json = (method, path, body, headers = {}) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-platform-token': ptok, ...headers }, body: body ? JSON.stringify(body) : undefined })
  return { base, json }
}

test('connect-cluster 与 GET /api/session 均下发集群 name', { timeout: 60000 }, async t => {
  const api = await startFakeApiserver(t)
  const g = await startGateway(t)
  const created = await (await g.json('POST', '/api/admin/clusters', { name: 'prod-alias', authMethod: 'token', apiServer: api, token: 'fake-token' })).json()
  assert.equal(created.cluster.name, 'prod-alias')   // (既有行为,顺带锁)

  const conn = await (await g.json('POST', '/api/connect-cluster', { clusterId: created.cluster.id })).json()
  assert.equal(conn.cluster.name, 'prod-alias')      // 本修复主断言 ①

  const sess = await (await fetch(`${g.base}/api/session`, { headers: { authorization: `Bearer ${conn.token}` } })).json()
  assert.equal(sess.cluster.name, 'prod-alias')      // 本修复主断言 ②
  assert.equal(sess.cluster.apiServer, api)

  const my = await (await g.json('GET', '/api/my-clusters')).json()
  // 两端点 apiServer 形态永不漂移(尾斜杠归一,前端守卫按全等比较)
  assert.equal(my.clusters[0].apiServer, conn.cluster.apiServer)
})
