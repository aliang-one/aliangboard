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
// 外部重填(openEdit 重新读 spec.resources)时同步数字框/下拉。
// 回声守卫:v-model 双向接线里,自己刚 emit 的规范串会经父组件原样回流——那不是外部
// 重填,不得 sync(formatQuantity 会把中间态规范化,回灌会吃掉 '0.' 的小数点/重写 '05')。
let lastEmitted = null
watch(() => props.modelValue, v => { if (v === lastEmitted) return; sync(v) })

function emitVal() {
  const out = formatQuantity(num.value, unit.value, props.kind)
  lastEmitted = out
  emit('update:modelValue', out)
}
// 纯受控接线(v-model 刻意不用):v-model 对 type=number 的自动 cast(looseToNumber)
// 会把中间态 '0.' 归一为 0,'0.' 的小数点在 v-model 层就丢;再叠加回声重渲染把
// DOM 归一('05'→'5'),小数核无法顺序键入。:value 直绑 num(原始串),emit 侧再规范化。
function onInput(e) { num.value = e.target.value; emitVal() }
// cores 允许小数;其余单位(m/Ki/Mi/Gi/Ti)整数
const step = computed(() => (props.kind === 'cpu' && unit.value === '') ? 'any' : '1')
</script>

<template>
  <div class="flex items-stretch">
    <input
      type="number" min="0" :step="step"
      :value="num" @input="onInput"
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
