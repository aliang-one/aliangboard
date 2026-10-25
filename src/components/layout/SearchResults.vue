<script setup>
// 搜索结果列表(2026-09-04 搜索升级):内联下拉与 <lg 弹层共用一份渲染,
// 消灭原 TopNavBar 里两段复制粘贴的 results 标记。页面条走 labelKey 文案,
// 资源条走 kind→图标映射 + name + kind · ns;统一 emit select(item)。
defineProps({
  results: { type: Array, default: () => [] },
})
defineEmits(['select'])

const ICON_FOR = {
  Pod: 'deployed_code', Deployment: 'work', StatefulSet: 'work', DaemonSet: 'work', Job: 'work', CronJob: 'work',
  Service: 'share', Ingress: 'alt_route', ConfigMap: 'description', Secret: 'lock', PVC: 'storage',
  Node: 'dns', Namespace: 'folder', HPA: 'timeline', NetworkPolicy: 'shield', ResourceQuota: 'pie_chart',
  LimitRange: 'tune', PDB: 'shield', Role: 'admin_panel_settings', RoleBinding: 'admin_panel_settings',
  ClusterRole: 'admin_panel_settings', ClusterRoleBinding: 'admin_panel_settings', ServiceAccount: 'badge',
  StorageClass: 'storage', PV: 'storage', CRD: 'extension', Event: 'notifications_active',
}
</script>

<template>
  <div v-if="results.length" class="absolute top-full left-0 mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-y-auto max-h-96">
    <button
      v-for="(it, i) in results"
      :key="i"
      data-test="search-row"
      class="flex items-center gap-sm w-full px-md py-sm hover:bg-surface-container-low text-left transition-colors border-b border-outline-variant/30 last:border-0"
      @click="$emit('select', it)"
    >
      <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0">{{ it.page ? (it.icon || 'arrow_forward') : (ICON_FOR[it.kind] || 'circle') }}</span>
      <span class="font-mono text-code-sm text-on-surface truncate">{{ it.page ? $t(it.labelKey) : it.name }}</span>
      <span class="ml-auto text-xs text-on-surface-variant shrink-0">{{ it.kind }}<span v-if="it.namespace"> · {{ it.namespace }}</span></span>
    </button>
  </div>
</template>
