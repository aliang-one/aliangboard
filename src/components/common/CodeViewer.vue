<script setup>
// 代码高亮查看器：用 Prism.js 按语言高亮代码，暗底配色走 code-surface 主题（见 src/styles/code-theme.js）。
// 语言由调用方按文件扩展名传入（yaml/json/toml/ini/properties/bash/python/javascript/typescript
// /markup/css/clike/c/cpp/java/csharp/go/rust/sql/php/ruby/markdown/graphql/docker/makefile/diff/none）。
import { ref, watchEffect } from 'vue'

const props = defineProps({
  code: { type: String, default: '' },
  lang: { type: String, default: 'none' },
  maxHeight: { type: String, default: '55vh' },
})

// Prism + 语法 + 主题懒加载：仅在组件首次渲染时拉取（~200KB），移出首屏。命中后缓存复用。
// 依赖顺序：clike → javascript → typescript；c → cpp；markup-templating → php。按序 await import 确保 dependent 在 dependency 之后注册。
let PrismPromise = null
function loadPrism() {
  if (!PrismPromise) {
    PrismPromise = (async () => {
      const Prism = (await import('prismjs')).default
      // 原有
      await import('prismjs/components/prism-json')
      await import('prismjs/components/prism-yaml')
      await import('prismjs/components/prism-toml')
      await import('prismjs/components/prism-ini')
      await import('prismjs/components/prism-properties')
      await import('prismjs/components/prism-bash')
      await import('prismjs/components/prism-python')
      // 新增：基础 + 依赖链
      await import('prismjs/components/prism-markup')      // html/xml/svg/rss
      await import('prismjs/components/prism-css')
      await import('prismjs/components/prism-clike')
      await import('prismjs/components/prism-c')            // c/h
      await import('prismjs/components/prism-cpp')          // 依赖 c
      await import('prismjs/components/prism-java')
      await import('prismjs/components/prism-csharp')
      await import('prismjs/components/prism-javascript')
      await import('prismjs/components/prism-typescript')   // 依赖 javascript
      await import('prismjs/components/prism-go')
      await import('prismjs/components/prism-rust')
      await import('prismjs/components/prism-sql')
      await import('prismjs/components/prism-markup-templating') // prism-php 依赖
      await import('prismjs/components/prism-php')
      await import('prismjs/components/prism-ruby')
      await import('prismjs/components/prism-markdown')
      await import('prismjs/components/prism-graphql')
      await import('prismjs/components/prism-docker')       // 注册 id 'docker'（Dockerfile 映射用）
      await import('prismjs/components/prism-makefile')
      await import('prismjs/components/prism-diff')
      await import('prismjs/themes/prism-tomorrow.css')
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
  <pre class="bg-code-surface p-md rounded-lg overflow-auto" :style="{ maxHeight }"><code v-html="highlighted" class="font-mono text-code-sm text-on-code-surface leading-[18px] block"></code></pre>
</template>
