import { useQuery, useQueryClient } from '@tanstack/vue-query'

// K8s 资源查询封装（服务端状态归 Vue Query）。
// canonical cache = 每资源一个 cluster-wide 单 key（如 ['cluster', clusterId, 'pods']）；
// 命名空间视图用 select 过滤；watch 增量经 useWatchMerger 写回同一 key（live 与 cache 同源）。

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
//   key: canonical queryKey（数组）；fetcher: () => Promise<mapped[]>；mock: 静态种子（demo 模式）；
//   mockMode: true 时返回 mock 且 staleTime:Infinity（只取一次不重拉，避免无后端 demo 触发真实请求/401）；
//   select: 派生（如按 namespace 过滤），Vue Query 按 key memoize，无 per-tick 全表重扫。
export function useResourceList({ key, fetcher, mock = null, mockMode = false, select, identityKey = uidKey, options = {} }) {
  return useQuery({
    queryKey: key,
    queryFn: mockMode ? () => mock : fetcher,
    staleTime: mockMode ? Infinity : (options.staleTime ?? 15_000),
    gcTime: mockMode ? Infinity : (options.gcTime ?? 5 * 60_000),
    refetchOnWindowFocus: mockMode ? false : (options.refetchOnWindowFocus ?? true),
    retry: mockMode ? false : (options.retry ?? 1),
    enabled: options.enabled ?? true,
    select,
  })
}

// 单资源详情查询。
export function useResourceDetail({ key, fetcher, mock = null, mockMode = false, options = {} }) {
  return useQuery({
    queryKey: key,
    queryFn: mockMode ? () => mock : fetcher,
    staleTime: mockMode ? Infinity : (options.staleTime ?? 15_000),
    retry: mockMode ? false : (options.retry ?? 1),
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
