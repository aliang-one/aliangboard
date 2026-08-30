// CSO 2026-08-30 #2 回归:/api/k8s 代理目标必须与集群 API Server 同源。
// new URL('//host/x', base) 与解码后的 %2F%2F 都会改写 authority —— 未修前网关会把
// 集群凭证(Bearer token)发往用户指定的任意主机并回传其响应(凭证外带/SSRF)。
// 活体网关测试:起真网关 + 假 apiserver + evil 收集器,走完整 login→connect-cluster 链路。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ports = () => [
  19100 + Math.floor(Math.random() * 900),
  21100 + Math.floor(Math.random() * 900),
  25100 + Math.floor(Math.random() * 4000),
]

async function startGateway(t) {
  const [K8S_PORT, EVIL_PORT, GW_PORT] = ports()
  const DIR = mkdtempSync(join(tmpdir(), 'k8s-origin-'))
  // 假 apiserver:/version 供 connect-cluster 探测,其余路径通配应答(正向对照用)。
  const k8s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.url === '/version' ? '{"gitVersion":"v1.31.4"}' : '{"kind":"Status","status":"Success"}')
  })
  const evilHits = []
  const evil = createServer((req, res) => {
    evilHits.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"pwned":true}')
  })
  await new Promise((r) => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise((r) => evil.listen(EVIL_PORT, '127.0.0.1', r))
  t.after(() => { k8s.close(); evil.close() })

  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      ALIANG_DB: join(DIR, 'o.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'x'.repeat(12),
      ALIANG_STATIC_DIR: DIR,
      ALIANG_WORKBENCH_DIR: join(DIR, 'wb'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => gw.kill('SIGKILL'))

  const base = `http://127.0.0.1:${GW_PORT}`
  // 等网关就绪:轮询 /api/health,不猜固定 sleep。
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      const h = await fetch(`${base}/api/health`)
      if (h.ok) break
    } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error('gateway did not become healthy in 10s')
    await new Promise((r) => setTimeout(r, 150))
  }

  // 登录拿平台 token(契约:POST /api/auth/login → {token})
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }),
  })
  assert.equal(login.status, 200, 'login failed')
  const { token: ptok } = await login.json()

  // 注册集群指向假 apiserver(契约:POST /api/admin/clusters → {cluster:{id}})
  const ac = await fetch(`${base}/api/admin/clusters`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ name: 'c1', apiServer: `http://127.0.0.1:${K8S_PORT}`, authMethod: 'token', token: 'fake-cluster-token' }),
  })
  assert.equal(ac.status, 200, 'cluster add failed')
  const { cluster: { id: clusterId } } = await ac.json()

  // 接入集群拿 k8s 会话 token(契约:POST /api/connect-cluster → {token})
  const cc = await fetch(`${base}/api/connect-cluster`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ clusterId }),
  })
  assert.equal(cc.status, 200, 'connect-cluster failed')
  const { token: k8sTok } = await cc.json()

  return { base, k8sTok, evilHits, EVIL_PORT }
}

test('GET /api/k8s//evil → 403 且 evil 零命中', { timeout: 60000 }, async (t) => {
  const { base, k8sTok, evilHits, EVIL_PORT } = await startGateway(t)
  const r = await fetch(`${base}/api/k8s//127.0.0.1:${EVIL_PORT}/pwn`, {
    headers: { authorization: `Bearer ${k8sTok}` },
  })
  assert.equal(evilHits.length, 0, `evil 收到 ${evilHits.length} 次请求: ${evilHits}`)
  assert.equal(r.status, 403, `status=${r.status}`)
})

test('GET /api/k8s/%2F%2Fevil(编码) → 403 且 evil 零命中', { timeout: 60000 }, async (t) => {
  const { base, k8sTok, evilHits, EVIL_PORT } = await startGateway(t)
  const r = await fetch(`${base}/api/k8s/%2F%2F127.0.0.1%3A${EVIL_PORT}%2Fpwn`, {
    headers: { authorization: `Bearer ${k8sTok}` },
  })
  assert.equal(evilHits.length, 0, `evil 收到 ${evilHits.length} 次请求: ${evilHits}`)
  assert.equal(r.status, 403, `status=${r.status}`)
})

test('正向对照:普通资源路径 → 200 正常代理', { timeout: 60000 }, async (t) => {
  const { base, k8sTok } = await startGateway(t)
  const r = await fetch(`${base}/api/k8s/api/v1/namespaces/default/pods`, {
    headers: { authorization: `Bearer ${k8sTok}` },
  })
  assert.equal(r.status, 200, `status=${r.status}`)
})

// CSO #1 回归:旧直连建会话端点已整体下线,POST /api/session 必 404(表外路由)。
test('POST /api/session 已下线 → 404', { timeout: 60000 }, async (t) => {
  const { base } = await startGateway(t)
  const r = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authMethod: 'token', apiServer: 'http://127.0.0.1:1', token: 'x' }),
  })
  assert.equal(r.status, 404, `status=${r.status}`)
})
