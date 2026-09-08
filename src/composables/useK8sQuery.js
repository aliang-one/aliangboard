import { computed } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useClusterStore } from '@/stores/cluster'

// K8s 资源查询封装（服务端状态归 Vue Query）。
// canonical cache = 每资源一个 cluster-wide 单 key（如 ['cluster', clusterId, 'pods']）；
// 命名空间视图用 select 过滤；watch 增量经 useWatchMerger 写回同一 key（live 与 cache 同源）。

// ===== watch 感知的大列表节流(2026-09-08 性能批) =====
// 五个 watch 全覆盖族(pods/events/workloads/services/ingresses)恰是带宽大头(部署实例实测
// pods 全量 1.2MB/次、deploy+sts+ds 合并 ~1.4MB/次,每 15-40s 重拉一轮);watch live 时增量
// 持续写回同一 queryKey(每次 setQueryData 都重置 dataUpdatedAt),全量重拉是冗余——却会把
// 浏览器 HTTP/1.1 同源 6 连接池占满,小请求(如 workbench/summary)排队 20s+ 的直接成因。
// live:拉长 staleTime + 关窗口聚焦重拉;非 live(降级/断开/未启):维持原默认,行为零变化。
// pods 略短:fetchPods 捆绑的 per-pod 指标只在全量拉取时刷新,120s 是指标停摆的体验上限;
// 其余四族纯结构数据,watch 增量即权威,300s 仅是「watch 断了之后的兜底陈旧窗口」上限。
export const WATCH_THROTTLED_KINDS = new Set(['pods', 'events', 'workloads', 'services', 'ingresses'])
export function watchAwareListDefaults(kind, state) {
  if (!WATCH_THROTTLED_KINDS.has(String(kind || '')) || state !== 'live') {
    return { staleTime: 15_000, refetchOnWindowFocus: true }
  }
  return {
    staleTime: kind === 'pods' ? 120_000 : 300_000,
    refetchOnWindowFocus: false,
  }
}

// 身份键：优先 uid（K8s 稳定标识）；兜底 ns/name（uid 缺失时按展示项定位）。
export function uidKey(item) {
  const uid = item?.uid ?? item?.metadata?.uid
  if (uid) return uid
  const ns = item?.namespace ?? item?.metadata?.namespace ?? ''
  const name = item?.name ?? item?.metadata?.name ?? ''
  return `${ns}/${name}`
}

// 纯函数：把一个 watch 事件合并进列表（不可变，适配 Vue Query setQueryData 的函数式更新，避免覆盖乐观值）。
// type: 'ADDED' | 'MODIFIED' | 'DELETED'；item：已映射对象；identityKey：(item)=>string。
//   - DELETED + 命中 → 移除；未命中 → 原样返回
//   - ADDED/MODIFIED + 命中 → 原地合并；未命中 → 追加
export function applyWatchEvent(list, type, item, identityKey = uidKey) {
  if (!item) return list
  const arr = list || []
  const k = identityKey(item)
  const idx = arr.findIndex(x => identityKey(x) === k)
  if (type === 'DELETED') {
    if (idx === -1) return arr
    return arr.filter((_, i) => i !== idx)
  }
  if (idx === -1) return [...arr, item]
  const next = arr.slice()
  next[idx] = { ...arr[idx], ...item }
  return next
}

// 集群资源列表查询。
//   key: canonical queryKey（数组）；fetcher: () => Promise<mapped[]>；
//   select: 派生（如按 namespace 过滤），Vue Query 按 key memoize，无 per-tick 全表重扫。
export function useResourceList({ key, fetcher, select, identityKey = uidKey, options = {} }) {
  // watch 感知默认值(2026-09-08 性能批,策略见 watchAwareListDefaults):以 computed ref 传入,
  // watch 状态升降(live↔degraded)时无需重挂载即自动切换节流/兜底。显式 options 恒优先。
  // 无 pinia 环境(纯逻辑单测)按 'off' 兜底 = 原默认行为。
  const kind = String(key?.[2] ?? '')
  const watchState = computed(() => {
    try { return useClusterStore().watchStateOf(kind) || 'off' } catch { return 'off' }
  })
  const listDefaults = computed(() => watchAwareListDefaults(kind, watchState.value))
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    staleTime: options.staleTime ?? computed(() => listDefaults.value.staleTime),
    gcTime: options.gcTime ?? Infinity,   // 缓存永驻：正确性靠 watch 纠偏 + mutation 显式 invalidate（spec §5.1）
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? computed(() => listDefaults.value.refetchOnWindowFocus),
    retry: options.retry ?? 1,
    refetchInterval: options.refetchInterval ?? false,
    enabled: options.enabled ?? true,
    select,
  })
}

// 单资源详情查询。
export function useResourceDetail({ key, fetcher, options = {} }) {
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    staleTime: options.staleTime ?? 15_000,
    retry: options.retry ?? 1,
    refetchInterval: options.refetchInterval ?? false,
    enabled: options.enabled ?? true,
  })
}

// 把 watch 事件应用到某 queryKey 的缓存（函数式 setQueryData，避免覆盖乐观更新）。
// 必须在 setup 内调用（useQueryClient）。mapFn：K8s 原始对象 → 展示对象（mapPod/mapEvent…）。
// 返回一个 (evt) => void，供 k8sStream 的 onMessage 调用。
export function useWatchMerger(queryKey, mapFn, identityKey = uidKey) {
  const queryClient = useQueryClient()
  return (evt) => {
    if (!evt?.object) return
    const item = mapFn(evt.object)
    queryClient.setQueryData(queryKey, (old = []) => applyWatchEvent(old, evt.type, item, identityKey))
  }
}
