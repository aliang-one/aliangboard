// 全局搜索纯函数(2026-09-04 顶栏搜索升级,自 TopNavBar 内联实现抽出)。
// 三件事:①页面导航匹配(双关键词表,输「监控/deploy」直达路由);
// ②资源名子串过滤;③页面优先排序 + 总条数钳制。
// 消费方:TopNavBar(⌘K 搜索)。i18n 关键词为静态双语副本(仅匹配用,展示走 titleKey)。
export const PAGE_ENTRIES = [
  { path: '/cluster', labelKey: 'nav.clusterOverview', icon: 'dashboard', keywords: ['集群总览', '集群', 'cluster', 'overview'] },
  { path: '/nodes', labelKey: 'nav.nodes', icon: 'dns', keywords: ['节点', 'node', 'nodes'] },
  { path: '/namespaces', labelKey: 'nav.namespaces', icon: 'folder_open', keywords: ['命名空间', 'namespace', 'namespaces'] },
  { path: '/storage', labelKey: 'nav.storage', icon: 'storage', keywords: ['存储', 'storage'] },
  { path: '/monitoring', labelKey: 'nav.monitoring', icon: 'monitoring', keywords: ['监控', 'monitor', 'monitoring'] },
  { path: '/crds', labelKey: 'nav.crds', icon: 'extension', keywords: ['自定义资源', 'crd', 'crds'] },
  { path: '/clusters', labelKey: 'nav.clusters', icon: 'hub', keywords: ['集群管理', '多集群', 'clusters', 'multi-cluster'] },
  { path: '/workloads', labelKey: 'nav.workloads', icon: 'work', keywords: ['工作负载', '负载', 'workload', 'workloads'] },
  { path: '/network', labelKey: 'nav.network', icon: 'share', keywords: ['网络', 'network', 'service', 'ingress'] },
  { path: '/configuration', labelKey: 'nav.configuration', icon: 'tune', keywords: ['配置', 'config', 'configuration'] },
  { path: '/rbac', labelKey: 'nav.rbac', icon: 'security', keywords: ['权限', '授权', 'rbac', 'role'] },
  { path: '/rbac/can-i', labelKey: 'nav.rbacCanI', icon: 'rule', keywords: ['权限模拟', '模拟器', 'can-i', 'cani'] },
  { path: '/deploy', labelKey: 'nav.deploy', icon: 'rocket_launch', keywords: ['部署', '发布', 'deploy'] },
  { path: '/audit-logs', labelKey: 'nav.activityLog', icon: 'history', keywords: ['活动记录', '事件', '日志', 'audit', 'activity', 'events'] },
  { path: '/settings', labelKey: 'nav.settings', icon: 'settings', keywords: ['设置', '偏好', 'settings'] },
  { path: '/workbench', labelKey: 'nav.workbench', icon: 'auto_awesome', keywords: ['工作台', '助手', 'workbench', 'ai'] },
]

export function matchPages(rawQuery) {
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  return PAGE_ENTRIES.filter(p => p.keywords.some(k => k.toLowerCase().includes(q)))
}

export function searchResources(rawQuery, items) {
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  return (items || []).filter(it => it.name && it.name.toLowerCase().includes(q))
}

// 页面优先、总量钳制(默认 12,承旧搜索 results cap)
export function searchAll(rawQuery, items, opts = {}) {
  const limit = opts.limit ?? 12
  const pages = matchPages(rawQuery).slice(0, limit)
  const resources = searchResources(rawQuery, items).slice(0, Math.max(0, limit - pages.length))
  return { pages, resources }
}

// 23 类资源来源聚合为搜索条目 {kind,name,namespace}(Event 附 reason/involvedObject 供展示与跳转)
export function collectResourceItems(bag = {}) {
  const items = []
  const push = (kind, name, namespace, extra) => {
    if (!name) return
    items.push({ kind, name, namespace: namespace || '', ...extra })
  }
  for (const p of (bag.pods || [])) push('Pod', p.name, p.namespace)
  for (const w of (bag.workloads || [])) push(w.type || 'Workload', w.name, w.namespace)
  for (const s of (bag.services || [])) push('Service', s.name, s.namespace)
  for (const ing of (bag.ingresses || [])) push('Ingress', ing.name, ing.namespace)
  for (const cm of (bag.configmaps || [])) push('ConfigMap', cm.name, cm.namespace)
  for (const sec of (bag.secrets || [])) push('Secret', sec.name, sec.namespace)
  for (const pvc of (bag.pvcs || [])) push('PVC', pvc.name, pvc.namespace)
  for (const h of (bag.hpas || [])) push('HPA', h.name, h.namespace)
  // store.fetchRoles 返回 Role+ClusterRole 混合面(mapRole scope 字段区分),按 scope 拆 kind
  for (const r of (bag.roles || [])) {
    if (r.scope === 'Cluster') push('ClusterRole', r.name, '')
    else push('Role', r.name, r.namespace)
  }
  for (const rb of (bag.rolebindings || [])) push('RoleBinding', rb.name, rb.namespace)
  for (const cr of (bag.clusterroles || [])) push('ClusterRole', cr.name, '')
  for (const crb of (bag.clusterrolebindings || [])) push('ClusterRoleBinding', crb.name, '')
  for (const sa of (bag.serviceaccounts || [])) push('ServiceAccount', sa.name, sa.namespace)
  for (const np of (bag.networkpolicies || [])) push('NetworkPolicy', np.name, np.namespace)
  for (const rq of (bag.resourcequotas || [])) push('ResourceQuota', rq.name, rq.namespace)
  for (const lr of (bag.limitranges || [])) push('LimitRange', lr.name, lr.namespace)
  for (const pdb of (bag.pdbs || [])) push('PDB', pdb.name, pdb.namespace)
  for (const sc of (bag.storageclasses || [])) push('StorageClass', sc.name, '')
  for (const pv of (bag.pvs || [])) push('PV', pv.name, '')
  for (const crd of (bag.crds || [])) push('CRD', crd.name, '')
  // 事件以 involvedObject 名为索引名,缺资源名退化为 reason(跳转走 NsEvents 兜底)
  for (const e of (bag.events || [])) {
    const name = e.relatedName || e.reason
    if (name) items.push({ kind: 'Event', name, namespace: e.namespace || '', reason: e.reason, relatedKind: e.relatedKind, relatedName: e.relatedName })
  }
  for (const n of (bag.nodes || [])) push('Node', n.name, '')
  for (const ns of (bag.namespaces || [])) push('Namespace', ns.name, '')
  return items
}
