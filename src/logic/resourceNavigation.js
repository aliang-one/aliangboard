// 资源 kind → 详情路由 映射(单一事实源)。
// 消费方:全局搜索结果跳转(原 TopNavBar goResult 内联分支)、告警铃铛 involvedObject 跳转。
// 返回 router.push 参数;无详情路由或无 name → null(调用方自行兜底,如跳事件列表)。
const NS_DETAIL_ROUTES = [
  'Pod', 'Service', 'Ingress', 'ConfigMap', 'Secret', 'PVC',
  // 2026-09-04 搜索扩容:HPA/RBAC 族/NetPol/配额族
  'HPA', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'PDB',
  'Role', 'RoleBinding', 'ServiceAccount',
]
// 集群级命名路由(name 单参数);CRD 的路由名是历史拼写 CrdDetail
const CLUSTER_DETAIL_ROUTES = ['StorageClass', 'PV', 'ClusterRole', 'ClusterRoleBinding']
const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']

export function routeForResource(kind, name, namespace) {
  if (!name) return null
  if (kind === 'Pod') return { name: 'NsPodDetail', params: { namespace, name } }
  if (WORKLOAD_KINDS.includes(kind)) return { name: 'NsWorkloadDetail', params: { namespace, type: kind.toLowerCase(), name } }
  if (NS_DETAIL_ROUTES.includes(kind)) return { name: `Ns${kind}Detail`, params: { namespace, name } }
  if (kind === 'Node') return `/nodes/${name}`
  if (kind === 'Namespace') return { name: 'NamespaceDetail', params: { name } }
  if (kind === 'CRD') return { name: 'CrdDetail', params: { name } }
  if (CLUSTER_DETAIL_ROUTES.includes(kind)) return { name: `${kind}Detail`, params: { name } }
  return null
}
