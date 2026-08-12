// 集群汇总计数纯函数:从 Vue Query 缓存快照派生 node/pod/event 数量。
// 不依赖 vue/pinia/@-alias,可被 scripts/test.mjs(node 直跑)直接 import 测试。
// 语义:数组 → 命中(取长度,空数组 = 0);非数组/缺省 → null(未命中,供调用方 ?? 回退 store ref)。
export function deriveClusterCounts(cache = {}) {
  const len = v => (Array.isArray(v) ? v.length : null)
  return {
    nodeCount: len(cache.nodes),
    podCount: len(cache.pods),
    activeEvents: len(cache.events),
  }
}
