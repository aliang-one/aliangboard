<script setup>
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue'

// 通用 typeahead：输入即过滤建议，可点选也可继续手输。
// 下拉面板 Teleport 到 body 并用 fixed 定位跟随输入框——避免被祖先 overflow 容器裁剪。
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
const inputEl = ref(null)
const panelEl = ref(null)
const panelStyle = ref({ position: 'fixed', zIndex: 9999, left: '0', top: '0', width: '0' })

const norm = computed(() => props.options.map(o => typeof o === 'string' ? { value: o, label: o, desc: '' } : { value: o.value, label: o.label || o.value, desc: o.desc || '' }))
const filtered = computed(() => {
  const q = (value.value || '').toLowerCase()
  const all = norm.value
  return q ? all.filter(o => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) : all
})

function place() {
  const el = inputEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const ph = panelEl.value ? panelEl.value.offsetHeight : 240
  let top = r.bottom + 4
  // 下方放不下（输入框在视口底部）则翻到上方
  if (top + ph > window.innerHeight && r.top - ph - 4 > 8) top = r.top - ph - 4
  panelStyle.value = { position: 'fixed', zIndex: 9999, left: r.left + 'px', top: top + 'px', width: r.width + 'px' }
}
function show() { open.value = true; nextTick(place) }
function hide() { open.value = false }
function pick(o) { value.value = o.value; hide() }

function onDocMousedown(e) {
  if (!open.value) return
  const t = e.target
  if ((inputEl.value && inputEl.value.contains(t)) || (panelEl.value && panelEl.value.contains(t))) return
  hide()
}
function onScrollResize() { if (open.value) place() }   // 滚动容器滚动时跟随；窗口缩放时重定位
onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown)
  window.addEventListener('scroll', onScrollResize, true) // capture：捕获嵌套滚动容器的 scroll
  window.addEventListener('resize', onScrollResize)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMousedown)
  window.removeEventListener('scroll', onScrollResize, true)
  window.removeEventListener('resize', onScrollResize)
})

const defaultInputClass = 'w-full bg-surface-container-low border border-outline-variant rounded-md px-sm py-sm text-xs font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors'
</script>

<template>
  <div class="relative">
    <input ref="inputEl" v-model="value" @focus="show" @input="show" :placeholder="placeholder" :class="inputClass || defaultInputClass" />
    <Teleport to="body">
      <div v-if="open && filtered.length" ref="panelEl" :style="panelStyle" class="max-h-60 overflow-y-auto rounded-md border border-outline-variant bg-surface-container-lowest shadow-lg py-xs">
        <button v-for="o in filtered" :key="o.value" type="button" @mousedown.prevent="pick(o)"
          class="w-full text-left px-sm py-xs hover:bg-primary-container/15 transition-colors flex flex-col">
          <span class="text-xs font-mono text-on-surface truncate">{{ o.value }}</span>
          <span v-if="o.desc" class="text-[10px] text-on-surface-variant truncate">{{ o.desc }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
