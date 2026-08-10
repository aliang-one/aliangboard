<script setup>
// 一轮对话行（Cursor 风格）：marker + label + meta + 内容。用户轮底色带；agent 终答 markdown(Prism 高亮)。
import { ref, onMounted, onUpdated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '@/logic/markdown'
import ToolTrace from './ToolTrace.vue'

const props = defineProps({ turn: { type: Object, required: true } })
const { t } = useI18n()

const root = ref(null)
// Prism 懒加载(镜像 CodeViewer.vue):首屏不拉 ~200KB;命中后缓存。languages 覆盖 chat 常见代码。
let PrismPromise = null
function loadPrism() {
  if (!PrismPromise) {
    PrismPromise = (async () => {
      const Prism = (await import('prismjs')).default
      await Promise.all([
        import('prismjs/components/prism-yaml'),
        import('prismjs/components/prism-json'),
        import('prismjs/components/prism-bash'),
        import('prismjs/components/prism-javascript'),
        import('prismjs/themes/prism-tomorrow.css'),
      ])
      return Prism
    })()
  }
  return PrismPromise
}
async function highlight() {
  if (!root.value) return
  try { const Prism = await loadPrism(); Prism.highlightAllUnder(root.value) } catch { /* 降级:不高亮 */ }
}
onMounted(highlight)
onUpdated(() => nextTick(highlight))
</script>

<template>
  <div ref="root" :data-role="turn.role" class="px-md py-sm border-b border-outline-variant/40"
    :class="turn.role === 'user' ? 'bg-primary/[0.04]' : ''">
    <!-- 角色行 -->
    <div class="flex items-center gap-xs mb-xs">
      <span class="material-symbols-outlined text-sm" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? 'person' : 'smart_toy' }}</span>
      <span class="text-body-xs font-semibold" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? t('workbench.chat.roleYou') : t('workbench.chat.roleAgent') }}</span>
      <span v-if="turn.role === 'assistant' && turn.steps" class="ml-auto text-body-xs text-on-surface-variant">{{ turn.steps }} steps</span>
      <span v-if="turn.truncated" class="text-body-xs text-status-warning">⚠ truncated</span>
    </div>

    <!-- USER -->
    <div v-if="turn.role === 'user'">
      <div v-if="turn.refs && turn.refs.length" class="flex flex-wrap gap-xs mb-xs">
        <span v-for="(r, i) in turn.refs" :key="i" class="text-body-xs font-mono text-primary bg-primary/10 border border-primary/20 rounded px-xs py-0.5">@{{ r.kind }}:{{ r.name }}</span>
      </div>
      <p class="text-body-sm whitespace-pre-wrap break-words leading-relaxed">{{ turn.content }}</p>
    </div>

    <!-- AGENT -->
    <div v-else class="flex flex-col gap-sm">
      <ToolTrace v-if="turn.trace && turn.trace.length" :trace="turn.trace" />

      <div v-if="turn.status === 'thinking' && !(turn.trace && turn.trace.length)" class="flex items-center gap-sm">
        <span class="flex gap-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <span class="text-body-sm text-on-surface-variant">Thinking...</span>
      </div>

      <div v-else-if="turn.status === 'pending_approval'" class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
        <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
        <span class="text-body-sm text-status-warning font-medium">Waiting for approval...</span>
      </div>

      <div v-else-if="turn.status === 'error'" class="flex items-start gap-sm px-md py-sm bg-error/5 border border-error/20 rounded-xl">
        <span class="material-symbols-outlined text-base text-error mt-0.5">error</span>
        <span class="text-body-sm text-error whitespace-pre-wrap break-words">{{ turn.error }}</span>
      </div>

      <!-- done: markdown -->
      <div v-else-if="turn.status === 'done'" class="text-body-sm text-on-surface leading-relaxed prose-chat" v-html="renderMarkdown(turn.content)"></div>
    </div>
  </div>
</template>
