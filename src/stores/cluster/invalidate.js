// cluster store · Query 失效域(Plan 5 拆分,2026-08-28):invalidateResource(按资源 key[2] predicate
// 匹配)/invalidateAllClusterQueries(跨 cid 跨资源,Namespaces「Sync」按钮用)。自 cluster.js 模块级
// 逐字搬迁;cluster.js 与各域模块(crud 等)共同消费——共享模块而非层层注入。
import { queryClient } from '@/queryClient'

function invalidateResource(resource) {
  queryClient.invalidateQueries({
    predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === resource,
  })
}

// 失效所有 cluster query(跨 cid、跨资源)。供 Namespaces/NamespaceDetail 的「Sync」按钮调用,
// 取代旧的 hydrateCoreResources 手动全量同步——让 Vue Query 按需重拉(stale 的才会刷新)。
function invalidateAllClusterQueries() {
  queryClient.invalidateQueries({
    predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster',
  })
}

export { invalidateResource, invalidateAllClusterQueries }
