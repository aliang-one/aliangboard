// 资源 fetcher（K8s API → mapXxx）。从 cluster.js 抽出的纯数据拉取函数。
import { api } from '@/api/client'
import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'
import {
  mapNode, mapPod, mapWorkload, mapEvent, mapConfigMap, mapSecret, mapPVC, mapPV,
  mapStorageClass, mapEndpoints, mapIngressClass, mapRuntimeClass, mapPriorityClass,
  mapService, mapIngress, mapNetworkPolicy, mapHPA, mapResourceQuota, mapLimitRange,
  mapRole, mapServiceAccount, mapRoleBinding, mapPDB, mapCRD, mapCRInstance
} from '@/composables/useResourceMappers'

export async function fetchNodes() {
  const [nodeData, metricsData] = await Promise.all([
    api.k8s('/api/v1/nodes'),
    api.k8s('/apis/metrics.k8s.io/v1beta1/nodes').catch(() => null),
  ])
  const metricMap = new Map()
  for (const it of (metricsData?.items || [])) {
    metricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
  }
  const metricFor = name => (metricMap.has(name) ? metricMap.get(name) : null)
  return (nodeData?.items || []).map(item => mapNode(item, metricFor(item.metadata?.name)))
}

// 单节点拉取（node + node-metrics 过滤）。供 NodeDetail useResourceDetail 作 fetcher。
export async function fetchNode(name) {
  const [nodeData, metricsData] = await Promise.all([
    api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`),
    api.k8s('/apis/metrics.k8s.io/v1beta1/nodes').catch(() => null),
  ])
  const m = (metricsData?.items || []).find(it => it.metadata?.name === name)
  const metric = m ? { cpuMilli: cpuToMilli(m.usage?.cpu), memKi: memToKi(m.usage?.memory) } : null
  return nodeData ? mapNode(nodeData, metric) : null
}

// 单类型资源列表拉取（自包含：单 endpoint + mapXxx，无 metrics 耦合）。供各 Ns* 列表页 Vue Query 作 fetcher。
export async function fetchServices() { const d = await api.k8s('/api/v1/services?limit=1000'); return (d?.items || []).map(mapService) }
export async function fetchService(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/services/${encodeURIComponent(name)}`); return d ? mapService(d) : null }
export async function fetchConfigMaps() { const d = await api.k8s('/api/v1/configmaps?limit=5000'); return (d?.items || []).map(mapConfigMap) }
export async function fetchConfigMap(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps/${encodeURIComponent(name)}`); return d ? mapConfigMap(d) : null }
export async function fetchSecrets() { const d = await api.k8s('/api/v1/secrets?limit=5000'); return (d?.items || []).map(mapSecret) }
export async function fetchSecret(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`); return d ? mapSecret(d) : null }
export async function fetchIngresses() { const d = await api.k8s('/apis/networking.k8s.io/v1/ingresses?limit=1000'); return (d?.items || []).map(mapIngress) }
export async function fetchIngress(name, ns) { const d = await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`); return d ? mapIngress(d) : null }
export async function fetchNetworkPolicies() { const d = await api.k8s('/apis/networking.k8s.io/v1/networkpolicies?limit=5000'); return (d?.items || []).map(mapNetworkPolicy) }
export async function fetchNetworkPolicy(name, ns) { const d = await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/networkpolicies/${encodeURIComponent(name)}`); return d ? mapNetworkPolicy(d) : null }
export async function fetchPDBs() { const d = await api.k8s('/apis/policy/v1/poddisruptionbudgets?limit=5000'); return (d?.items || []).map(mapPDB) }
export async function fetchPDB(name, ns) { const d = await api.k8s(`/apis/policy/v1/namespaces/${encodeURIComponent(ns)}/poddisruptionbudgets/${encodeURIComponent(name)}`); return d ? mapPDB(d) : null }
export async function fetchLimitRanges() { const d = await api.k8s('/api/v1/limitranges?limit=5000'); return (d?.items || []).map(mapLimitRange) }
export async function fetchLimitRange(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/limitranges/${encodeURIComponent(name)}`); return d ? mapLimitRange(d) : null }
export async function fetchResourceQuotas() { const d = await api.k8s('/api/v1/resourcequotas?limit=5000'); return (d?.items || []).map(mapResourceQuota) }
export async function fetchResourceQuota(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/resourcequotas/${encodeURIComponent(name)}`); return d ? mapResourceQuota(d) : null }
export async function fetchHPAs() { const d = await api.k8s('/apis/autoscaling/v2/horizontalpodautoscalers?limit=5000'); return (d?.items || []).map(mapHPA) }
export async function fetchHPA(name, ns) { const d = await api.k8s(`/apis/autoscaling/v2/namespaces/${encodeURIComponent(ns)}/horizontalpodautoscalers/${encodeURIComponent(name)}`); return d ? mapHPA(d) : null }
export async function fetchEndpoints() { const d = await api.k8s('/api/v1/endpoints?limit=5000'); return (d?.items || []).map(mapEndpoints) }
// 工作负载列表（deploy+sts+ds 三类合一 + replicasets 用于回滚历史；remote 模式不含 job/cronjob，按需在详情页补）
export async function fetchWorkloads() {
  const [dep, sts, ds, rs] = await Promise.all([
    api.k8s('/apis/apps/v1/deployments?limit=1000'),
    api.k8s('/apis/apps/v1/statefulsets?limit=1000'),
    api.k8s('/apis/apps/v1/daemonsets?limit=1000'),
    api.k8s('/apis/apps/v1/replicasets?limit=5000'),
  ])
  const list = [
    ...((dep?.items || []).map(i => mapWorkload(i, 'Deployment'))),
    ...((sts?.items || []).map(i => mapWorkload(i, 'StatefulSet'))),
    ...((ds?.items || []).map(i => mapWorkload(i, 'DaemonSet'))),
  ]
  attachRolloutHistory(list, dep, rs)
  return list
}
export async function fetchPVCs() { const d = await api.k8s('/api/v1/persistentvolumeclaims?limit=5000'); return (d?.items || []).map(mapPVC) }
export async function fetchPVs() { const d = await api.k8s('/api/v1/persistentvolumes'); return (d?.items || []).map(mapPV) }
export async function fetchStorageClasses() { const d = await api.k8s('/apis/storage.k8s.io/v1/storageclasses'); return (d?.items || []).map(mapStorageClass) }
export async function fetchPVC(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims/${encodeURIComponent(name)}`); return d ? mapPVC(d) : null }
export async function fetchRoles() {
  const [roles, clusterRoles] = await Promise.all([
    api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
    api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
  ])
  return [
    ...((roles?.items || []).map(r => mapRole(r, 'Namespace'))),
    ...((clusterRoles?.items || []).map(r => mapRole(r, 'Cluster'))),
  ]
}
export async function fetchRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
export async function fetchClusterRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
export async function fetchServiceAccounts() { const d = await api.k8s('/api/v1/serviceaccounts?limit=5000'); return (d?.items || []).map(mapServiceAccount) }
export async function fetchRole(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Namespace') : null }
export async function fetchRoleBinding(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/rolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
export async function fetchServiceAccount(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}`); return d ? mapServiceAccount(d) : null }
export async function fetchClusterRole(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Cluster') : null }
export async function fetchClusterRoleBinding(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
export async function fetchRuntimeClasses() { const d = await api.k8s('/apis/node.k8s.io/v1/runtimeclasses?limit=5000'); return (d?.items || []).map(mapRuntimeClass) }
export async function fetchIngressClasses() { const d = await api.k8s('/apis/networking.k8s.io/v1/ingressclasses?limit=5000'); return (d?.items || []).map(mapIngressClass) }
export async function fetchPriorityClasses() { const d = await api.k8s('/apis/scheduling.k8s.io/v1/priorityclasses?limit=5000'); return (d?.items || []).map(mapPriorityClass) }
export async function fetchPriorityClass(name) { const d = await api.k8s(`/apis/scheduling.k8s.io/v1/priorityclasses/${encodeURIComponent(name)}`); return d ? mapPriorityClass(d) : null }
export async function fetchNamespaces() {
  const d = await api.k8s('/api/v1/namespaces')
  return (d?.items || []).map(item => ({
    name: item.metadata?.name,
    status: item.status?.phase || 'Unknown',
    age: ageOf(item.metadata?.creationTimestamp),
    labels: item.metadata?.labels || {},
  }))
}
export async function fetchNamespace(name) {
  const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(name)}`)
  return d ? { name: d.metadata?.name, status: d.status?.phase || 'Unknown', age: ageOf(d.metadata?.creationTimestamp), labels: d.metadata?.labels || {} } : null
}
