<script setup>
// 工具调用紧凑 chips：每个 tool/denied 事件一颗；点开就地展开 result（Cursor 风格工具行）。
// 结果智能格式化:pod_logs 直接显示文本;describe/list 提取关键字段摘要;其他走 JSON。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ trace: { type: Array, default: () => [] } })
const { t } = useI18n()

const expanded = ref(null)
function toggle(i) { expanded.value = expanded.value === i ? null : i }

// 智能格式化工具结果:按工具名提取最易读的视图
function fmtResult(ev) {
  if (!ev || ev.result == null) return ''
  const name = ev.name || ''
  const r = ev.result
  // 字符串结果直接返回(pod logs / read_ledger / read_project_file)
  if (typeof r === 'string') return r
  // 对象结果:按工具类型提取
  if (name.includes('pod_logs') || name === 'wb_get_pod_logs') {
    return r.logs || r.raw || JSON.stringify(r, null, 2)
  }
  if (name.includes('describe') || name === 'wb_describe_resource') {
    return fmtDescribe(r)
  }
  if (name.includes('get_resource') || name === 'wb_get_resource') {
    return fmtDescribe({ resource: r.resource })  // 复用 describe 格式化(但 r 无 events)
  }
  if (name.includes('list') || name === 'wb_list_resources') {
    return fmtList(r)
  }
  if (name.includes('rollout_status') || name === 'wb_rollout_status') {
    return fmtRollout(r)
  }
  // 默认:JSON
  return JSON.stringify(r, null, 2)
}

function fmtDescribe(r) {
  const res = r.resource || {}
  const md = res.metadata || {}
  const st = res.status || {}
  const sp = res.spec || {}
  const L = []
  L.push(`${res.kind || '?'}/${md.name || '?'} (${md.namespace || 'cluster-scoped'})`)
  if (st.phase) L.push(`phase: ${st.phase}`)
  if (st.conditions?.length) {
    L.push('conditions:')
    for (const c of st.conditions.slice(0, 10)) L.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (st.replicas !== undefined) L.push(`replicas: desired=${st.replicas ?? 0} ready=${st.readyReplicas ?? 0} updated=${st.updatedReplicas ?? 0}`)
  if (st.containerStatuses?.length) {
    L.push('containers:')
    for (const c of st.containerStatuses.slice(0, 5)) L.push(`  ${c.name}: ready=${c.ready} restarts=${c.restartCount ?? 0} image=${(c.image||'').slice(0, 50)}`)
  }
  if (sp.containers?.length) {
    L.push('images:')
    for (const c of sp.containers.slice(0, 5)) L.push(`  ${c.image || '?'}`)
  }
  if (r.events?.items?.length) {
    L.push(`events (${r.events.count || r.events.items.length}):`)
    for (const e of r.events.items.slice(0, 8)) L.push(`  [${e.type}] ${e.reason || ''}: ${e.message || ''}${e.last ? ` @${e.last}` : ''}`)
  }
  return L.join('\n')
}

function fmtList(r) {
  const items = r.items || []
  const L = [`${r.kind || 'resources'} (${r.count ?? items.length} total, showing ${items.length}):`]
  for (const it of items.slice(0, 30)) {
    L.push(`  ${it.namespace ? it.namespace + '/' : ''}${it.name}`)
  }
  if (items.length > 30) L.push(`  ... +${items.length - 30} more`)
  return L.join('\n')
}

function fmtRollout(r) {
  const L = [`${r.name}: ${r.summary}`]
  if (r.replicas) L.push(`desired=${r.replicas.desired} ready=${r.replicas.ready} updated=${r.replicas.updated} available=${r.replicas.available} unavailable=${r.replicas.unavailable}`)
  if (r.conditions?.length) {
    L.push('conditions:')
    for (const c of r.conditions.slice(0, 5)) L.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}`)
  }
  return L.join('\n')
}
</script>

<template>
  <div v-if="trace.length" class="flex flex-wrap gap-xs items-center">
    <button v-for="(ev, i) in trace" :key="i" type="button" @click="toggle(i)"
      class="flex items-center gap-xs text-body-xs font-mono px-sm py-xs rounded-md border transition-colors"
      :class="ev.type === 'denied'
        ? 'border-status-warning/30 text-status-warning bg-status-warning/5'
        : 'border-outline-variant text-on-surface hover:bg-surface-container-low'">
      <span class="material-symbols-outlined text-sm">{{ ev.type === 'denied' ? 'block' : 'play_arrow' }}</span>
      <span class="font-semibold">{{ ev.name }}</span>
      <span v-if="ev.type === 'denied'">{{ t('workbench.chat.toolDenied') }}</span>
      <span v-else class="text-status-success">✓</span>
    </button>
    <pre v-if="expanded !== null && fmtResult(trace[expanded])"
      class="w-full mt-xs font-mono text-body-xs bg-[#0b1c30] text-[#cfe3ff] border border-outline-variant/30 rounded-lg p-sm max-h-48 overflow-y-auto whitespace-pre-wrap break-all leading-[18px]">{{ fmtResult(trace[expanded]) }}</pre>
  </div>
</template>
