// 表格自定义列 —— 纯逻辑核心(无 vue / 无 vue-i18n,可被 node 零依赖运行器单测)。
// TABLE_CATALOG 是各 DataTable 视图列定义的「单一事实源」;labelKey 指向 i18n 键,
// label 为英文兜底。useTableColumns.js 在此之上加响应式 + i18n + localStorage。

export const STORAGE_KEY_V1 = 'aliangboard.tableColumns.v1'
export const STORAGE_KEY = 'aliangboard.tableColumns.v2'

export const TABLE_CATALOG = [
  {
    key: 'nodes', labelKey: 'cols.nodes._t', label: 'Nodes', icon: 'dns',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'roles', labelKey: 'cols.nodes.roles', label: 'Role' },
      { key: 'system', labelKey: 'cols.nodes.system', label: 'System' },
      { key: 'cpu', labelKey: 'cols.nodes.cpu', label: 'CPU' },
      { key: 'memory', labelKey: 'cols.nodes.memory', label: 'Memory' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'workloads', labelKey: 'cols.workloads._t', label: 'Workloads', icon: 'workspaces',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'replicas', labelKey: 'cols.workloads.replicas', label: 'Replicas' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'namespaces', labelKey: 'cols.namespaces._t', label: 'Namespaces', icon: 'folder',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'services', labelKey: 'cols._c.services', label: 'Services' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'services', labelKey: 'cols.services._t', label: 'Services', icon: 'share',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'clusterIP', labelKey: 'cols.services.clusterIP', label: 'Cluster IP' },
      { key: 'externalIP', labelKey: 'cols.services.externalIP', label: 'External IP' },
      { key: 'ports', labelKey: 'cols.services.ports', label: 'Ports' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
  {
    key: 'ingress', labelKey: 'cols.ingress._t', label: 'Ingress', icon: 'router',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'hosts', labelKey: 'cols.ingress.hosts', label: 'Hosts' },
      { key: 'path', labelKey: 'cols.ingress.path', label: 'Path' },
      { key: 'backend', labelKey: 'cols.ingress.backend', label: 'Backend' },
      { key: 'tls', labelKey: 'cols.ingress.tls', label: 'TLS' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
]

// v1: { [tableKey]: { [colKey]: false } } (false = 隐藏)
// v2: { [tableKey]: { order?: string[], hidden?: { [k]: true }, width?: { [k]: number } } }
export function migrateV1toV2(v1) {
  if (!v1 || typeof v1 !== 'object') return {}
  const v2 = {}
  for (const [tableKey, cols] of Object.entries(v1)) {
    if (!cols || typeof cols !== 'object') continue
    const hidden = {}
    for (const [colKey, val] of Object.entries(cols)) {
      if (val === false) hidden[colKey] = true
    }
    if (Object.keys(hidden).length) v2[tableKey] = { hidden }
  }
  return v2
}

// 对账:catalog 为准。order 重排(未列入的 catalog 列按默认序追加到末尾;order 中
// 不存在的 key 忽略);hidden/width 合并。返回 ordered(全量,带标记)+ visible(过滤)。
export function reconcileColumns(catalogColumns, overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  const order = Array.isArray(ov.order) ? ov.order : []
  const hidden = ov.hidden && typeof ov.hidden === 'object' ? ov.hidden : {}
  const width = ov.width && typeof ov.width === 'object' ? ov.width : {}

  const ordered = [...catalogColumns]
  if (order.length) {
    ordered.sort((a, b) => {
      const ia = order.indexOf(a.key)
      const ib = order.indexOf(b.key)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1   // a 不在 order → 排到后面
      if (ib === -1) return -1  // b 不在 order → 排到后面
      return ia - ib
    })
  }

  const tagged = ordered.map(c => ({
    ...c,
    hidden: hidden[c.key] === true,
    width: typeof width[c.key] === 'number' ? width[c.key] : undefined,
  }))
  return { ordered: tagged, visible: tagged.filter(c => !c.hidden) }
}
