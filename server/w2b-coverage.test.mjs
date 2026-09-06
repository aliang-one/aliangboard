// W2 Phase B (Task 4): 结构性覆盖守卫——锁「网关 K8s 出口全接线」退出判据。
// 读 server/index.mjs 源码,断言每个 K8s 出口锚点之后 30 行内出现 gate 调用
// (gateK8sSession / gateParsedPath / gateWatchResources)。新 outlet 忘接线时本守卫红灯。
// 注意:这是源码断言(防线),不是行为测试——行为由 k8s-gate.test.mjs 矩阵钉住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8')
const lines = src.split('\n')

function assertGateNear(anchor, desc, window = 30) {
  const idx = []
  lines.forEach((l, i) => { if (l.includes(anchor)) idx.push(i) })
  assert.ok(idx.length >= 1, `anchor not found in server/index.mjs: ${anchor} (${desc})`)
  const ok = idx.some(i =>
    lines.slice(i + 1, i + 1 + window).some(l => l.includes('gateK8sSession(') || l.includes('gateParsedPath(') || l.includes('gateWatchResources(')))
  assert.ok(ok, `outlet not gated within ${window} lines: ${desc} (anchor: ${anchor})`)
}

test('coverage: every k8s outlet in server/index.mjs is gated (W2 Phase B)', () => {
  // 透传 / watch / exec-WS(Task 3)
  assertGateNear("startsWith('/api/k8s/')", 'k8s passthrough')
  assertGateNear("pathname === '/api/k8s-watch'", 'watch mux')
  assertGateNear("pathname !== '/api/exec'", 'exec websocket upgrade')
  // body/query 型出口(Task 4,11 处清单)
  assertGateNear("url.pathname === '/api/apply'", 'POST /api/apply')
  assertGateNear("url.pathname === '/api/pod/debug'", 'POST /api/pod/debug')
  assertGateNear("url.pathname === '/api/cronjob/trigger'", 'POST /api/cronjob/trigger')
  assertGateNear("url.pathname === '/api/registry/tags'", 'POST /api/registry/tags')
  assertGateNear("url.pathname === '/api/resource/tree'", 'GET /api/resource/tree')
  assertGateNear("url.pathname === '/api/portforward'", 'POST /api/portforward (create)')
  assertGateNear("startsWith('/api/portforward/')", 'DELETE /api/portforward/:id')
  assertGateNear("startsWith('/api/pvcfile/')", '/api/pvcfile/*')
  assertGateNear("startsWith('/api/podfile/')", '/api/podfile/*')
  assertGateNear("url.pathname === '/api/terminals'", 'POST /api/terminals (create)')
  assertGateNear("startsWith('/api/terminals/')", 'PATCH/DELETE /api/terminals/:id')
  assertGateNear("url.pathname === '/api/file-browsers'", 'POST /api/file-browsers (create)')
})

test('coverage: spoofed impersonation headers are stripped at dispatcher top', () => {
  assert.ok(
    src.includes("k.startsWith('impersonate-') || k.startsWith('x-remote-')"),
    'header-strip loop (impersonate-* / x-remote-*) missing from server/index.mjs',
  )
})

test('coverage: k8s gate instantiated once near authGate', () => {
  assert.ok(src.includes('const k8sGate = createK8sGate({ db, writeAudit })'), 'createK8sGate instantiation missing')
})

test('coverage: namespaces list response filter wired in passthrough response path', () => {
  assert.ok(src.includes('filterNamespaceList(result.body.items'), 'filterNamespaceList not applied to namespaces list response')
})
