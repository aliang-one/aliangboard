<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const isNumeric = computed(() =>
  typeof props.modelValue.port === 'number' || /^\d+$/.test(String(props.modelValue.port || ''))
)
function patch(p) {
  const out = { ...props.modelValue, ...p }
  // 命名端口或空端口不带 endPort;按合并后的 port 值判定,而非旧 prop。
  const portNumeric = typeof out.port === 'number' || /^\d+$/.test(String(out.port || ''))
  if (!portNumeric) delete out.endPort
  emit('update:modelValue', out)
}
function onPortInput(e) {
  const raw = e.target.value
  // 按「当前输入」判定数字/命名,isNumeric 反映的是旧 prop 值,首字符输入时会误判。
  const numeric = /^\d+$/.test(raw)
  patch({ port: raw === '' ? '' : (numeric ? Number(raw) : raw) })
}
</script>

<template>
  <div class="flex items-center gap-sm">
    <select :value="modelValue.protocol" @change="patch({ protocol: $event.target.value })"
      class="bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm">
      <option v-for="p in ['TCP','UDP','SCTP']" :key="p">{{ p }}</option>
    </select>
    <input :value="modelValue.port" data-test="port" @input="onPortInput"
      :placeholder="t('ns.netpolCreate.portPlaceholder')"
      class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
    <input v-if="isNumeric" :value="modelValue.endPort ?? ''" data-test="endport"
      @input="patch({ endPort: Number($event.target.value) })" placeholder="endPort"
      class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-md py-xs text-body-sm font-mono" />
  </div>
</template>
