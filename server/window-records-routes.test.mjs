// 轮换墓碑 + rekey 授权路由流(2026-09-06 spec §6 第 2 行):spawn 真网关集成测试。
// 夹具复刻 session-lifecycle.test.mjs 的 startGatewayWithCluster 模式(假 apiserver +
// ADMIN_USERNAME/PASSWORD 播种管理员 + connect-cluster 轮换),另以只读 DatabaseSync
// 直查网关临时库,钉住 HTTP 面看不到的 DB 侧事实(rotated_sessions 墓碑行/记录归属)。
//
// 覆盖:① 重连集群(轮换)→ 旧 token 落墓碑且 userId 正确;② 本人新 token 出示旧 token
// → rekey 200 且 terminals 行迁移;③ 他人 token 出示我的轮换 token → 403 且零迁移;
// ④ 未见过 token → 403(unknown-token);附:拒绝路径落 denied 审计。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_PW = 'x'.repeat(12)

async function startGateway(t) {
  const GW_PORT = 28900 + Math.floor(Math.random() * 900)
  const DIR = mkdtempSync(join(tmpdir(), 'wr-routes-'))
  const dbPath = join(DIR, 'o.db')
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      ALIANG_DB: dbPath,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: ADMIN_PW,
      ALIANG_STATIC_DIR: DIR,
      ALIANG_WORKBENCH_DIR: join(DIR, 'wb'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { gw.kill('SIGKILL'); rmSync(DIR, { recursive: true, force: true }) })

  const base = `http://127.0.0.1:${GW_PORT}`
  const deadline = Date.now() + 10000
  for (;;) {
    try { const h = await fetch(`${base}/api/health`); if (h.ok) break } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error('gateway did not become healthy in 10s')
    await new Promise((r) => setTimeout(r, 150))
  }
  const { token: ptok } = await login({ base }, 'admin', ADMIN_PW)
  const g = { base, ptok, dbPath }
  g.adminJson = (method, path, body) => fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return g
}

async function login({ base }, username, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(r.status, 200, `login(${username}) failed: ${r.status}`)
  return r.json()
}

async function createUser(g, username, { password, role } = {}) {
  const pw = password || `pw-${Math.random().toString(36).slice(2, 14)}`
  const r = await g.adminJson('POST', '/api/admin/users', { username, password: pw, role })
  assert.equal(r.status, 200, `create user ${username} failed: ${r.status}`)
  const { user } = await r.json()
  const { token } = await login(g, username, pw)
  return { id: user.id, token, password: pw }
}

// 只读直查网关库:网关是唯一写者,但审计/会话写入瞬时持锁,读侧有界重试防 SQLITE_BUSY。
async function dbGet(dbPath, sql, ...args) {
  for (let i = 0; ; i++) {
    let db = null
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
      return db.prepare(sql).get(...args)
    } catch (e) {
      if (i >= 9) throw e
      await new Promise((r) => setTimeout(r, 100))
    } finally {
      try { db?.close() } catch { /* noop */ }
    }
  }
}

// 假 apiserver:/version 供 connect-cluster 探测,其余通配 200。
// connectCluster(platformToken) → 该平台会话接入集群返回的 k8s token。
async function startGatewayWithCluster(t) {
  const k8s = createServer((req, res) => {
    if (req.url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ gitVersion: 'v1.31.0-fake' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ kind: 'PodList', items: [] }))
  })
  await new Promise((r) => k8s.listen(0, '127.0.0.1', r))
  t.after(() => k8s.close())
  const addr = k8s.address()
  const g = await startGateway(t)
  const r = await g.adminJson('POST', '/api/admin/clusters', {
    name: 'c1', apiServer: `http://127.0.0.1:${addr.port}`, authMethod: 'token', token: 'fake-cluster-token',
  })
  assert.equal(r.status, 200, `register cluster failed: ${r.status}`)
  const { cluster } = await r.json()
  g.connectCluster = async (platformToken) => {
    const cc = await fetch(`${g.base}/api/connect-cluster`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': platformToken || g.ptok },
      body: JSON.stringify({ clusterId: cluster.id }),
    })
    assert.equal(cc.status, 200, `connect-cluster failed: ${cc.status}`)
    return (await cc.json()).token
  }
  return g
}

const rekeyPost = (g, bearer, from) => fetch(`${g.base}/api/terminals/rekey`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ from }),
})

test('轮换→墓碑→rekey:200 迁移 / 他人 403 / 未知 token 403(spec §6 路由流)', { timeout: 60000 }, async (t) => {
  const g = await startGatewayWithCluster(t)
  const me = await (await fetch(`${g.base}/api/auth/me`, { headers: { 'x-platform-token': g.ptok } })).json()
  const adminId = me.user.id

  // 前置:旧 token 名下开一条终端记录(任务栏「记录消失」的迁移前提)
  const t1 = await g.connectCluster()
  const seed = await fetch(`${g.base}/api/terminals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t1}` },
    body: JSON.stringify({ id: 'term-r1', namespace: 'default', podName: 'p1' }),
  })
  assert.equal(seed.status, 200, `seed terminals row failed: ${seed.status}`)

  // 重连集群 → 轮换:先落墓碑再删行(§3)
  const t2 = await g.connectCluster()
  assert.notEqual(t1, t2)

  // ① 墓碑行存在且属主 = 轮换时的平台用户
  const tomb = await dbGet(g.dbPath, 'SELECT userId, rotatedAt FROM rotated_sessions WHERE token = ?', t1)
  assert.ok(tomb, 'rotated_sessions 应有旧 token 的墓碑行')
  assert.equal(tomb.userId, adminId)
  assert.ok(Number.isFinite(tomb.rotatedAt) && tomb.rotatedAt > 0)

  // ③ 他人(admin 亦同罪:属主不同)出示我的轮换 token → 403 且零迁移
  const eve = await createUser(g, 'eve-rkey', { role: 'admin' })
  const tEve = await g.connectCluster(eve.token)
  assert.equal((await rekeyPost(g, tEve, t1)).status, 403)
  assert.equal((await dbGet(g.dbPath, 'SELECT sessionToken s FROM terminals WHERE id = ?', 'term-r1')).s, t1, '他人出示不得迁移')

  // ② 本人新 token 出示旧 token → 200 且记录迁到新 token
  const rekey = await rekeyPost(g, t2, t1)
  assert.equal(rekey.status, 200)
  assert.equal((await rekey.json()).moved.terminals, 1)
  assert.equal((await dbGet(g.dbPath, 'SELECT sessionToken s FROM terminals WHERE id = ?', 'term-r1')).s, t2)
  const listed = await (await fetch(`${g.base}/api/terminals`, { headers: { authorization: `Bearer ${t2}` } })).json()
  assert.ok(listed.terminals.some((x) => x.id === 'term-r1'), '新 token 的任务栏应看到迁移后的记录')

  // ④ 未见过 token → 403(unknown-token)
  assert.equal((await rekeyPost(g, t2, 'never-existed')).status, 403)

  // 附:两条拒绝路径均落 denied 审计(owner-mismatch / unknown-token)
  const denied = await dbGet(g.dbPath, "SELECT COUNT(*) n FROM audit_log WHERE tool = 'terminal_rekey' AND result = 'denied'")
  assert.equal(denied.n, 2)
})
