// watch resourceVersion 登记簿:每次 list(初次 fetch/降级轮询)把响应 RV 按资源路径存此,
// watch 重连从该 RV 续接只收断线期间变更。纯模块级 Map,useFetchers 写、cluster store 读,
// 无循环依赖。切集群时 clearWatchRegistry()(store 负责)。
const _rvs = new Map()
export function recordListRv(path, rv) { if (rv) _rvs.set(path, String(rv)) }
export function getListRv(path) { return _rvs.get(path) || '' }
export function clearWatchRegistry() { _rvs.clear() }
