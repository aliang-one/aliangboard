<script setup>
// 资源输入:数字框(type=number,挡字母)+ 单位下拉。v-model 承载 K8s 规范串("4000m"/
// "512Mi"/"0.5"),内部用 parseQuantity/formatQuantity 拆合。这样用户只能输数字,单位
// 走下拉,避免脏串;buildResources/saveEdit 仍收到规范串,无需改动。
// kind: 'cpu'(cores 可小数 / m 整数毫核) | 'memory'(Mi/Gi/Ki/Ti 整数)
import { ref, computed, watch } from 'vue'
import { parseQuantity, formatQuantity, RESOURCE_UNITS } from '@/composables/useResourceQuantity'

const props = defineProps({
  modelValue: { type: String, default: '' },
  kind: { type: String, default: 'cpu' },
  placeholder: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const units = computed(() => RESOURCE_UNITS[props.kind] || RESOURCE_UNITS.cpu)
const num = ref('')
const unit = ref(units.value[0].value)

function sync(v) {
  const p = parseQuantity(v, props.kind)
  num.value = p.num
  unit.value = p.unit
}
sync(props.modelValue)
// 外部重填(openEdit 重新读 spec.resources)时同步数字框/下拉
watch(() => props.modelValue, v => sync(v))

function emitVal() {
  emit('update:modelValue', formatQuantity(num.value, unit.value, props.kind))
}
// cores 允许小数;其余单位(m/Ki/Mi/Gi/Ti)整数
const step = computed(() => (props.kind === 'cpu' && unit.value === '') ? 'any' : '1')
</script>

<template>
  <div class="flex items-stretch">
    <input
      type="number" min="0" :step="step"
      v-model="num" @input="emitVal"
      class="flex-1 min-w-0 bg-surface-container-low border border-outline-variant rounded-l-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
      :placeholder="placeholder"
    />
    <select
      v-model="unit" @change="emitVal"
      class="bg-surface-container-low border border-l-0 border-outline-variant rounded-r-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
    >
      <option v-for="u in units" :key="u.value || u.label" :value="u.value">{{ u.label }}</option>
    </select>
  </div>
</template>
