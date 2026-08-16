<script setup>
// 一轮对话行（Cursor 风格）：marker + label + meta + 内容。用户轮底色带；agent 终答 markdown(Prism 高亮)。
// 流式渲染节流(P0-3):delta 高频到达时 marked+DOMPurify 全量重解析 + Prism 整树重高亮是
// 卡顿根因——rendered 本地缓存,thinking 期 ≥150ms 才重渲染,终态(done/error)立即终渲染;
// 高亮同样 ≥600ms 节流,首帧与终帧必高亮。
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
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

// ── 节流的 markdown 渲染(P0-3) ──
const RENDER_INTERVAL = 150   // thinking 期重渲染间隔
const HIGHLIGHT_INTERVAL = 600 // thinking 期重高亮间隔
const rendered = ref('')
let lastRender = 0, lastHighlight = 0, renderTimer = null, highlightTimer = null
const isStreaming = computed(() => props.turn.status === 'thinking')

function doRender(final) {
  lastRender = Date.now()
  rendered.value = renderMarkdown(props.turn.content)
  // 高亮节流:终帧/首帧必跑;流式中 ≥HIGHLIGHT_INTERVAL 跑一次
  const now = Date.now()
  if (final || lastHighlight === 0) { scheduleHighlight(0); return }
  if (now - lastHighlight >= HIGHLIGHT_INTERVAL) scheduleHighlight(0)
  else if (!highlightTimer) scheduleHighlight(HIGHLIGHT_INTERVAL - (now - lastHighlight))
}
function scheduleHighlight(delay) {
  if (highlightTimer) { clearTimeout(highlightTimer) }
  highlightTimer = setTimeout(() => {
    highlightTimer = null
    lastHighlight = Date.now()
    nextTick(highlight)
  }, delay)
}
function scheduleRender() {
  // 首帧(空→有)与终态立即渲染;流式期间 ≥RENDER_INTERVAL 合并重渲染
  const final = !isStreaming.value
  if (final || rendered.value === '' || Date.now() - lastRender >= RENDER_INTERVAL) { doRender(final); return }
  if (!renderTimer) {
    renderTimer = setTimeout(() => { renderTimer = null; doRender(false) }, RENDER_INTERVAL - (Date.now() - lastRender))
  }
}
watch(() => [props.turn.content, props.turn.status], scheduleRender, { immediate: true })
onUnmounted(() => { if (renderTimer) clearTimeout(renderTimer); if (highlightTimer) clearTimeout(highlightTimer) })
onMounted(highlight)

// thinking 行:正在执行的工具名(尾随未配对的 tool_start)——"卡在哪"一眼可见
const runningTool = computed(() => {
  const trace = props.turn.trace || []
  for (let i = trace.length - 1; i >= 0; i--) {
    const x = trace[i]
    if (x?.type === 'tool_start') return x.name
    if (x?.type === 'tool' || x?.type === 'denied') return null
  }
  return null
})
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

      <!-- thinking:①已收到流式文本 → 实时渲染增量(带光标,节流);②尚无文本也无工具 → 跳动 thinking 提示 -->
      <div v-if="turn.status === 'thinking' && rendered" class="text-body-sm text-on-surface leading-relaxed prose-chat">
        <span v-html="rendered"></span><span class="inline-block w-1.5 h-4 align-text-bottom bg-primary/70 animate-pulse ml-0.5"></span>
      </div>
      <div v-else-if="turn.status === 'thinking'" class="flex items-center gap-sm">
        <span class="flex gap-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <span class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.thinking') }}</span>
        <!-- 正在执行的工具(如 wb_exec 30s):spinner+工具名,不再是黑盒"思考中" -->
        <span v-if="runningTool" class="flex items-center gap-xs text-body-xs text-status-running font-mono bg-status-running/5 border border-status-running/30 rounded-full px-sm py-0.5">
          <span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>{{ runningTool }}
        </span>
        <span v-else-if="turn.trace && turn.trace.length" class="text-body-xs text-on-surface-variant/60 font-mono">{{ turn.trace.length }}↻</span>
      </div>

      <div v-else-if="turn.status === 'pending_approval'" class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
        <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
        <span class="text-body-sm text-status-warning font-medium">{{ t('workbench.chat.pendingApproval') }}</span>
      </div>

      <div v-else-if="turn.status === 'error'" class="flex items-start gap-sm px-md py-sm bg-error/5 border border-error/20 rounded-xl">
        <span class="material-symbols-outlined text-base text-error mt-0.5">error</span>
        <span class="text-body-sm text-error whitespace-pre-wrap break-words">{{ turn.error }}</span>
      </div>

      <!-- done: markdown(终帧,已含节流管线) -->
      <div v-else-if="turn.status === 'done'" class="text-body-sm text-on-surface leading-relaxed prose-chat" v-html="rendered"></div>
    </div>
  </div>
</template>
