<script setup>
// 代码高亮查看器：用 Prism.js 按语言高亮代码，暗底配色匹配 YamlEditor 的 #0b1c30。
// 语言由调用方按文件扩展名传入（yaml/json/toml/ini/properties/bash/markup/none）。
import { computed } from 'vue'
import Prism from 'prismjs'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-ini'
import 'prismjs/components/prism-properties'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-typescript'
import 'prismjs/themes/prism-tomorrow.css'

const props = defineProps({
  code: { type: String, default: '' },
  lang: { type: String, default: 'none' },
  maxHeight: { type: String, default: '55vh' },
})

const highlighted = computed(() => {
  const grammar = Prism.languages[props.lang]
  if (!props.code || props.lang === 'none' || !grammar) return props.code
  try { return Prism.highlight(props.code, grammar, props.lang) } catch { return props.code }
})
</script>

<template>
  <pre class="bg-[#0b1c30] p-md rounded-lg overflow-auto" :style="{ maxHeight }"><code v-html="highlighted" class="font-mono text-code-sm text-[#cfe3ff] leading-[18px] block"></code></pre>
</template>
