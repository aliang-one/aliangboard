// 集群列表实时探测:对每个集群 DB 行并行探测 /version(健康度 + 版本)+ nodes/pods 计数,
// 带 TTL 缓存与单集群超时降级(Disconnected)。requestFn / now 可注入 → 可脱离真实 K8s 单测。
//
// 与 requestKubernetes 解耦:调用方传 buildCtx 把 DB 行转成调用上下文(buildCallContext 返回的形状)。
// 为什么单独成模块:列表探测是编排逻辑(并行 + 超时 + 缓存),抽出后既能被
//   /api/admin/clusters(GET)复用,也能用 mock requestFn 锁定语义(健康/断连/超时/缓存)。
//   对标 sa-binding / call-context 的「抽模块 + 可单测」约定。

const DEFAULT_TTL = 45_000     // 缓存窗口:列表页频繁刷新不重复打 N 个集群
const DEFAULT_TIMEOUT = 5_000  // 单集群探测上限:慢/不可达集群不拖垮整列(并行取 max ≈ 上限)

// 探测产出的「富字段」:合并进 DB 行后,ClusterCard 按 v-if 条件渲染(缺则隐藏)。
//   status      'Healthy' | 'Disconnected'(断连/超时/凭据失效)
//   version     /version.gitVersion;失败回退 DB 里建表时探测的旧版本
//   nodeCount   /api/v1/nodes.items.length;超时/失败 → null(card 显示 —)
//   podCount    /api/v1/pods.items.length;同上
export function createClusterProber({ requestFn, ttl = DEFAULT_TTL, timeout = DEFAULT_TIMEOUT, now = Date.now } = {}) {
  if (typeof requestFn !== 'function') throw new Error('createClusterProber: requestFn 必传')
  const cache = new Map() // clusterId -> { data, fetchedAt }

  // 让一个 promise 在 timeout 内未结算则回退 fallback。
  // 注意:回退只解决外层 race,底层 promise(requestKubernetes)仍会按自身 15s abort 收尾;
  //       若 promise reject,外层 race 会 reject —— 版本探测用 try/catch 兜成 Disconnected,
  //       计数探测用 safe() 包成永不行 reject 的链。
  function raceWithTimeout(promise, fallback) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(fallback), timeout)),
    ])
  }

  async function probeOne(row, buildCtx) {
    const hit = cache.get(row.id)
    if (hit && now() - hit.fetchedAt < ttl) return { ...row, ...hit.data }

    const data = { status: 'Disconnected', version: row.version ?? null, nodeCount: null, podCount: null }

    // 1) 版本探测 = 健康闸门:可达且拿到 gitVersion 才算 Healthy,否则 Disconnected(不计 nodes/pods)。
    try {
      const ctx = buildCtx(row)
      const ver = await raceWithTimeout(requestFn(ctx, '/version'), null)
      if (ver?.body?.gitVersion) {
        data.version = ver.body.gitVersion
        data.status = 'Healthy'
      }
    } catch { /* 网络错/凭据失效/超时 reject → Disconnected */ }

    // 2) 健康 → 并行取 node/pod 计数;各自独立超时降级为 null。
    if (data.status === 'Healthy') {
      const ctx = buildCtx(row)
      const safe = (p) => p.then(r => r?.body?.items?.length ?? null).catch(() => null)
      const [nodeCount, podCount] = await Promise.all([
        raceWithTimeout(safe(requestFn(ctx, '/api/v1/nodes')), null),
        raceWithTimeout(safe(requestFn(ctx, '/api/v1/pods')), null),
      ])
      data.nodeCount = nodeCount
      data.podCount = podCount
    }

    cache.set(row.id, { data, fetchedAt: now() })
    return { ...row, ...data }
  }

  return {
    // rows: DB 行数组(需含探测用的凭据列 + id/version);buildCtx(row) → 调用上下文。
    // force: 绕过 TTL 缓存强制重探(?refresh=1 用)。
    async probeAll(rows, buildCtx, { force = false } = {}) {
      if (force) cache.clear()
      return Promise.all((rows || []).map(r => probeOne(r, buildCtx)))
    },
    invalidate(id) { if (id == null) cache.clear(); else cache.delete(id) },
    _cacheSizeForTest() { return cache.size },
  }
}
