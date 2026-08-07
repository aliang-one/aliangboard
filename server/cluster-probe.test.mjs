// 集群列表探测单测(node:test,零新依赖)。
// 锁定:createClusterProber 的健康/断连判定、计数超时降级、TTL 缓存命中与过期、invalidate、force 刷新。
// requestFn / now 全部注入,不触真实 K8s。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createClusterProber } from './cluster-probe.mjs'

// 计数路径用极小超时,以便真实 setTimeout 触发降级而测试仍快。
const FAST_TIMEOUT = 20

// 构造按 path 返回 canned 响应的 mock requestFn;可指定某些 path 抛错 / 延迟。
function mockRequestFn({ version = 'v1.30.0', nodes = 3, pods = 42, fail = {}, delay = {} } = {}) {
  const calls = []
  const fn = async (_ctx, path) => {
    calls.push(path)
    if (delay[path]) await new Promise(r => setTimeout(r, delay[path]))
    if (fail[path]) throw Object.assign(new Error('boom'), { status: 503 })
    if (path === '/version') return { body: { gitVersion: version } }
    if (path === '/api/v1/nodes') return { body: { items: Array.from({ length: nodes }) } }
    if (path === '/api/v1/pods') return { body: { items: Array.from({ length: pods }) } }
    return { body: {} }
  }
  fn.calls = calls
  return fn
}

const buildCtx = (row) => ({ id: row.id }) // ctx 内容对 mock 无意义,仅传递身份

test('健康集群:status=Healthy + 合并 version/nodeCount/podCount,保留 DB 行既有字段', async () => {
  const rf = mockRequestFn()
  const prober = createClusterProber({ requestFn: rf })
  const rows = [{ id: 'c1', name: 'prod', apiServer: 'https://1.1.1.1', version: 'v1.28.0', authHeader: 'Bearer x' }]
  const out = await prober.probeAll(rows, buildCtx)
  assert.equal(out[0].status, 'Healthy')
  assert.equal(out[0].version, 'v1.30.0', '版本应被实时探测值覆盖')
  assert.equal(out[0].nodeCount, 3)
  assert.equal(out[0].podCount, 42)
  assert.equal(out[0].name, 'prod', 'DB 行原有字段保留')
  assert.equal(out[0].apiServer, 'https://1.1.1.1')
  assert.deepEqual(rf.calls.sort(), ['/api/v1/nodes', '/api/v1/pods', '/version'], '健康集群应探三个端点')
})

test('断连集群(版本探测失败):status=Disconnected + 计数为 null + 不再探 nodes/pods', async () => {
  const rf = mockRequestFn({ fail: { '/version': true } })
  const prober = createClusterProber({ requestFn: rf })
  const out = await prober.probeAll([{ id: 'c2', name: 'dead', version: 'v1.20.0' }], buildCtx)
  assert.equal(out[0].status, 'Disconnected')
  assert.equal(out[0].nodeCount, null)
  assert.equal(out[0].podCount, null)
  assert.equal(out[0].version, 'v1.20.0', '失败时回退 DB 旧版本')
  assert.ok(rf.calls.every(p => p !== '/api/v1/nodes' && p !== '/api/v1/pods'), '断连不应再打 nodes/pods')
})

test('版本探测超时(>timeout):降级 Disconnected', async () => {
  const rf = mockRequestFn({ delay: { '/version': FAST_TIMEOUT * 4 } })
  const prober = createClusterProber({ requestFn: rf, timeout: FAST_TIMEOUT })
  const out = await prober.probeAll([{ id: 'c3', name: 'slow', version: null }], buildCtx)
  assert.equal(out[0].status, 'Disconnected')
  assert.equal(out[0].version, null)
})

test('健康但 pod 计数超时:podCount 降级 null,nodeCount 仍取到', async () => {
  const rf = mockRequestFn({ delay: { '/api/v1/pods': FAST_TIMEOUT * 4 } })
  const prober = createClusterProber({ requestFn: rf, timeout: FAST_TIMEOUT })
  const out = await prober.probeAll([{ id: 'c4', name: 'big', version: 'v1' }], buildCtx)
  assert.equal(out[0].status, 'Healthy')
  assert.equal(out[0].nodeCount, 3, 'nodes 正常')
  assert.equal(out[0].podCount, null, 'pods 超时降级 null')
})

test('多集群并行:全部探测(独立状态)', async () => {
  let n = 0
  const rf = async (_ctx, path) => {
    if (path === '/version') { n++; return { body: { gitVersion: 'v9' } } }
    if (path === '/api/v1/nodes') return { body: { items: [{}, {}] } }
    if (path === '/api/v1/pods') return { body: { items: [{}] } }
  }
  const prober = createClusterProber({ requestFn: rf })
  const out = await prober.probeAll([{ id: 'a', name: 'a', version: 'v' }, { id: 'b', name: 'b', version: 'v' }], buildCtx)
  assert.equal(n, 2, '两个集群各探一次 /version')
  assert.equal(out.length, 2)
  assert.ok(out.every(c => c.status === 'Healthy' && c.nodeCount === 2))
})

test('TTL 缓存:窗口内第二次 probeAll 不再调 requestFn', async () => {
  const rf = mockRequestFn()
  const prober = createClusterProber({ requestFn: rf, ttl: 1000 })
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx)
  const firstCalls = rf.calls.length
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx)
  assert.equal(rf.calls.length, firstCalls, 'TTL 内命中缓存,零额外调用')
})

test('TTL 过期:推进 now 后重新探测', async () => {
  let tick = 1000
  const rf = mockRequestFn()
  const prober = createClusterProber({ requestFn: rf, ttl: 1000, now: () => tick })
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx)
  const firstCalls = rf.calls.length
  tick += 2000 // 越过 TTL
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx)
  assert.ok(rf.calls.length > firstCalls, 'TTL 过期后重新探测')
})

test('invalidate(id):仅清该集群,下次重探', async () => {
  const rf = mockRequestFn()
  const prober = createClusterProber({ requestFn: rf })
  await prober.probeAll([{ id: 'c1', name: 'a', version: 'v' }, { id: 'c2', name: 'b', version: 'v' }], buildCtx)
  assert.equal(prober._cacheSizeForTest(), 2)
  prober.invalidate('c1')
  assert.equal(prober._cacheSizeForTest(), 1)
  const before = rf.calls.length
  await prober.probeAll([{ id: 'c1', name: 'a', version: 'v' }], buildCtx)
  assert.ok(rf.calls.length > before, 'invalidate 后该集群重新探测')
})

test('force=true:强制清缓存全量重探', async () => {
  const rf = mockRequestFn()
  const prober = createClusterProber({ requestFn: rf })
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx)
  const before = rf.calls.length
  await prober.probeAll([{ id: 'c', name: 'c', version: 'v' }], buildCtx, { force: true })
  assert.ok(rf.calls.length > before, 'force 绕过缓存重新探测')
})

test('requestFn 缺失:构造即抛(契约校验)', () => {
  assert.throws(() => createClusterProber({}), /requestFn 必传/)
})
