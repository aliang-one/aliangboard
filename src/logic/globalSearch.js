// 全局搜索纯函数(2026-09-04 自顶栏抽出;2026-10-23 页面表改由 navConfig 派生,spec §3):
// 页面 path/labelKey/icon 单源自导航,关键词与中文同义词(经参数传入)留本模块。
import {
  CLUSTER_PRIMARY_NAV, CLUSTER_CROSS_NS_NAV, CLUSTER_RESOURCES_NAV, CLUSTER_OTHER_NAV,
  PLATFORM_ADMIN_NAV, WORKBENCH_NAV,
} from './navConfig.js'

// 英文 slug 关键词(承 2026-09-04 旧表逐字);未列出的条目靠 i18n 同义词表命中
const KEYWORDS = {
  '/cluster': ['cluster', 'overview'],
  '/nodes': ['node', 'nodes'],
  '/namespaces': ['namespace', 'namespaces'],
  '/storage': ['storage'],
  '/monitoring': ['monitor', 'monitoring'],
  '/crds': ['crd', 'crds'],
  // 资源组 8 页(2026-10-24 polish 批补可搜:此前 keywords 空,仅侧栏导航可达)
  '/priorityclasses': ['priorityclass', 'priority-classes'],
  '/ingressclasses': ['ingressclass', 'ingress-classes'],
  '/runtimeclasses': ['runtimeclass', 'runtime-classes'],
  '/admin/apiservices': ['apiservice', 'api-services'],
  '/admin/webhooks-mutating': ['mutating-webhook', 'webhook'],
  '/admin/webhooks-validating': ['validating-webhook', 'webhook'],
  '/admin/replicasets': ['replicaset', 'replica-sets'],
  '/admin/csinodes': ['csinode', 'csi-node'],
  '/cluster/certs': ['cert', 'certificate', 'tls', 'x509', 'ca'],
  '/clusters': ['clusters', 'multi-cluster'],
  '/workloads': ['workload', 'workloads'],
  '/network': ['network'],
  '/configuration': ['config', 'configuration'],
  '/rbac': ['rbac'],
  '/rbac/can-i': ['can-i', 'cani'],
  '/deploy': ['deploy'],
  '/audit-logs': ['audit', 'activity', 'events'],
  '/settings': ['settings'],
  '/workbench': ['workbench', 'ai'],
  '/admin/users': ['users', 'user-management'],
  '/admin/groups': ['groups', 'grants'],
  '/admin/clusters': ['cluster-management'],
  '/admin/apikeys': ['apikeys', 'api-key'],
  '/admin/ai-behavior': ['ai-behavior'],
  '/admin/llm-config': ['llm', 'llm-config'],
  '/admin/audit-trail': ['audit-trail'],
}

// label 透传(2026-10-24 polish 批):资源组 8 页只有 label 无 labelKey,条目不带 label
// 会让 SearchResults 渲染 $t(undefined)(潜伏断链)——navConfig 的 label/labelKey 双形态原样下传
const toPageEntry = it => ({
  path: it.route,
  labelKey: it.labelKey,
  label: it.label,
  icon: it.icon,
  keywords: KEYWORDS[it.route] || [],
})

// 平台管理页 admin 专属:默认不进匹配(非 admin 使用者搜索不漏 admin 路由),showAdmin 放行
export const PAGE_ENTRIES = [
  ...[...CLUSTER_PRIMARY_NAV, ...CLUSTER_CROSS_NS_NAV, ...CLUSTER_RESOURCES_NAV,
    ...CLUSTER_OTHER_NAV, WORKBENCH_NAV].map(toPageEntry),
  ...PLATFORM_ADMIN_NAV.map(it => ({ ...toPageEntry(it), admin: true })),
  // 固定补充:不走侧栏数据组的功能页(全局工具)
  { path: '/rbac/can-i', labelKey: 'route.canI', icon: 'rule', keywords: KEYWORDS['/rbac/can-i'] },
  { path: '/deploy', labelKey: 'nav.deploy', icon: 'rocket_launch', keywords: KEYWORDS['/deploy'] },
  { path: '/audit-logs', labelKey: 'nav.activityLog', icon: 'history', keywords: KEYWORDS['/audit-logs'] },
  { path: '/settings', labelKey: 'nav.settings', icon: 'settings', keywords: KEYWORDS['/settings'] },
]

const pathKey = p => String(p || '').replace(/^\//, '')

export function matchPages(rawQuery, synonyms = {}, opts = {}) {
  const showAdmin = opts.showAdmin === true
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const p of PAGE_ENTRIES) {
    if (p.admin && !showAdmin) continue
    // ↓ 以下与原实现逐字一致(同义词键兼容/前缀优先排序)
    const pk = pathKey(p.path)
    const zhText = synonyms[pk] ?? synonyms[pk.split('/').pop()] ?? ''
    const pool = [...p.keywords, ...String(zhText).split(',').filter(Boolean)]
    const prefix = pool.some(k => k.toLowerCase().startsWith(q))
    const includes = pool.some(k => k.toLowerCase().includes(q))
    if (prefix || includes) scored.push({ p, prefix })
  }
  return scored.sort((a, b) => Number(b.prefix) - Number(a.prefix)).map(x => x.p)
}

export function searchResources(rawQuery, items) {
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  return (items || []).filter(it => it.name && it.name.toLowerCase().includes(q))
}

// 页面优先、总量钳制(默认 12,承旧搜索 results cap);页面至多占 4 席,
// 保底 8 席给资源——短查询('e'/'ng')时子串命中的页面不该挤掉资源结果
export function searchAll(rawQuery, items, opts = {}) {
  const limit = opts.limit ?? 12
  const synonyms = opts.synonyms || {}
  const pages = matchPages(rawQuery, synonyms, { showAdmin: opts.showAdmin === true }).slice(0, 4)
  const resources = searchResources(rawQuery, items).slice(0, Math.max(0, limit - pages.length))
  return { pages, resources }
}

// 23 类资源来源聚合为搜索条目 {kind,name,namespace}(Event 附 reason/involvedObject 供展示与跳转)。
// 注意 ClusterRole 只从 roles 混合面按 scope 拆分(fetchRoles 返回 Role+ClusterRole 合并),
// 不存在独立 clusterroles 入参——勿新增,否则双重计数。
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
