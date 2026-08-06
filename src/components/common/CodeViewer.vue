<script setup>
// 代码高亮查看器：用 Prism.js 按语言高亮代码，暗底配色匹配 YamlEditor 的 #0b1c30。
// 语言由调用方按文件扩展名传入（yaml/json/toml/ini/properties/bash/markup/none）。
import { ref, watchEffect } from 'vue'

const props = defineProps({
  code: { type: String, default: '' },
  lang: { type: String, default: 'none' },
  maxHeight: { type: String, default: '55vh' },
})

// Prism + 语法 + 主题懒加载：仅在组件首次渲染时拉取（~200KB），移出首屏。命中后缓存复用。
let PrismPromise = null
function loadPrism() {
  if (!PrismPromise) {
    PrismPromise = (async () => {
      const Prism = (await import('prismjs')).default
      await Promise.all([
        import('prismjs/components/prism-json'),
        import('prismjs/components/prism-yaml'),
        import('prismjs/components/prism-toml'),
        import('prismjs/components/prism-ini'),
        import('prismjs/components/prism-properties'),
        import('prismjs/components/prism-bash'),
        import('prismjs/components/prism-python'),
        import('prismjs/components/prism-javascript'),
        import('prismjs/components/prism-typescript'),
        import('prismjs/themes/prism-tomorrow.css'),
      ])
      return Prism
    })()
  }
  return PrismPromise
}

// 高亮结果：Prism 加载前先显示原始代码（仅详情页可见），加载后异步高亮；code/lang 变化重算。
const highlighted = ref(props.code)
watchEffect(async () => {
  if (!props.code || props.lang === 'none') { highlighted.value = props.code; return }
  try {
    const Prism = await loadPrism()
    const grammar = Prism.languages[props.lang]
    highlighted.value = grammar ? Prism.highlight(props.code, grammar, props.lang) : props.code
  } catch { highlighted.value = props.code }
})
</script>

<template>
  <pre class="bg-[#0b1c30] p-md rounded-lg overflow-auto" :style="{ maxHeight }"><code v-html="highlighted" class="font-mono text-code-sm text-[#cfe3ff] leading-[18px] block"></code></pre>
</template>
