<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'

// 通用 typeahead：输入即过滤建议，可点选也可继续手输。自定义下拉面板（应用主题，非原生 datalist）。
// options: string[] 或 {value,label,desc}[]。v-model 为字符串。
const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  inputClass: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const value = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })

const open = ref(false)
const wrap = ref(null)
const norm = computed(() => props.options.map(o => typeof o === 'string' ? { value: o, label: o, desc: '' } : { value: o.value, label: o.label || o.value, desc: o.desc || '' }))
const filtered = computed(() => {
  const q = (value.value || '').toLowerCase()
  const all = norm.value
  return q ? all.filter(o => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) : all
})
function onDocMousedown(e) { if (wrap.value && !wrap.value.contains(e.target)) open.value = false }
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onUnmounted(() => document.removeEventListener('mousedown', onDocMousedown))
function pick(o) { value.value = o.value; open.value = false }

const defaultInputClass = 'w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
</script>

<template>
  <div ref="wrap" class="relative">
    <input v-model="value" @focus="open = true" :placeholder="placeholder" :class="inputClass || defaultInputClass" />
    <div v-if="open && filtered.length" class="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-outline-variant bg-surface-container-lowest shadow-lg py-xs">
      <button v-for="o in filtered" :key="o.value" type="button" @mousedown.prevent="pick(o)"
        class="w-full text-left px-sm py-xs hover:bg-primary-container/15 transition-colors flex flex-col">
        <span class="text-xs font-mono text-on-surface truncate">{{ o.value }}</span>
        <span v-if="o.desc" class="text-[10px] text-on-surface-variant truncate">{{ o.desc }}</span>
      </button>
    </div>
  </div>
</template>
