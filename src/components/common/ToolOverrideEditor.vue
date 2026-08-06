<script setup>
// 每工具覆盖编辑器:tier 默认工具(deny=关掉)+ 越过 tier 追加(allow=打开)。v-model 一个 {allow,deny} 对象。
import { computed } from 'vue'
const props = defineProps({
  tier: { type: String, default: 'read' },
  modelValue: { type: Object, default: () => ({ allow: [], deny: [] }) },
})
const emit = defineEmits(['update:modelValue'])
const CATALOG = {
  read: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history'],
  operator: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history', 'scale', 'restart'],
  admin: ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'rollout_history', 'scale', 'restart', 'exec_pod', 'browse_files', 'read_file', 'apply_yaml', 'delete_resource', 'kubectl_debug', 'rollout_undo', 'update_image'],
}
const ALL = CATALOG.admin
const defaults = computed(() => CATALOG[props.tier] || [])
const beyond = computed(() => ALL.filter(t => !defaults.value.includes(t)))
const inDeny = t => (props.modelValue?.deny || []).includes(t)
const inAllow = t => (props.modelValue?.allow || []).includes(t)
function toggle(field, t) {
  const next = { allow: [...(props.modelValue?.allow || [])], deny: [...(props.modelValue?.deny || [])] }
  const arr = next[field]; const i = arr.indexOf(t)
  if (i >= 0) arr.splice(i, 1); else arr.push(t)
  emit('update:modelValue', next)
}
</script>
<template>
  <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
    <div class="flex flex-wrap gap-1">
      <span class="text-body-xs text-on-surface-variant w-full">{{ tier }} 档默认(关掉=deny):</span>
      <button v-for="t in defaults" :key="t" type="button" @click="toggle('deny', t)"
        class="px-1.5 py-0.5 rounded text-body-xs font-mono"
        :class="inDeny(t) ? 'bg-error/15 text-error line-through' : 'bg-primary/10 text-primary'">{{ t }}</button>
    </div>
    <div class="flex flex-wrap gap-1">
      <span class="text-body-xs text-on-surface-variant w-full">越过 tier 追加(打开=allow):</span>
      <button v-for="t in beyond" :key="t" type="button" @click="toggle('allow', t)"
        class="px-1.5 py-0.5 rounded text-body-xs font-mono"
        :class="inAllow(t) ? 'bg-status-running/20 text-status-running font-semibold' : 'bg-surface-container-high text-on-surface-variant'">{{ t }}</button>
    </div>
    <p class="text-body-xs text-on-surface-variant">⚠️ allow 可越过 tier,但 SA 的真实 RBAC 才决定能否执行(策略放行、RBAC 拒→审计 error)。</p>
  </div>
</template>
