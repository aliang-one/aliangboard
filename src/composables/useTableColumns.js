import { ref } from 'vue'

// 表格「自定义列」：可勾选每个列表视图要显示的列，配置持久化到 localStorage，
// 所有视图与 Settings 页共享同一份响应式状态（即时生效）。
//
// TABLE_CATALOG 是各 DataTable 视图列定义的「单一事实源」：视图从这里取完整列集合，
// 再用 visibleColumns() 按用户勾选过滤；Settings 页用同一份 catalog 渲染勾选 UI。
// 新增可配置表格时，只需在此追加一项，并在对应视图用 visibleColumns('key', cols) 包裹 headers。

const STORAGE_KEY = 'aliangboard.tableColumns.v1'

export const TABLE_CATALOG = [
  {
    key: 'nodes', label: 'Nodes', icon: 'dns',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'roles', label: 'Role' },
      { key: 'cpu', label: 'CPU' },
      { key: 'memory', label: 'Memory' },
      { key: 'version', label: 'Version' },
      { key: 'age', label: 'Age' },
      { key: 'actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'workloads', label: 'Workloads', icon: 'workspaces',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'type', label: 'Type' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'status', label: 'Status' },
      { key: 'replicas', label: 'Replicas' },
      { key: 'actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'namespaces', label: 'Namespaces', icon: 'folder',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'pods', label: 'Pods' },
      { key: 'services', label: 'Services' },
      { key: 'age', label: 'Age' },
      { key: 'actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'services', label: 'Services', icon: 'share',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'type', label: 'Type' },
      { key: 'clusterIP', label: 'Cluster IP' },
      { key: 'externalIP', label: 'External IP' },
      { key: 'ports', label: 'Ports' },
      { key: 'age', label: 'Age' },
    ],
  },
  {
    key: 'ingress', label: 'Ingress', icon: 'router',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'namespace', label: 'Namespace' },
      { key: 'hosts', label: 'Hosts' },
      { key: 'path', label: 'Path' },
      { key: 'backend', label: 'Backend' },
      { key: 'tls', label: 'TLS' },
      { key: 'age', label: 'Age' },
    ],
  },
]

// 结构：{ [tableKey]: { [colKey]: false } }，缺省（未出现）即「显示」。
const config = ref(load())

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {} } catch { return {} }
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config.value)) } catch { /* 隐私模式等忽略 */ }
}

export function useTableColumns() {
  function isHidden(tableKey, colKey) {
    return config.value[tableKey]?.[colKey] === false
  }
  function toggle(tableKey, colKey) {
    const table = { ...(config.value[tableKey] || {}) }
    if (isHidden(tableKey, colKey)) {
      delete table[colKey]        // 当前隐藏 → 显示：移除 false 标记（缺省=显示）
    } else {
      table[colKey] = false        // 当前显示 → 隐藏
    }
    config.value = { ...config.value, [tableKey]: table }
    persist()
  }
  function resetTable(tableKey) {
    const next = { ...config.value }
    delete next[tableKey]
    config.value = next
    persist()
  }
  function resetAll() {
    config.value = {}
    persist()
  }
  // 视图用：按用户勾选过滤 headers，保持原顺序；缺省全部显示。
  function visibleColumns(tableKey, headers) {
    return headers.filter(h => !isHidden(tableKey, h.key))
  }
  // 视图用：直接取某表格过滤后的完整列（取自 catalog，无需视图自行定义 headers）。
  function tableColumns(tableKey) {
    const entry = TABLE_CATALOG.find(t => t.key === tableKey)
    return entry ? visibleColumns(tableKey, entry.columns) : []
  }
  return { catalog: TABLE_CATALOG, config, isHidden, toggle, resetTable, resetAll, visibleColumns, tableColumns }
}
