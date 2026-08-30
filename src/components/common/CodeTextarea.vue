<script setup>
// 语法高亮编辑器(2026-08-29):透明 textarea 叠加 Prism 高亮层——编辑时即所见高亮,零新依赖。
// 结构:下层 pre(v-html=Prism 高亮,aria-hidden) + 上层 textarea(文字透明、caret 可见);
// 两层同字体/字号/行高/padding,white-space:pre + wrap=off,滚动经 @scroll 单向同步(textarea→pre)。
// 安全:高亮 HTML 与 CodeViewer 同路——Prism 产物过 DOMPurify;懒加载前为字面转义文本。
// inheritAttrs=false + textarea 上 v-bind="$attrs":调用方的 data-testid/aria 等落到真实输入元素。
import { ref, computed, watch, watchEffect, useAttrs, onMounted } from 'vue'
import DOMPurify from 'dompurify'
import { loadPrism } from '@/utils/prismLoader'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  modelValue: { type: String, default: '' },
  lang: { type: String, default: 'yaml' },
  rows: { type: [String, Number], default: 14 },
  placeholder: { type: String, default: '' },
  // 外层容器高度类(普通定高/弹窗内 flex 撑满由调用方给)
  heightClass: { type: String, default: 'h-[284px]' },
})
const emit = defineEmits(['update:modelValue'])

const attrs = useAttrs()
const ta = ref(null)
const hl = ref(null)

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

// 高亮 HTML:首帧同步转义(内容立即可见),Prism 就绪后升级(过期守卫防旧值回写)
const highlighted = ref('')
watchEffect(async () => {
  const src = props.modelValue, lang = props.lang
  if (!src) { highlighted.value = ''; return }
  highlighted.value = escapeHtml(src)
  try {
    const Prism = await loadPrism()
    if (props.modelValue !== src || props.lang !== lang) return
    const grammar = Prism.languages[lang]
    if (grammar) highlighted.value = DOMPurify.sanitize(Prism.highlight(src, grammar, lang), { USE_PROFILES: { html: true } })
  } catch { /* 保持转义文本 */ }
})

// 外部 modelValue 变化(程序性重置/表单权威回归)→ 同步可视层
watch(() => props.modelValue, () => {
  if (ta.value) ta.value.scrollTop = ta.value.scrollTop // 布局在内容变化后由浏览器保持
})

function onInput(e) {
  emit('update:modelValue', e.target.value)
  syncScroll()
}
function syncScroll() {
  if (!ta.value || !hl.value) return
  hl.value.scrollTop = ta.value.scrollTop
  hl.value.scrollLeft = ta.value.scrollLeft
}
onMounted(syncScroll)

const textareaAttrs = computed(() => {
  const { ...rest } = attrs
  return rest
})
</script>

<template>
  <div class="relative overflow-hidden rounded-lg border border-outline-variant bg-code-surface" :class="heightClass">
    <!-- 高亮层(下) -->
    <pre ref="hl" aria-hidden="true"
      class="absolute inset-0 m-0 overflow-auto p-md font-mono text-code-sm text-on-code-surface leading-[18px] whitespace-pre"><code v-html="highlighted" class="block" /></pre>
    <!-- 编辑层(上):文字透明让高亮透出,caret/选区可见 -->
    <textarea
      ref="ta" v-bind="textareaAttrs" :value="modelValue" :rows="rows" :placeholder="placeholder"
      class="absolute inset-0 w-full h-full min-h-0 overflow-auto bg-transparent p-md font-mono text-code-sm leading-[18px] text-transparent caret-primary whitespace-pre resize-none border-0 outline-none focus:ring-0 selection:bg-primary/25"
      wrap="off" spellcheck="false"
      @input="onInput" @scroll="syncScroll" />
  </div>
</template>
