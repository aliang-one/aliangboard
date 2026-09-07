// W3 Task 6:个人 kubeconfig(/api/k8s-proxy 路由族)。两层:
//   单元层(harness 照 mfa.test.mjs):kubeconfig YAML 形状 / 校验矩阵(404/403/409)/
//     代理会话解析矩阵(401 noClusterSession / 401 sessionExpired / 404 clusterMismatch /
//     命中 → handlePassthrough 收到正确 session 与重写后的 K8s 子路径)。
//   活体层(照 k8s-proxy-origin.test.mjs 起真网关):view 用户经代理 GET 未授权 ns → 403(gate
//     生效证据)/ 授权 ns → 200;强制下线(Task 5 端点)后旧平台 token → 401;浏览器 /api/k8s/*
//     直连回归锚。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createK8sProxyRoutes, buildKubeconfigYaml, resolveProxyK8sSession } from './routes/k8s-proxy.mjs'
import { createAuditSchema } from './audit.mjs'
import { TABLE as KUBECFG_MSG } from './messages/kubecfg.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 单元层 ----------

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL, disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT, mfaPending INTEGER DEFAULT 0, stepUpAt INTEGER)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, apiServer TEXT NOT NULL, userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  createAuditSchema(db)
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','x','user',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('adm','admin','x','admin',1)").run()
  db.prepare("INSERT INTO clusters (id,name,apiServer) VALUES ('c1','prod','http://k8s:6443')").run()
  db.prepare("INSERT INTO clusters (id,name,apiServer) VALUES ('c2','dev','http://k8s2:6443')").run()
  db.prepare("INSERT INTO user_clusters (userId,clusterId) VALUES ('u1','c1')").run()
  db.prepare("INSERT INTO user_clusters (userId,clusterId) VALUES ('u1','c2')").run()
  return db
}

function makeHarness(db, over = {}) {
  const sent = []
  const passthrough = []
  const upstream = []
  const persistedDeletes = []
  const deps = {
    db,
    sendJson: (r, status, json) => sent.push({ status, json }),
    sendText: (r, status, text, extraHeaders) => sent.push({ status, text, contentType: 'text/plain; charset=utf-8', headers: extraHeaders || {} }),
    requirePlatform: (req, res) => {
      const tok = req.headers['x-platform-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '')
      const ps = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(tok)
      if (!ps) { deps.sendJson(res, 401, { message: 'not logged in' }); return null }
      return ps
    },
    extractPlatformToken: (req) => req.headers['x-platform-token'] || (req.headers.authorization && /^Bearer\s+/i.test(req.headers.authorization) ? req.headers.authorization.replace(/^Bearer\s+/i, '') : ''),
    sessions: new Map(),
    handlePassthrough: async (req, res, session, kubernetesPath) => { passthrough.push({ session, kubernetesPath }) },
    // review round 1 I1/I3 注入面:discovery 直读 + 会话守卫复检
    requestKubernetes: async (session, path) => { upstream.push({ session, path }); return { status: 200, body: { kind: 'APIVersions', versions: ['v1'] } } },
    sessionTtl: 8 * 60 * 60 * 1000,
    removePersistedSession: (tok) => persistedDeletes.push(tok),
    ...over,
  }
  const routes = createK8sProxyRoutes(deps)
  const call = (method, path, headers) => routes.handle(
    { method, headers: { 'x-platform-token': 'tok-u1', ...headers }, socket: {}, url: path },
    {}, new URL(path, 'http://gw.example'))
  return { routes, sent, passthrough, upstream, persistedDeletes, call }
}

function connectSeed(db, sessions, { token = 'tok-u1', k8sToken = 'k8s-tok-1', clusterId = 'c1', lastSeenAt = 100, createdAt } = {}) {
  sessions.set(k8sToken, { apiServer: 'http://k8s:6443', userId: 'u1', clusterId, createdAt: createdAt ?? Date.now() })
  db.prepare('UPDATE platform_sessions SET k8sSessionToken=? , lastSeenAt=? WHERE token=?').run(k8sToken, lastSeenAt, token)
}

test('buildKubeconfigYaml:形状钉死(apiVersion/kind/clusters/users/contexts/current-context)', () => {
  const yaml = buildKubeconfigYaml({ clusterName: 'prod', serverUrl: 'http://gw:8787/api/k8s-proxy/c1', username: 'alice', token: 'ptok' })
  assert.match(yaml, /^apiVersion: v1\nkind: Config\n/)
  assert.ok(yaml.includes('name: aliangboard-prod'), 'cluster/context 名 = aliangboard-<cluster.name>')
  assert.ok(yaml.includes('server: "http://gw:8787/api/k8s-proxy/c1"'), 'server 指向网关代理路径(URL 含 :// 走双引号流标量)')
  assert.ok(yaml.includes('user: alice') && yaml.includes('- name: alice'), 'users[].name = 平台 username')
  assert.ok(yaml.includes('token: ptok'), 'token = 平台 token 明文')
  assert.ok(yaml.includes('namespace: default'))
  assert.ok(yaml.includes('current-context: aliangboard-prod'))
})

test('buildKubeconfigYaml:特殊字符名(空格/冒号)走双引号流标量,不破 YAML', () => {
  const yaml = buildKubeconfigYaml({ clusterName: 'my cluster: prod', serverUrl: 'http://gw/x', username: 'a b', token: 't' })
  assert.ok(yaml.includes('name: "aliangboard-my cluster: prod"'))
  assert.ok(yaml.includes('user: "a b"'))
})

test('GET /api/my/kubeconfig:200 text/plain + YAML(server 路径含 clusterId + 请求头平台 token)', async () => {
  const db = makeDb()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-u1','u1','alice','user',1)").run()
  const sessions = new Map()
  const h = makeHarness(db, { sessions })
  connectSeed(db, sessions)
  await h.call('GET', '/api/my/kubeconfig?clusterId=c1')
  assert.equal(h.sent[0].status, 200)
  assert.match(h.sent[0].contentType, /text\/plain; ?charset=utf-8/)
  assert.equal(h.sent[0].headers['cache-control'], 'no-store', '凭据响应禁缓存(review round 1 I2)')
  const yaml = h.sent[0].text
  assert.ok(yaml.includes('/api/k8s-proxy/c1'), 'server 路径带 clusterId')
  assert.ok(yaml.includes('token: tok-u1'), 'token = 请求头平台 token')
  assert.ok(yaml.includes('name: aliangboard-prod'))
})

test('GET /api/my/kubeconfig 校验矩阵:未连集群/连的是别的集群 → 409;未分配集群 → 403;集群不存在 → 404', async () => {
  const db = makeDb()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-u1','u1','alice','user',1)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-bob','u2','bob','user',1)").run()
  const sessions = new Map()
  const h = makeHarness(db, { sessions })
  // bob 未分配任何集群
  await h.call('GET', '/api/my/kubeconfig?clusterId=c1', { 'x-platform-token': 'tok-bob' })
  assert.equal(h.sent[0].status, 403)
  // alice 已分配但未连接(无 k8sSessionToken)→ 409
  await h.call('GET', '/api/my/kubeconfig?clusterId=c1')
  assert.equal(h.sent[1].status, 409)
  assert.equal(h.sent[1].json.message, KUBECFG_MSG['kubecfg.noClusterSession'].zh, '409 文案=请先在平台连接该集群')
  // alice 连了 c1,但请求 c2 的 kubeconfig → 409(活跃会话不属于该集群)
  connectSeed(db, sessions)
  await h.call('GET', '/api/my/kubeconfig?clusterId=c2')
  assert.equal(h.sent[2].status, 409)
  // 集群不存在 → 404
  await h.call('GET', '/api/my/kubeconfig?clusterId=nope')
  assert.equal(h.sent[3].status, 404)
})

test('resolveProxyK8sSession:多平台会话取 lastSeenAt 最新带 k8sSessionToken 的行', () => {
  const db = makeDb()
  const sessions = new Map([['k8s-new', { userId: 'u1', clusterId: 'c1' }], ['k8s-old', { userId: 'u1', clusterId: 'c2' }]])
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,lastSeenAt,k8sSessionToken) VALUES ('t-old','u1','alice','user',1,100,'k8s-old')").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,lastSeenAt,k8sSessionToken) VALUES ('t-new','u1','alice','user',1,200,'k8s-new')").run()
  const r = resolveProxyK8sSession({ db, sessions }, 'u1', 'c1')
  assert.equal(r.session.clusterId, 'c1', '命中最新(200)行的 k8s-new')
  assert.equal(resolveProxyK8sSession({ db, sessions }, 'u1', 'c2').error, 'cluster-mismatch')
})

test('代理解析矩阵:无行 → 401 noClusterSession;行在 Map 无 → 401 sessionExpired;clusterId 不符 → 404 clusterMismatch;命中 → handlePassthrough(session, 重写子路径+query)', async () => {
  const db = makeDb()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-u1','u1','alice','user',1)").run()
  const sessions = new Map()
  const h = makeHarness(db, { sessions })
  // ① 从未连接 → 401
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.sent[0].status, 401)
  assert.equal(h.sent[0].json.message, KUBECFG_MSG['kubecfg.noClusterSession'].zh)
  // ② k8sSessionToken 行在、sessions Map 无(过期/级联吊销)→ 401
  db.prepare('UPDATE platform_sessions SET k8sSessionToken=? WHERE token=?').run('k8s-gone', 'tok-u1')
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.sent[1].status, 401)
  assert.equal(h.sent[1].json.message, KUBECFG_MSG['kubecfg.sessionExpired'].zh)
  // ③ 会话属于别的集群 → 404
  sessions.set('k8s-tok-1', { userId: 'u1', clusterId: 'c2' })
  db.prepare('UPDATE platform_sessions SET k8sSessionToken=? WHERE token=?').run('k8s-tok-1', 'tok-u1')
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.sent[2].status, 404)
  assert.equal(h.sent[2].json.message, KUBECFG_MSG['kubecfg.clusterMismatch'].zh)
  // ④ 命中 → 复用注入的透传管线,子路径重写 + query 保留
  sessions.set('k8s-tok-1', { userId: 'u1', clusterId: 'c1' })
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods?limit=5')
  assert.equal(h.sent.length, 3, '不再有额外 sendJson —— 直接交给透传')
  assert.equal(h.passthrough.length, 1)
  assert.equal(h.passthrough[0].session.userId, 'u1')
  assert.equal(h.passthrough[0].session.clusterId, 'c1')
  assert.equal(h.passthrough[0].kubernetesPath, '/api/v1/namespaces/default/pods?limit=5', '子路径=去 /api/k8s-proxy/:clusterId 前缀 + 原样 query')
  // ⑤ kubectl 形态:Authorization Bearer 平台 token 同样可解析
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/pods', { 'x-platform-token': '', authorization: 'Bearer tok-u1' })
  assert.equal(h.passthrough.length, 2, 'Bearer 平台 token 命中同一解析路径')
})

// ---------- review round 1 ----------

// I1(controller ruling):四个 discovery 根路径(GET /api、/apis、/api/v1、/apis/<g>/<v>)在
// **仅代理面**放行——集群元数据读(kubectl 先决条件),直读 requestKubernetes 不过透传门
// (parseApiPath 不认这些形状,走门必 403 unparseable-path);ns 资源路径照旧全走透传门。
test('I1 discovery 根放行(仅代理面):GET /api、/apis、/api/v1、/apis/apps/v1 → 直读上游 200;ns 路径仍走透传门', async () => {
  const db = makeDb()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-u1','u1','alice','user',1)").run()
  const sessions = new Map()
  const h = makeHarness(db, { sessions })
  connectSeed(db, sessions)
  for (const p of ['/api/k8s-proxy/c1/api', '/api/k8s-proxy/c1/apis', '/api/k8s-proxy/c1/api/v1', '/api/k8s-proxy/c1/apis/apps/v1']) {
    await h.call('GET', p)
  }
  assert.equal(h.sent.length, 4)
  for (const r of h.sent) {
    assert.equal(r.status, 200)
    assert.equal(r.json.kind, 'APIVersions', '上游 body 原样透传')
  }
  assert.deepEqual(h.upstream.map((u) => u.path), ['/api', '/apis', '/api/v1', '/apis/apps/v1'], '直读上游且子路径重写正确')
  assert.equal(h.passthrough.length, 0, 'discovery 不经透传门(否则 unparseable 403)')
  // ns 资源路径不受放行影响:仍交给透传管线(ns 授权门在彼处执法)
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.passthrough.length, 1)
  assert.equal(h.upstream.length, 4, 'ns 路径不走直读')
  // 非 GET 的 discovery 形状不放行(交给透传门照旧拒)
  await h.call('POST', '/api/k8s-proxy/c1/api')
  assert.equal(h.passthrough.length, 2, 'POST /api 走透传门(parseApiPath null → 403)')
})

// I3:代理解析补 sessionFromRequest 同款逐请求复检——TTL 过期(先落轮换墓碑)与归属失效
// (禁用/删除/失配集群分配)都视为死会话,当场从内存 Map + 持久层移除,不留僵尸。
test('I3 会话守卫:TTL 过期 → 401 sessionExpired + Map/持久层移除;属主被禁用 → 同款处置', async () => {
  const db = makeDb()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES ('tok-u1','u1','alice','user',1)").run()
  const sessions = new Map()
  const h = makeHarness(db, { sessions })
  // ① TTL 过期(createdAt = 9h 前 > 8h)
  connectSeed(db, sessions, { k8sToken: 'k8s-old', createdAt: Date.now() - 9 * 60 * 60 * 1000 })
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.sent[0].status, 401)
  assert.equal(h.sent[0].json.message, KUBECFG_MSG['kubecfg.sessionExpired'].zh)
  assert.equal(sessions.has('k8s-old'), false, '过期会话当场从内存移除')
  assert.deepEqual(h.persistedDeletes, ['k8s-old'], '持久层同步移除')
  assert.equal(h.upstream.length, 0, '死会话不触上游')
  assert.equal(h.passthrough.length, 0)
  // ② 属主被禁用(平台 token 仍在 → 解析层兜底拦截,与 sessionFromRequest 同语义)
  connectSeed(db, sessions, { k8sToken: 'k8s-disabled' })
  db.prepare('UPDATE platform_users SET disabled=1 WHERE id=?').run('u1')
  await h.call('GET', '/api/k8s-proxy/c1/api/v1/namespaces/default/pods')
  assert.equal(h.sent[1].status, 401)
  assert.equal(h.sent[1].json.message, KUBECFG_MSG['kubecfg.sessionExpired'].zh)
  assert.equal(sessions.has('k8s-disabled'), false, '归属失效会话同样移除')
  assert.deepEqual(h.persistedDeletes, ['k8s-old', 'k8s-disabled'])
})

// ---------- 活体层 ----------

const ports = () => [
  26100 + Math.floor(Math.random() * 900),
  27100 + Math.floor(Math.random() * 900),
  28100 + Math.floor(Math.random() * 4000),
]

async function startGateway(t) {
  const [K8S_PORT, GW_PORT] = ports()
  const DIR = mkdtempSync(join(tmpdir(), 'k8s-kubecfg-'))
  const k8s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/version') return res.end('{"gitVersion":"v1.31.4"}')
    if (req.url === '/api' || req.url.split('?')[0] === '/api') return res.end('{"kind":"APIVersions","versions":["v1"]}')
    res.end('{"kind":"PodList","apiVersion":"v1","items":[]}')
  })
  await new Promise((r) => k8s.listen(K8S_PORT, '127.0.0.1', r))
  t.after(() => { k8s.close(); try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ } })

  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      ALIANG_DB: join(DIR, 'k.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'x'.repeat(12),
      ALIANG_STATIC_DIR: DIR,
      ALIANG_WORKBENCH_DIR: join(DIR, 'wb'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => gw.kill('SIGKILL'))

  const base = `http://127.0.0.1:${GW_PORT}`
  const deadline = Date.now() + 10000
  for (;;) {
    try { const h = await fetch(`${base}/api/health`); if (h.ok) break } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error('gateway did not become healthy in 10s')
    await new Promise((r) => setTimeout(r, 150))
  }

  const json = (path, init) => fetch(`${base}${path}`, init).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.json().catch(() => null) }))
  const adminLogin = await json('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })
  const adminTok = adminLogin.body.token
  const adminHdr = { 'content-type': 'application/json', 'x-platform-token': adminTok }

  // 集群(allowlist)+ 普通用户 view(仅 ns=allowed)
  const ac = await json('/api/admin/clusters', { method: 'POST', headers: adminHdr, body: JSON.stringify({ name: 'kubecfg-live', apiServer: `http://127.0.0.1:${K8S_PORT}`, authMethod: 'token', token: 'fake' }) })
  const clusterId = ac.body.cluster.id
  await json(`/api/admin/clusters/${clusterId}/ns-auth-mode`, { method: 'PUT', headers: adminHdr, body: JSON.stringify({ mode: 'allowlist' }) })
  await json('/api/admin/users', { method: 'POST', headers: adminHdr, body: JSON.stringify({ username: 'viewer', password: 'v'.repeat(12), role: 'user' }) })
  const users = await json('/api/admin/users', { headers: adminHdr })
  const viewer = users.body.users.find((u) => u.username === 'viewer')
  await json(`/api/admin/users/${viewer.id}/clusters`, { method: 'PUT', headers: adminHdr, body: JSON.stringify({ clusterIds: [clusterId] }) })
  await json('/api/admin/grants', { method: 'PUT', headers: adminHdr, body: JSON.stringify({ subjectType: 'user', subjectId: viewer.id, clusterId, namespaces: [{ namespace: 'allowed', level: 'view' }] }) })

  const viewerLogin = await json('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'v'.repeat(12) }) })
  const viewerTok = viewerLogin.body.token
  const viewerHdr = { 'content-type': 'application/json', 'x-platform-token': viewerTok }
  const cc = await json('/api/connect-cluster', { method: 'POST', headers: viewerHdr, body: JSON.stringify({ clusterId }) })
  assert.equal(cc.status, 200, 'viewer connect-cluster failed')
  const k8sTok = cc.body.token

  return { base, clusterId, viewerId: viewer.id, viewerTok, k8sTok, adminHdr, json }
}

test('代理面 ns 门生效:view 用户经 /api/k8s-proxy GET 未授权 ns → 403;授权 ns → 200;kubeconfig YAML 形状;强制下线后旧平台 token → 401;/api/k8s 直连回归锚', { timeout: 90000 }, async (t) => {
  const { base, clusterId, viewerId, viewerTok, k8sTok, json } = await startGateway(t)

  // ① gate 生效证据:未授权 ns → 403(与 /api/k8s 同一门)
  const denied = await fetch(`${base}/api/k8s-proxy/${clusterId}/api/v1/namespaces/forbidden/pods`, { headers: { authorization: `Bearer ${viewerTok}` } })
  assert.equal(denied.status, 403, `unauthorized ns via proxy: ${denied.status}`)

  // ② 授权 ns → 200(上游 PodList 透传)
  const ok = await fetch(`${base}/api/k8s-proxy/${clusterId}/api/v1/namespaces/allowed/pods`, { headers: { authorization: `Bearer ${viewerTok}` } })
  assert.equal(ok.status, 200, `authorized ns via proxy: ${ok.status}`)
  assert.equal((await ok.json()).kind, 'PodList')

  // ②b(review round 1 I1 裁决):discovery 根在代理面放行——allowlist 普通用户 GET /api
  //     也能拿集群元数据(kubectl 先决条件;浏览器 /api/k8s 面照旧拒,不在此测——见 route 层)
  const disc = await fetch(`${base}/api/k8s-proxy/${clusterId}/api`, { headers: { authorization: `Bearer ${viewerTok}` } })
  assert.equal(disc.status, 200, `discovery root via proxy: ${disc.status}`)
  assert.equal((await disc.json()).kind, 'APIVersions')

  // ③ kubeconfig:平台 token 下发 YAML(text/plain),server 指向代理路径,token=平台 token
  const kcfg = await fetch(`${base}/api/my/kubeconfig?clusterId=${clusterId}`, { headers: { 'x-platform-token': viewerTok } })
  assert.equal(kcfg.status, 200)
  assert.match(kcfg.headers.get('content-type') || '', /text\/plain/)
  const yaml = await kcfg.text()
  assert.ok(yaml.includes(`/api/k8s-proxy/${clusterId}`), `server path: ${yaml}`)
  assert.ok(yaml.includes(`token: ${viewerTok}`), 'token = 平台 token 明文')
  assert.ok(yaml.includes('name: aliangboard-kubecfg-live'))

  // ④ 回归锚(须在强制下线之前 —— revokeUserSessions 级联连 k8s 凭据一并吊销,是设计行为):
  //    浏览器 /api/k8s/* 直连(k8s session token)不受透传管线抽取重构影响 → 200
  const direct = await fetch(`${base}/api/k8s/api/v1/namespaces/allowed/pods`, { headers: { authorization: `Bearer ${k8sTok}` } })
  assert.equal(direct.status, 200, `/api/k8s regression anchor: ${direct.status}`)

  // ⑤ 强制下线(W3 Task 5 端点)后:旧平台 token 走代理 → 401(平台会话死亡,级联含 k8s 凭据)
  const adminTokJson = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) }).then((r) => r.json())
  const kill = await fetch(`${base}/api/admin/sessions/${viewerId}`, { method: 'DELETE', headers: { 'x-platform-token': adminTokJson.token } })
  assert.equal(kill.status, 200)
  const after = await fetch(`${base}/api/k8s-proxy/${clusterId}/api/v1/namespaces/allowed/pods`, { headers: { authorization: `Bearer ${viewerTok}` } })
  assert.equal(after.status, 401, `revoked platform token via proxy: ${after.status}`)
})
