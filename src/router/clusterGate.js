// 路由守卫「无 session 去留决策」(纯函数,便于单测)。
//
// 触发场景:无 K8s session 且 tryAutoConnect 失败(首次部署尚无任何集群,或上次集群
// 已被删除/凭据失效)。此时决定导航去留:
//   - 平台管理类页面(meta.requiresCluster === false)不依赖「已连接某集群」——典型如
//     集群管理页本身。admin 首次部署必须能进入它添加第一个集群,故放行。
//   - 其余非 public 页面(资源页等)需要集群上下文 → 弹回 /select-cluster 让用户先选集群。
//   - public 页面(登录/选集群)本就不需要 session → 放行。
//
// 返回 { name: 'SelectCluster' } 表示弹回;undefined 表示放行(继续进入目标页)。
// 注意:放行(undefined)时,调用方应直接 return,以跳过守卫后续的 api.session() 验证
// (无 session 时该验证必失败、会把用户再次弹回)。
export function resolveWhenSessionMissing(to, isPublic) {
  if (to?.meta?.requiresCluster === false) return undefined
  if (!isPublic) return { name: 'SelectCluster' }
  return undefined
}
