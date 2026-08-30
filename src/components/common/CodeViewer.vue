<script setup>
// 代码高亮查看器：用 Prism.js 按语言高亮代码，暗底配色走 code-surface 主题（见 src/styles/code-theme.js）。
// 语言由调用方按文件扩展名传入（yaml/json/toml/ini/properties/bash/python/javascript/typescript
// /markup/css/clike/c/cpp/java/csharp/go/rust/sql/php/ruby/markdown/graphql/docker/makefile/diff/none）。
// 安全(2026-08-28 CSO 审计 #1):code 来源含集群可控内容(pod 文件/ConfigMap 值/资源 YAML),
// 全部进 v-html 前必须消毒——
//   · 无高亮路径(none/无 grammar/加载失败)= 字面展示 → escapeHtml 实体转义(不渲染活元素);
//   · Prism 路径产物 = HTML 标记 → DOMPurify(与 src/logic/markdown.js 同配置,纵深防御);
//   · 初始值 = ''(Prism 异步加载完成前绝不裸渲原文,消灭首帧窗口)。
import { ref, watchEffect } from 'vue'
import DOMPurify from 'dompurify'

const props = defineProps({
  code: { type: String, default: '' },
  lang: { type: String, default: 'none' },
  maxHeight: { type: String, default: '55vh' },
})

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

// Prism + 语法 + 主题懒加载：仅在组件首次渲染时拉取（~200KB），移出首屏。命中后缓存复用。
// 依赖顺序：clike → javascript → typescript；c → cpp；markup-templating → php。按序 await import 确保 dependent 在 dependency 之后注册。
// Prism 懒加载抽到共享 prismLoader(CodeTextarea 编辑器同用)
import { loadPrism } from '@/utils/prismLoader'

// 高亮结果：首帧同步渲染转义文本(绝不裸渲原文,内容立即可见);Prism 异步加载后再升级为
// 高亮 HTML(过 DOMPurify)。none/无 grammar/失败 → 停留在转义文本。过期守卫:await 后
// props 已变(新一轮 effect 接管)则丢弃本次写入,防旧值回写竞态。
const highlighted = ref('')
watchEffect(async () => {
  const src = props.code, lang = props.lang
  if (!src) { highlighted.value = ''; return }
  if (lang === 'none') { highlighted.value = escapeHtml(src); return }
  highlighted.value = escapeHtml(src) // 同步首帧:字面转义,立即可见且安全
  try {
    const Prism = await loadPrism()
    if (props.code !== src || props.lang !== lang) return
    const grammar = Prism.languages[lang]
    if (grammar) highlighted.value = DOMPurify.sanitize(Prism.highlight(src, grammar, lang), { USE_PROFILES: { html: true } })
  } catch { /* 保持转义文本 */ }
})
</script>

<template>
  <pre class="bg-code-surface p-md rounded-lg overflow-auto" :style="{ maxHeight }"><code v-html="highlighted" class="font-mono text-code-sm text-on-code-surface leading-[18px] block"></code></pre>
</template>
