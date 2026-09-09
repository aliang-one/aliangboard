// API JSON 响应 gzip 活体测试(2026-09-09 LCP 5.96s / 首屏慢根因修复):
// 平台 JSON 与缓冲式 K8s 透传( pods?limit=1000 实测 1MB / nodes 80KB )全走 sendJson 单点,
// 曾全程零压缩裸传——慢无线腿上背景刷新与首屏数据互踩。锁定:大 JSON 按 Accept-Encoding 压缩,
// 小 JSON 阈值豁免,流式透传(watch/follow)永不被压缩。
// 活体层照 k8s-proxy-origin.test.mjs:起真网关 + 假 apiserver,原生 http.get 抓 wire 字节
// (fetch/undici 会自动解压,看不到线上真相)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// >1KB 的大 pods 列表(过最小压缩阈值;pad 走 annotations,slimListBody 不剥)
const BIG_PODS = JSON.stringify({
  kind: 'PodList', apiVersion: 'v1',
  items: [{ metadata: { name: 'p1', annotations: { pad: 'x'.repeat(8192) } }, spec: {}, status: { phase: 'Running' } }],
})

// 原生 http.get:不做自动解压,headers/body 均为 wire 原貌。
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
  })
}

let base, k8sTok, DIR, gw, k8s

test('setup 起真网关 + 假 apiserver', { timeout: 60000 }, async (t) => {
  const K8S_PORT = 18100 + Math.floor(Math.random() * 900)
  const GW_PORT = 22100 + Math.floor(Math.random() * 900)
  DIR = mkdtempSync(join(tmpdir(), 'api-gzip-'))
  k8s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.url === '/version' ? '{"gitVersion":"v1.31.4"}' : BIG_PODS)
  })
  await new Promise((r) => k8s.listen(K8S_PORT, '127.0.0.1', r))
  // 注意:不能用 t.after —— 它在 setup 测试结束即触发,会把网关杀掉(后续用例全 ECONNREFUSED)。
  // teardown 放文件末尾的独立测试(照 static.test.mjs 模式)。

  gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      ALIANG_DB: join(DIR, 'g.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'x'.repeat(12),
      ALIANG_STATIC_DIR: DIR,
      ALIANG_WORKBENCH_DIR: join(DIR, 'wb'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  base = `http://127.0.0.1:${GW_PORT}`
  const deadline = Date.now() + 10000
  for (;;) {
    try { const h = await fetch(`${base}/api/health`); if (h.ok) break } catch { /* 未起 */ }
    if (Date.now() > deadline) throw new Error('gateway did not become healthy in 10s')
    await new Promise((r) => setTimeout(r, 150))
  }

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }),
  })
  assert.equal(login.status, 200)
  const { token: ptok } = await login.json()
  const ac = await fetch(`${base}/api/admin/clusters`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ name: 'c1', apiServer: `http://127.0.0.1:${K8S_PORT}`, authMethod: 'token', token: 't' }),
  })
  assert.equal(ac.status, 200)
  const { cluster: { id: clusterId } } = await ac.json()
  const cc = await fetch(`${base}/api/connect-cluster`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-token': ptok },
    body: JSON.stringify({ clusterId }),
  })
  assert.equal(cc.status, 200)
  k8sTok = (await cc.json()).token
})

test('GET /api/k8s 大列表 + Accept-Encoding: gzip → wire 上是 gzip 且解压还原', { timeout: 30000 }, async () => {
  const r = await rawGet(`${base}/api/k8s/api/v1/pods`, { authorization: `Bearer ${k8sTok}`, 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], 'gzip', '大 JSON 必须压缩')
  assert.equal(r.headers['vary'], 'accept-encoding')
  const restored = JSON.parse(gunzipSync(r.body).toString('utf8'))
  assert.equal(restored.kind, 'PodList')
  assert.equal(restored.items[0].metadata.name, 'p1')
  assert.ok(r.body.length < Buffer.byteLength(BIG_PODS), 'wire 字节必须小于原文')
})

test('GET /api/k8s 大列表无 Accept-Encoding → 原样 JSON(老客户端兼容)', { timeout: 30000 }, async () => {
  const r = await rawGet(`${base}/api/k8s/api/v1/pods`, { authorization: `Bearer ${k8sTok}` })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], undefined)
  assert.equal(JSON.parse(r.body.toString('utf8')).kind, 'PodList')
})

test('小 JSON(/api/health)+ gzip → 阈值豁免不压缩', { timeout: 30000 }, async () => {
  const r = await rawGet(`${base}/api/health`, { 'accept-encoding': 'gzip' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], undefined, '小响应压缩开销大于收益')
})

test('流式透传 ?watch=true → 永不压缩(直 pipe,压缩会破坏 watch 流)', { timeout: 30000 }, async () => {
  const r = await rawGet(`${base}/api/k8s/api/v1/pods?watch=true`, { authorization: `Bearer ${k8sTok}`, 'accept-encoding': 'gzip, deflate, br' })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-encoding'], undefined, 'watch 流必须原样透传')
  assert.equal(JSON.parse(r.body.toString('utf8')).kind, 'PodList')
})

test('teardown(api-gzip)', () => {
  try { k8s.close() } catch { /* 已关 */ }
  try { gw.kill('SIGKILL') } catch { /* 已退 */ }
  rmSync(DIR, { recursive: true, force: true })
})
