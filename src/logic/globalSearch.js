// 全局搜索纯函数(2026-09-04 顶栏搜索升级,自 TopNavBar 内联实现抽出)。
// 三件事:①页面导航匹配(英文 slug 关键词 + i18n 同义词表,输「监控/deploy」直达路由);
// ②资源名子串过滤;③页面优先排序 + 总条数钳制。
// 中文同义词必须放 locales(nav.searchPageSynonyms)——i18n 残留中文门禁禁止 src 出现
// 中文字面量;组件经 useI18n().tm 取当前语言表后由 synonyms 参数传入。
export const PAGE_ENTRIES = [
  { path: '/cluster', labelKey: 'nav.clusterOverview', icon: 'dashboard', keywords: ['cluster', 'overview'] },
  { path: '/nodes', labelKey: 'nav.nodes', icon: 'dns', keywords: ['node', 'nodes'] },
  { path: '/namespaces', labelKey: 'nav.namespaces', icon: 'folder_open', keywords: ['namespace', 'namespaces'] },
  { path: '/storage', labelKey: 'nav.storage', icon: 'storage', keywords: ['storage'] },
  { path: '/monitoring', labelKey: 'nav.monitoring', icon: 'monitoring', keywords: ['monitor', 'monitoring'] },
  { path: '/crds', labelKey: 'nav.crds', icon: 'extension', keywords: ['crd', 'crds'] },
  { path: '/cluster/certs', labelKey: 'nav.certs', icon: 'verified', keywords: ['cert', 'certificate', 'tls', 'x509', 'ca'] },
  { path: '/clusters', labelKey: 'nav.clusters', icon: 'hub', keywords: ['clusters', 'multi-cluster'] },
  { path: '/workloads', labelKey: 'nav.workloads', icon: 'work', keywords: ['workload', 'workloads'] },
  { path: '/network', labelKey: 'nav.network', icon: 'share', keywords: ['network'] },
  { path: '/configuration', labelKey: 'route.configuration', icon: 'tune', keywords: ['config', 'configuration'] },
  { path: '/rbac', labelKey: 'route.rbac', icon: 'security', keywords: ['rbac'] },
  { path: '/rbac/can-i', labelKey: 'route.canI', icon: 'rule', keywords: ['can-i', 'cani'] },
  { path: '/deploy', labelKey: 'nav.deploy', icon: 'rocket_launch', keywords: ['deploy'] },
  { path: '/audit-logs', labelKey: 'nav.activityLog', icon: 'history', keywords: ['audit', 'activity', 'events'] },
  { path: '/settings', labelKey: 'nav.settings', icon: 'settings', keywords: ['settings'] },
  { path: '/workbench', labelKey: 'nav.workbench', icon: 'auto_awesome', keywords: ['workbench', 'ai'] },
]

const pathKey = p => String(p || '').replace(/^\//, '')

export function matchPages(rawQuery, synonyms = {}) {
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const p of PAGE_ENTRIES) {
    // 同义词表键约定双兼容:'monitoring' 或 '/rbac/can-i' 全路径(尾段取 pop)
    const pk = pathKey(p.path)
    const zhText = synonyms[pk] ?? synonyms[pk.split('/').pop()] ?? ''
    // 同义词串以英文逗号分隔(| 是 vue-i18n 复数语法,值级门禁禁止)
    const pool = [...p.keywords, ...String(zhText).split(',').filter(Boolean)]
    // 前缀命中排子串命中之前(短查询时子串命中泛滥,如 'e' 几乎全站命中)
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
  const pages = matchPages(rawQuery, synonyms).slice(0, 4)
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
