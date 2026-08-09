import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  STORAGE_KEY, STORAGE_KEY_V1, TABLE_CATALOG,
  migrateV1toV2, reconcileColumns,
} from './tableColumnsCore.js'

// 表格「自定义列」:可勾选显隐 / 拖拽排序 / 调列宽,配置持久化到 localStorage(v2),
// 所有视图与 Settings 页共享同一份响应式状态(即时生效)。
//
// 纯逻辑(迁移/对账/列定义)见 tableColumnsCore.js。本文件:
//   - 模块级(不依赖 i18n,可直接单测):loadAndMigrate / isHidden / toggle /
//     setOrder / setWidth / resetTable / resetAll,操作同一份模块单例 config。
//   - useTableColumns() 工厂(依赖 i18n 翻译 label):tableColumns / allColumns,
//     须在组件 setup 内调用;工厂同时把上面的 mutators 一并返回(视图/Settings 旧用法不变)。

// 模块级单例:跨组件/视图/Settings 共享。
const config = ref(loadAndMigrate())

export function loadAndMigrate() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) || {}
    const v1raw = localStorage.getItem(STORAGE_KEY_V1)
    if (v1raw) {
      const v2 = migrateV1toV2(JSON.parse(v1raw) || {})
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v2)) } catch { /* 隐私模式 */ }
      return v2
    }
  } catch { /* 损坏 JSON */ }
  return {}
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config.value)) } catch { /* 隐私模式 */ }
}
function entryOf(tableKey) {
  return TABLE_CATALOG.find(t => t.key === tableKey)
}

export function isHidden(tableKey, colKey) {
  return config.value[tableKey]?.hidden?.[colKey] === true
}
export function toggle(tableKey, colKey) {
  const cur = config.value[tableKey] || {}
  const hidden = { ...(cur.hidden || {}) }
  if (hidden[colKey]) delete hidden[colKey]
  else hidden[colKey] = true
  config.value = { ...config.value, [tableKey]: { ...cur, hidden } }
  persist()
}
export function setOrder(tableKey, keyArray) {
  const cur = config.value[tableKey] || {}
  config.value = { ...config.value, [tableKey]: { ...cur, order: [...keyArray] } }
  persist()
}
export function setWidth(tableKey, colKey, px) {
  const cur = config.value[tableKey] || {}
  const width = { ...(cur.width || {}) }
  width[colKey] = Math.max(60, Math.min(600, Math.round(px)))
  config.value = { ...config.value, [tableKey]: { ...cur, width } }
  persist()
}
export function resetTable(tableKey) {
  const next = { ...config.value }
  delete next[tableKey]
  config.value = next
  persist()
}
export function resetAll() {
  config.value = {}
  persist()
}

// 读取(依赖 i18n 翻译 label):须在组件 setup 内经 useTableColumns() 调用。
export function useTableColumns() {
  const { t } = useI18n()
  const withLabel = (c) => ({ ...c, label: t(c.labelKey) || c.label })
  // 视图用:可见列(有序 + width 合并 + label 已翻译)。
  function tableColumns(tableKey) {
    const entry = entryOf(tableKey)
    if (!entry) return []
    return reconcileColumns(entry.columns, config.value[tableKey]).visible.map(withLabel)
  }
  // ColumnManager 用:全量列(含 hidden 标记 + width + 翻译 label,有序)。
  function allColumns(tableKey) {
    const entry = entryOf(tableKey)
    if (!entry) return []
    return reconcileColumns(entry.columns, config.value[tableKey]).ordered.map(withLabel)
  }
  return { catalog: TABLE_CATALOG, config, isHidden, tableColumns, allColumns, toggle, setOrder, setWidth, resetTable, resetAll }
}
