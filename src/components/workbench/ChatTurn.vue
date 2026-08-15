<script setup>
// 一轮对话行（Cursor 风格）：marker + label + meta + 内容。用户轮底色带；agent 终答 markdown(Prism 高亮)。
import { ref, onMounted, onUpdated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '@/logic/markdown'
import ToolTrace from './ToolTrace.vue'
import ResourceCard from '@/components/common/ResourceCard.vue'

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
  <div ref="root" :data-role="turn.role" class="py-sm border-b border-outline-variant/40 last:border-b-0"
    :class="turn.role === 'user' ? 'pt-xs' : ''">
    <!-- 角色行 -->
    <div class="flex items-center gap-xs px-md mb-xs">
      <span class="material-symbols-outlined text-sm" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? 'person' : 'smart_toy' }}</span>
      <span class="text-body-xs font-semibold" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? t('workbench.chat.roleYou') : t('workbench.chat.roleAgent') }}</span>
      <span v-if="turn.role === 'assistant' && turn.steps" class="ml-auto text-body-xs text-on-surface-variant">{{ t('workbench.chat.stepsTaken', { n: turn.steps }) }}</span>
      <span v-if="turn.truncated" class="text-body-xs text-status-warning">⚠ {{ t('workbench.chat.contentTruncated') }}</span>
    </div>

    <!-- USER:圆角气泡带(refs+文本),与 agent 文本同左缘(px-md 对齐) -->
    <div v-if="turn.role === 'user'" class="mx-md rounded-xl bg-primary/[0.06] border border-primary/15 px-md py-sm flex flex-col gap-xs">
      <div v-if="turn.refs && turn.refs.length" class="flex flex-col gap-xs">
        <template v-for="(r, i) in turn.refs" :key="i">
          <ResourceCard v-if="r.resource" :resource="r.resource" />
          <span v-else class="text-body-xs font-mono text-primary bg-primary/10 border border-primary/20 rounded px-xs py-0.5 self-start">@{{ r.kind }}:{{ r.name }}</span>
        </template>
      </div>
      <p class="text-body-sm whitespace-pre-wrap break-words leading-relaxed">{{ turn.content }}</p>
    </div>

    <!-- AGENT -->
    <div v-else class="flex flex-col gap-sm px-md">
      <ToolTrace v-if="turn.trace && turn.trace.length" :trace="turn.trace" />

      <!-- thinking:①已收到流式文本 → 实时渲染增量(带光标);②尚无文本也无工具 → 跳动 thinking 提示 -->
      <!-- 2026-08-14 前内容只在 done 渲染 → delta 全到但看不见("不实时"的真正根因) -->
      <div v-if="turn.status === 'thinking' && turn.content" class="text-body-sm text-on-surface leading-relaxed prose-chat">
        <span v-html="renderMarkdown(turn.content)"></span><span class="inline-block w-1.5 h-4 align-text-bottom bg-primary/70 animate-pulse ml-0.5"></span>
      </div>
      <div v-else-if="turn.status === 'thinking'" class="flex items-center gap-sm">
        <span class="flex gap-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <span class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.thinking') }}</span>
        <span v-if="turn.trace && turn.trace.length" class="text-body-xs text-on-surface-variant/60 font-mono">{{ turn.trace.length }}↻</span>
      </div>

      <div v-else-if="turn.status === 'pending_approval'" class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
        <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
        <span class="text-body-sm text-status-warning font-medium">{{ t('workbench.chat.pendingApproval') }}</span>
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
