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

// ===== final-review 修订(2026-09-06)结构防线 =====
const gateSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'k8s-gate.mjs'), 'utf8')

test('coverage: M1 — unparseable-path denial is audited in gateParsedPath', () => {
  assert.ok(gateSrc.includes("'unparseable-path'"), 'k8s-gate.mjs must audit unparseable-path denials')
  assert.ok(gateSrc.includes('gate.noteUnparseable?.(session'), 'gateParsedPath must call noteUnparseable on !parsed')
})

test('coverage: I1 — gateParsedPath has no clusterScope GET-pass bypass (all shapes go through gateK8sSession)', () => {
  assert.ok(!gateSrc.includes("method === 'GET' || method === 'HEAD'"), 'gateParsedPath must not bypass clusterScope GETs (spec §2.4)')
})

// ===== W2 Phase E(PE-A Task 2):impersonation egress 注入结构防线 =====
// 身份归真的收口形状:requestOnce(缓冲出站唯一收口)+ 流式透传分支 + watch-mux fetchUpstream
// 三处 kubeFetch 必须走 injectImpersonation(probe-gated);exec/portforward 走 client-node,
// **不注入**(final-review Critical 3 裁决:client-node 仅支持 Impersonate-User 单头,而集群侧
// 只供给 Group 绑定——注入 user-only 身份在 enable 后处处 403;归因缺口记账于 spec 附录 C.5)。
// 行为矩阵由 impersonate.test.mjs 钉住;此处只锁「网关 K8s 出口全接线」不回退。

function assertNear(anchor, needle, desc, window = 40) {
  const idx = lines.findIndex(l => l.includes(anchor))
  assert.ok(idx >= 0, `anchor not found in server/index.mjs: ${anchor} (${desc})`)
  assert.ok(
    lines.slice(idx, idx + window).some(l => l.includes(needle)),
    `${desc}: '${needle}' not found within ${window} lines of '${anchor}'`,
  )
}

test('coverage: requestOnce injects probe-gated impersonation (W2 Phase E single egress point)', () => {
  assertNear('async function requestOnce(', 'injectImpersonation(', 'requestOnce injection')
  assert.ok(src.includes('const impersonationProbe = createImpersonationProbe('), 'probe not constructed at module scope')
  assert.ok(src.includes('impersonationProbe.isProbed('), 'probe gate (isProbed) not wired')
})

test('coverage: streaming passthrough and watch-mux upstream carry impersonation injection', () => {
  assertNear('const isStreaming = req.method ===', 'injectImpersonation(', 'streaming (?watch/?follow) passthrough')
  assertNear('const fetchUpstream = ', 'injectImpersonation(', 'watch-mux fetchUpstream', 16)
})

test('coverage: exec/portforward client-node paths do NOT inject impersonateUser (final-review Critical 3)', () => {
  const i = lines.findIndex(l => l.includes('function buildKubeConfig('))
  assert.ok(i >= 0, 'buildKubeConfig not found in server/index.mjs')
  const body = lines.slice(i, i + 40).join('\n')
  assert.ok(
    !/\bimpersonateUser\b/.test(body),
    'buildKubeConfig must not set user.impersonateUser: client-node is user-only, cluster bindings are Group-subject — injecting breaks exec/pf with 403 on enable',
  )
  assert.ok(body.includes('归因缺口'), 'buildKubeConfig must document the attribution gap (spec appendix C.5)')
})

test('coverage: probe request is marker-gated out of injectImpersonation (final-review Critical 1 belt-and-braces)', () => {
  assertNear('async function requestOnce(', 'injectImpersonation(headers, session, init)', 'requestOnce passes init into injectImpersonation')
  assertNear('function injectImpersonation(', '__impersonationProbe', 'probe-marker early return', 12)
  assert.ok(impSrc.includes('__impersonationProbe'), 'runProbe must mark its own request with __impersonationProbe')
})

test('coverage: loadPersistedSessions rebuilds impersonation identity from userId', () => {
  assert.ok(src.includes('buildImpersonation(db, r.userId)'), 'startup rebuild of session.impersonate missing')
})

test('coverage: connect-cluster probe wiring passes the shared probe into auth routes', () => {
  assertNear('const authRoutes = createAuthRoutes({', 'impersonationProbe', 'auth routes deps', 20)
})

// ===== W2 Phase E(review round 1)修订防线 =====
const impSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'impersonate.mjs'), 'utf8')

test('coverage: egress merge goes through the canonical impersonateHeadersFor builder (brief letter)', () => {
  // brief 字面要求「requestOnce 含 impersonateHeadersFor( 调用」——实现经 injectImpersonation →
  // mergeImpersonate 间接到达;此处锁链路末端:mergeImpersonate 函数体必须调用 impersonateHeadersFor。
  const m = impSrc.indexOf('export function mergeImpersonate')
  const body = impSrc.slice(m, impSrc.indexOf('\n}', m))
  assert.ok(m >= 0 && body.includes('impersonateHeadersFor('), 'mergeImpersonate must derive headers via impersonateHeadersFor(')
})

test('coverage: impersonation.enabled kill-switch gates the probe (default off)', () => {
  assert.ok(impSrc.includes("'impersonation.enabled'"), 'probe must read the impersonation.enabled setting')
  assert.ok(
    src.includes('createImpersonationProbe({ requestKubernetes, getSetting })'),
    'index.mjs must pass getSetting into the probe factory',
  )
})

test('coverage: SSRR probe body carries the required spec.namespace (400-proof)', () => {
  assert.ok(impSrc.includes("spec: { namespace: 'default' }"), 'SSRR probe body must include required spec.namespace')
})
