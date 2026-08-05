<script setup>
// 端口选择器（可输可选 combobox）：下拉从已知端口选，也允许手输兜底（命名端口/跨ns/无候选）。
// options 为数字/字符串数组或 {label,value} 数组；inputClass 透传输入框样式以贴合各表单原有视觉。
import { ref, computed, watch } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  inputClass: { type: String, default: '' },
  emptyHint: { type: String, default: '无可选端口，可直接输入' },
})
const emit = defineEmits(['update:modelValue'])

const text = ref(String(props.modelValue ?? ''))
const focused = ref(false)

// 外部 modelValue 变化 → 同步输入框（父级重置后输入框跟随）
watch(() => props.modelValue, v => {
  if (String(v ?? '') !== text.value) text.value = String(v ?? '')
})

// 统一为 {label, value}
const normalized = computed(() =>
  (props.options || []).map(o => (o && typeof o === 'object' ? { label: String(o.label), value: o.value } : { label: String(o), value: o }))
)
const filtered = computed(() => {
  const q = text.value.trim().toLowerCase()
  if (!q) return normalized.value
  return normalized.value.filter(o => String(o.value).toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
})

function onInput(e) {
  text.value = e.target.value
  emit('update:modelValue', text.value)
}
function pick(o) {
  text.value = String(o.value)
  emit('update:modelValue', o.value)
  focused.value = false
}
function onBlur() {
  // 延迟关闭，确保 mousedown 点击候选先于失焦
  setTimeout(() => { focused.value = false }, 150)
}
</script>

<template>
  <div class="relative">
    <input
      :value="text"
      :placeholder="placeholder"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
      :class="['outline-none', inputClass]"
    />
    <div
      v-if="focused && filtered.length"
      class="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg max-h-48 overflow-auto"
    >
      <button
        v-for="o in filtered"
        :key="String(o.value)"
        type="button"
        @mousedown.prevent="pick(o)"
        class="w-full flex items-center justify-between gap-sm px-md py-sm text-body-sm hover:bg-primary-container/20 transition-colors text-left"
      >
        <span class="font-medium font-mono">{{ o.value }}</span>
        <span v-if="o.label !== String(o.value)" class="text-[10px] text-on-surface-variant shrink-0">{{ o.label }}</span>
      </button>
    </div>
    <div
      v-else-if="focused && !normalized.length"
      class="absolute z-30 top-full left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg px-md py-sm text-body-sm text-on-surface-variant"
    >
      {{ emptyHint }}
    </div>
  </div>
</template>
