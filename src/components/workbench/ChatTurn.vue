<script setup>
// 一轮对话行（Cursor 风格）：marker + label + meta + 内容。用户轮底色带；agent 终答 markdown(Prism 高亮)。
// 流式渲染节流(P0-3):delta 高频到达时 marked+DOMPurify 全量重解析 + Prism 整树重高亮是
// 卡顿根因——rendered 本地缓存,thinking 期 ≥150ms 才重渲染,终态(done/error)立即终渲染;
// 高亮同样 ≥600ms 节流,首帧与终帧必高亮。
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderMarkdown } from '@/logic/markdown'
import ToolTrace from './ToolTrace.vue'
import ToolTimeline from './ToolTimeline.vue'
import ToolRow from './ToolRow.vue'
import ResourceCard from '@/components/common/ResourceCard.vue'

const props = defineProps({ turn: { type: Object, required: true }, showRegenerate: { type: Boolean, default: false }, showEdit: { type: Boolean, default: false } })
const emit = defineEmits(['regenerate', 'reopen-approval', 'edit'])
const { t } = useI18n()

const root = ref(null)
// Prism 懒加载(镜像 CodeViewer.vue):首屏不拉 ~200KB;命中后缓存。languages 覆盖 chat 常见代码。
// 2026-08-28 扩充:此前仅 yaml/json/bash/js——LLM 输出的 go/python/ts/sql/toml/docker/diff/ini
// 全不上色(用户报告「代码语法没有正确展示」的一环)。typescript 依赖 javascript、docker 依赖
// ini,列于其后(prism 组件自身有依赖声明,显式列出保序)。
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
        import('prismjs/components/prism-typescript'),
        import('prismjs/components/prism-python'),
        import('prismjs/components/prism-go'),
        import('prismjs/components/prism-sql'),
        import('prismjs/components/prism-ini'),
        import('prismjs/components/prism-docker'),
        import('prismjs/components/prism-toml'),
        import('prismjs/components/prism-diff'),
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

// ── 交错渲染(2026-08-25):trace 含 assistant 文本事件 → 文本↔工具按发生顺序交错;
// 存量 trace(无 assistant 事件)回退旧布局(chips + 时间线 + 终答)。
const hasInterleave = computed(() => (props.turn.trace || []).some(e => e && e.type === 'assistant'))
// 防御:交错模式下 trace 无任何非空文本而 content 非空(数据不完整)→ 整体回退旧布局
const interleaveUsable = computed(() => {
  if (!hasInterleave.value) return false
  const texts = (props.turn.trace || []).filter(e => e && e.type === 'assistant' && e.content)
  return texts.length > 0 || !props.turn.content
})
// 交错块文本的 markdown 渲染(2026-08-28 修复):此前文本块是 {{ }} 纯文本插值——交错模式
// (带工具调用的对话几乎全走此模式)下中间轮+终答的 markdown 全部按原字符显示(代码块裸露
// ``` 围栏、加粗带星号)。「感觉不支持 markdown」的直接根因。此处预渲染成 html:
// - WeakMap 按事件对象引用缓存——trace push 不改旧元素引用,nowTick 每秒重渲染/流式 delta
//   高频更新都不触发旧块 re-parse(纯模板函数调用会每次重算);
// - 消毒走 renderMarkdown(DOMPurify),LLM 内容必须过消毒才能进 v-html。
const blockHtmlCache = new WeakMap()
const blocks = computed(() => {
  if (!interleaveUsable.value) return []
  return (props.turn.trace || [])
    .map(e => {
      if (!e) return null
      if (e.type === 'assistant') {
        const text = e.content ?? e.message?.content
        if (!text) return null
        if (!blockHtmlCache.has(e)) blockHtmlCache.set(e, renderMarkdown(text))
        return { kind: 'text', html: blockHtmlCache.get(e) }
      }
      return { kind: 'tool', event: e }
    })
    .filter(Boolean)
})

function doRender(final) {
  lastRender = Date.now()
  rendered.value = renderMarkdown(props.turn.content)
  // v-html 重渲染会重建 DOM → 代码块装饰也随帧重挂(nextTick 后)
  nextTick(decorateCodeBlocks)
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
// 交错块(中间轮文本)到达时的代码块装饰+高亮(2026-08-28 markdown 修复配套):scheduleRender
// 只盯 content/status,trace 变化(新文本块 v-html 进 DOM)不触发——不挂的话新块里的 pre
// 无复制按钮装饰、无 Prism token 色,直到 done 终帧才补。节流口径与 doRender 相同(600ms 合并)。
watch(() => props.turn.trace?.length, () => {
  nextTick(() => {
    decorateCodeBlocks()
    const now = Date.now()
    if (lastHighlight === 0 || now - lastHighlight >= HIGHLIGHT_INTERVAL) scheduleHighlight(0)
    else if (!highlightTimer) scheduleHighlight(HIGHLIGHT_INTERVAL - (now - lastHighlight))
  })
})
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

// 等待计时(dev30):长推理模型出首 token 前可能静默 30s+(用户感知为"前端不更新"),
// "思考中… 12s" 让等待可量化。起点 turn._startedAt(thinking turn 创建时打;刷新后
// 从重建时刻起算,不追求精确);≥5s 才显示。
const nowTick = ref(Date.now())
const startedAt = ref(Date.now())
let tickTimer = null
watch(() => props.turn._startedAt, v => { if (v) startedAt.value = v }, { immediate: true })
onMounted(() => { tickTimer = setInterval(() => { nowTick.value = Date.now() }, 1000) })
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer) })
const waitLabel = computed(() => {
  if (!isStreaming.value) return ''
  const s = Math.max(0, Math.floor((nowTick.value - startedAt.value) / 1000))
  return s >= 5 ? `${s}s` : ''
})

// ── P1 消息操作:复制 / 重新生成 ──
const copied = ref(false)
async function copyContent() {
  try {
    await navigator.clipboard.writeText(props.turn.content || '')
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* 剪贴板不可用(非安全上下文)静默 */ }
}

// ── 代码块复制按钮(P1):v-html 后纯 DOM 装饰 + 事件委托(v-html 内容不受 Vue 管理) ──
// 每个 <pre> 包一层 header(language 标签 + copy 按钮);点击委托到 root。
function decorateCodeBlocks() {
  if (!root.value) return
  for (const pre of root.value.querySelectorAll('.prose-chat pre')) {
    if (pre.parentElement?.classList.contains('code-block')) continue // 已装饰
    const wrap = document.createElement('div')
    wrap.className = 'code-block my-sm rounded-lg overflow-hidden border border-outline-variant/40'
    const bar = document.createElement('div')
    bar.className = 'code-bar flex items-center justify-end gap-sm px-sm py-0.5 bg-[#0b1c30]/80 text-[#cfe3ff]/60'
    const lang = pre.querySelector('code')?.className?.match(/language-([\w-]+)/)?.[1] || ''
    if (lang) {
      const label = document.createElement('span')
      label.className = 'font-mono text-body-xs mr-auto'
      label.textContent = lang
      bar.appendChild(label)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy flex items-center gap-xs font-mono text-body-xs hover:text-[#cfe3ff] transition-colors'
    btn.title = t('common.copy')
    btn.innerHTML = '<span class="material-symbols-outlined text-sm">content_copy</span>'
    bar.appendChild(btn)
    pre.replaceWith(wrap)
    wrap.append(bar, pre)
  }
}
function onRootClick(e) {
  const btn = e.target.closest?.('.code-copy')
  if (!btn) return
  const code = btn.closest('.code-block')?.querySelector('pre code')?.textContent || ''
  navigator.clipboard.writeText(code).then(() => {
    const icon = btn.querySelector('.material-symbols-outlined')
    if (icon) {
      icon.textContent = 'check'
      setTimeout(() => { icon.textContent = 'content_copy' }, 1500)
    }
  }).catch(() => { /* 静默 */ })
}
</script>

<template>
  <div ref="root" :data-role="turn.role" class="py-sm border-b border-outline-variant/40 last:border-b-0 group/turn"
    :class="turn.role === 'user' ? 'pt-xs' : ''" @click="onRootClick">
    <!-- 角色行 -->
    <div class="flex items-center gap-xs px-md mb-xs">
      <span class="material-symbols-outlined text-sm" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? 'person' : 'smart_toy' }}</span>
      <span class="text-body-xs font-semibold" :class="turn.role === 'user' ? 'text-primary' : 'text-on-surface-variant'">{{ turn.role === 'user' ? t('workbench.chat.roleYou') : t('workbench.chat.roleAgent') }}</span>
      <span v-if="turn.truncated" class="text-body-xs text-status-warning">⚠ {{ t('workbench.chat.contentTruncated') }}</span>
      <!-- 消息操作(hover 显现;复制终态可用,重新生成仅最后一条 assistant) -->
      <span v-if="turn.role === 'assistant'" class="ml-auto flex items-center gap-xs">
        <span v-if="turn.steps" class="text-body-xs text-on-surface-variant">{{ t('workbench.chat.stepsTaken', { n: turn.steps }) }}</span>
        <button v-if="turn.status === 'done'" @click.stop="copyContent" type="button"
          class="p-0.5 rounded text-on-surface-variant/50 hover:text-on-surface opacity-0 group-hover/turn:opacity-100 transition-opacity"
          :title="t('common.copy')">
          <span class="material-symbols-outlined text-sm">{{ copied ? 'check' : 'content_copy' }}</span>
        </button>
        <button v-if="showRegenerate" @click.stop="emit('regenerate')" type="button"
          class="p-0.5 rounded text-on-surface-variant/50 hover:text-primary opacity-0 group-hover/turn:opacity-100 transition-opacity"
          :title="t('workbench.chat.regenerate')">
          <span class="material-symbols-outlined text-sm">refresh</span>
        </button>
      </span>
      <!-- 编辑重发(T3):user 消息 hover 编辑入口,emit edit(载荷=turn) -->
      <span v-if="turn.role === 'user' && showEdit" class="ml-auto flex items-center gap-xs">
        <button data-testid="edit-msg-btn" @click.stop="emit('edit')" type="button"
          class="p-0.5 rounded text-on-surface-variant/50 hover:text-primary opacity-0 group-hover/turn:opacity-100 transition-opacity"
          :title="t('workbench.chat.editTitle')">
          <span class="material-symbols-outlined text-sm">edit</span>
        </button>
      </span>
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
      <!-- chips 总览仅回退布局(2026-08-27 审计):交错模式下每个工具已在流内有 ToolRow
           (时刻+名称+预览+详情),chips 再放一份=同屏双显;无 assistant 文本的存量 trace 才走 chips -->
      <ToolTrace v-if="!interleaveUsable && turn.trace && turn.trace.length" :trace="turn.trace" />

      <!-- 步数用尽醒目警告(2026-08-27 静默终止审计):done+truncated 此前只有角色行 ⚠ 小标,
           用户等数分钟拿到一行灰字"(达到最大步数…)"观感即"异常结束无提示"——加可读警告块。 -->
      <div v-if="turn.truncated" class="flex items-start gap-sm px-md py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
        <span class="material-symbols-outlined text-base text-status-warning mt-0.5">warning</span>
        <span class="text-body-sm text-status-warning leading-relaxed">{{ t('workbench.chat.maxStepsReached') }}</span>
      </div>

      <!-- 交错流:文本↔工具行按发生顺序(中间文本+终答都在块序列里);thinking 时当前轮流式文本为末段。
           文本块走 markdown 渲染(v-html,renderMarkdown 已消毒;prose-chat 全局排版样式) -->
      <div v-if="interleaveUsable" data-testid="interleaved-flow" class="flex flex-col gap-sm">
        <template v-for="(b, i) in blocks" :key="i">
          <div v-if="b.kind === 'text'" class="text-body-sm text-on-surface leading-relaxed prose-chat break-words" v-html="b.html"></div>
          <ToolRow v-else :event="b.event" />
        </template>
        <div v-if="isStreaming && rendered" class="text-body-sm text-on-surface leading-relaxed prose-chat">
          <span v-html="rendered"></span><span class="inline-block w-1.5 h-4 align-text-bottom bg-primary/70 animate-pulse ml-0.5"></span>
        </div>
      </div>

      <!-- 回退布局(存量 trace 无 assistant 文本):时间线 + 终答分列 -->
      <ToolTimeline v-else-if="turn.trace && turn.trace.length" :trace="turn.trace" />

      <!-- 思考过程(reasoning_content,深思考模型):流式时展开实时滚动,终答后自动收起可回看 -->
      <details v-if="turn.reasoning" :open="isStreaming" class="group/reasoning bg-surface-container-low/60 border border-outline-variant/50 rounded-lg">
        <summary class="cursor-pointer select-none px-sm py-xs text-body-xs text-on-surface-variant flex items-center gap-xs hover:text-on-surface">
          <span class="material-symbols-outlined text-sm" :class="isStreaming ? 'animate-spin text-primary/70' : ''">{{ isStreaming ? 'progress_activity' : 'psychology' }}</span>
          {{ t('workbench.chat.reasoningTitle') }}
          <span class="ml-auto text-on-surface-variant/50 font-mono">{{ turn.reasoning.length }}</span>
        </summary>
        <div class="px-sm pb-sm max-h-64 overflow-y-auto text-body-xs text-on-surface-variant whitespace-pre-wrap break-words leading-relaxed border-t border-outline-variant/40 pt-xs">{{ turn.reasoning }}</div>
      </details>

      <!-- thinking(回退布局;交错模式的流式末段在上方交错流内):①已收到流式文本 → 实时渲染;②跳动提示 -->
      <div v-if="!interleaveUsable && turn.status === 'thinking' && rendered" class="text-body-sm text-on-surface leading-relaxed prose-chat">
        <span v-html="rendered"></span><span class="inline-block w-1.5 h-4 align-text-bottom bg-primary/70 animate-pulse ml-0.5"></span>
      </div>
      <div v-else-if="turn.status === 'thinking'" class="flex items-center gap-sm">
        <span class="flex gap-0.5">
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
        </span>
        <span class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.thinking') }}</span>
        <span v-if="waitLabel" class="text-body-xs text-on-surface-variant/50 font-mono">{{ waitLabel }}</span>
        <!-- 正在执行的工具(如 wb_exec 30s):spinner+工具名,不再是黑盒"思考中" -->
        <span v-if="runningTool" class="flex items-center gap-xs text-body-xs text-status-running font-mono bg-status-running/5 border border-status-running/30 rounded-full px-sm py-0.5">
          <span class="material-symbols-outlined text-sm animate-spin">progress_activity</span>{{ runningTool }}
        </span>
        <span v-else-if="turn.trace && turn.trace.length" class="text-body-xs text-on-surface-variant/60 font-mono">{{ turn.trace.length }}↻</span>
      </div>

      <!-- N2(2026-08-27 modal 审计):黄条可点击重开审批 modal——ESC/遮罩收起后轮询已停/SSE 已断,
           不会再自动重弹;无重开入口 = 审批死锁(只能刷新页面)。 -->
      <div v-else-if="turn.status === 'pending_approval'" data-testid="pending-approval-bar" @click="emit('reopen-approval')"
        :title="t('workbench.chat.reopenApproval')"
        class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl cursor-pointer hover:bg-status-warning/10 hover:border-status-warning/60 transition-colors">
        <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
        <span class="text-body-sm text-status-warning font-medium">{{ t('workbench.chat.pendingApproval') }}</span>
        <span class="material-symbols-outlined text-sm text-status-warning/60 ml-auto">open_in_new</span>
      </div>

      <div v-else-if="turn.status === 'error'" class="flex items-start gap-sm px-md py-sm bg-error/5 border border-error/20 rounded-xl">
        <span class="material-symbols-outlined text-base text-error mt-0.5">error</span>
        <span class="text-body-sm text-error whitespace-pre-wrap break-words">{{ turn.error }}</span>
      </div>

      <!-- done(回退布局;交错模式终答已在块序列里,防重复):markdown 终帧 -->
      <div v-else-if="!interleaveUsable && turn.status === 'done'" class="text-body-sm text-on-surface leading-relaxed prose-chat" v-html="rendered"></div>
    </div>
  </div>
</template>
