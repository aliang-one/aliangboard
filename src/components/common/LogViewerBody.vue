<script setup>
// 共享 Pod 日志查看器：PodDetail logs tab（内嵌）与 LogPopup（新标签页）同源。
// 工具栏：查询（容器/tail/since/previous/follow）+ 搜索（正则开关）+ 级别过滤 + 显示（折行/时间戳）+ 操作（刷新/下载/复制）。
// 智能滚动：贴底自动跟随，上滚暂停并显示「回到底部（N 新行）」。
import { ref, computed, watch, onMounted, nextTick, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLogViewer, LOG_LINE_OPTIONS, LOG_SINCE_OPTIONS } from '@/composables/useLogViewer'
import { compileFilter, isNearBottom, levelCounts } from '@/logic/podLogs'
import { useIsPhone } from '@/composables/useBreakpoint'

const { t } = useI18n()
const { isPhone } = useIsPhone()
// 手机档字号调节:渲染区 fontSize 覆盖 text-code-sm 默认观感(10~18px 钳制)
const fontSize = ref(12)
function adjustFont(delta) { fontSize.value = Math.min(18, Math.max(10, fontSize.value + delta)) }
// since 下拉的 i18n 键映射（静态字面量，i18n:check 可校验；动态拼接会被判引用键缺失）
const SINCE_LABEL_KEYS = {
  '': 'component.logViewer.since_all',
  '300': 'component.logViewer.since_300',
  '900': 'component.logViewer.since_900',
  '3600': 'component.logViewer.since_3600',
  '21600': 'component.logViewer.since_21600',
}
const props = defineProps({
  namespace: { type: String, required: true },
  podName: { type: String, required: true },
  containers: { type: Array, default: () => [] },
})
// 容器双向绑定：PodDetail 跨 tab 共享 selectedContainer；LogPopup 自持
const container = defineModel('container', { type: String, default: '' })
if (!container.value && props.containers.length) container.value = props.containers[0]
watch(() => props.containers, cs => { if (!cs.includes(container.value)) container.value = cs[0] || '' })

// 解构保持模板自动解包（viewer.lines 嵌套 ref 不会解包）
const { lines, followLog, logLines, logSince, logPrevious, streamError, totalAppended, restart } = useLogViewer({
  namespace: toRef(props, 'namespace'),
  podName: toRef(props, 'podName'),
  container,
})

// === 搜索 / 级别过滤（纯前端，作用于已加载行）===
const search = ref('')
const useRegex = ref(false)
const activeLevels = ref(['ERROR', 'WARN', 'INFO'])
const filter = computed(() => compileFilter({ search: search.value, useRegex: useRegex.value, levels: activeLevels.value }))
const visibleLines = computed(() => lines.value.filter(l => filter.value.test(l)))
const counts = computed(() => levelCounts(lines.value))
function toggleLevel(lv) {
  activeLevels.value = activeLevels.value.includes(lv)
    ? activeLevels.value.filter(x => x !== lv)
    : [...activeLevels.value, lv]
}
const LEVEL_CHIPS = [
  { lv: 'ERROR', on: 'bg-error/15 text-error border-error/40' },
  { lv: 'WARN', on: 'bg-tertiary-container/15 text-tertiary-container border-tertiary-container/40' },
  { lv: 'INFO', on: 'bg-primary-container/10 text-primary border-primary/30' },
]
// 等级标签色:渲染区为恒暗底 code-surface,fixed 系 = 固定暗面安全变体;
// INFO 用 primary-fixed-dim(#4edea3)与工具栏 INFO chip 的 primary 身份一致。
const LEVEL_COLORS = {
  ERROR: 'text-error',
  WARN: 'text-tertiary-fixed-dim',
  INFO: 'text-primary-fixed-dim',
}
const levelColor = lv => LEVEL_COLORS[lv] || 'text-on-code-surface/60'

// === 显示选项 ===
const wrap = ref(true)
const showTs = ref(true)

// === 智能自动滚动 ===
const scrollEl = ref(null)
const following = ref(true)
const pausedNew = ref(0)
function onScroll() {
  const el = scrollEl.value
  if (!el) return
  if (isNearBottom(el)) { following.value = true; pausedNew.value = 0 }
  else following.value = false
}
// 监听单调累计追加数（缓冲打满后 lines.length 恒定在 cap，length watch 会静默失效）
let lastAppended = 0
watch(() => totalAppended.value, n => {
  const delta = n - lastAppended
  lastAppended = n
  if (!delta) return
  if (following.value) { nextTick(() => { const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight }) }
  else pausedNew.value += delta
})
function backToBottom() {
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
  following.value = true
  pausedNew.value = 0
}
onMounted(async () => { await nextTick(); const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight })

// === 导出（WYSIWYG：过滤后的可见行）===
function formatLines() {
  return visibleLines.value.map(l => `${showTs.value ? l.timestamp + ' ' : ''}[${l.level}] ${l.message}`).join('\n')
}
function downloadLogs() {
  const blob = new Blob([formatLines()], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.podName}-logs.txt`
  a.click()
  URL.revokeObjectURL(url)
}
async function copyLogs() {
  try { await navigator.clipboard.writeText(formatLines()) } catch { /* clipboard 不可用静默 */ }
}
</script>

<template>
  <div class="relative flex flex-col min-h-0 h-full">
    <!-- 错误横幅：流中断/拉取失败 -->
    <div v-if="streamError" data-testid="log-error-banner" class="flex items-center gap-xs px-md py-1 bg-error/10 text-error text-body-xs border-b border-error/30 shrink-0">
      <span class="material-symbols-outlined text-sm">error</span>{{ followLog ? t('component.logViewer.streamInterrupted') : t('component.logViewer.loadFailed') }}
      <button @click="restart" class="ml-auto underline">{{ t('component.logViewer.retry') }}</button>
    </div>

    <!-- 工具栏·第一行:数据源 -->
    <div data-testid="log-toolbar-row-1" class="bg-surface-container-highest/50 px-md py-1.5 flex items-center gap-md border-b border-outline-variant shrink-0" :class="isPhone ? 'max-sm:flex-wrap max-sm:gap-sm max-sm:py-1' : ''">
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.container') }}</span>
        <select v-model="container" data-testid="log-container" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :class="isPhone ? 'max-sm:min-h-[40px]' : ''">
          <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.lines') }}</span>
        <select v-model="logLines" data-testid="log-lines" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :class="isPhone ? 'max-sm:min-h-[40px]' : ''">
          <option v-for="n in LOG_LINE_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.since') }}</span>
        <select v-model="logSince" data-testid="log-since" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :class="isPhone ? 'max-sm:min-h-[40px]' : ''">
          <option v-for="o in LOG_SINCE_OPTIONS" :key="o.value" :value="o.value">{{ t(SINCE_LABEL_KEYS[o.value] || 'component.logViewer.since_all') }}</option>
        </select>
      </div>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="[logPrevious ? 'text-tertiary-container font-medium' : 'text-on-surface-variant', isPhone ? 'max-sm:py-1' : '']" :title="t('component.logViewer.previousHint')">
        <input v-model="logPrevious" data-testid="log-previous" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm font-medium">{{ t('component.logViewer.previous') }}</span>
      </label>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="[logPrevious ? 'text-on-surface-variant/50' : 'text-on-surface-variant', isPhone ? 'max-sm:py-1' : '']">
        <input v-model="followLog" data-testid="log-follow" :disabled="logPrevious" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm">{{ t('component.logViewer.follow') }}</span>
        <span v-if="followLog" class="flex items-center gap-xs ml-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full">
          <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('component.logViewer.live') }}
        </span>
      </label>
    </div>

    <!-- 工具栏·第二行:查看控制 -->
    <div data-testid="log-toolbar-row-2" class="bg-surface-container-highest/30 px-md py-1.5 flex items-center gap-md border-b border-outline-variant shrink-0" :class="isPhone ? 'max-sm:flex-wrap max-sm:gap-sm max-sm:py-1' : ''">
      <div class="flex items-center gap-xs flex-1 min-w-40">
        <span class="material-symbols-outlined text-body-base text-on-surface-variant">search</span>
        <input v-model="search" data-testid="log-search" type="text" :placeholder="t('component.logViewer.searchPlaceholder')" class="flex-1 min-w-0 h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        <label class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="useRegex ? 'text-primary font-medium' : 'text-on-surface-variant'" :title="t('component.logViewer.regexHint')">
          <input v-model="useRegex" data-testid="log-regex" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.regex') }}
        </label>
        <span v-if="filter.error" data-testid="log-regex-error" class="text-error text-body-xs">{{ t('component.logViewer.invalidRegex') }}</span>
      </div>
      <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
      <div class="flex items-center gap-1">
        <button v-for="c in LEVEL_CHIPS" :key="c.lv" data-testid="log-level" @click="toggleLevel(c.lv)"
          class="px-sm py-0.5 rounded-full text-[11px] font-mono border transition-colors"
          :class="activeLevels.includes(c.lv) ? [c.on, 'font-semibold'] : 'border-outline-variant/50 text-on-surface-variant/40'">
          {{ c.lv }}<span class="ml-1 tabular-nums opacity-80">{{ counts[c.lv] }}</span>
        </button>
      </div>
      <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
      <label :title="t('component.logViewer.wrapHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="wrap ? 'text-primary font-medium' : 'text-on-surface-variant'">
        <input v-model="wrap" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.wrap') }}
      </label>
      <label :title="t('component.logViewer.timestampsHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="showTs ? 'text-primary font-medium' : 'text-on-surface-variant'">
        <input v-model="showTs" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.timestamps') }}
      </label>
      <div class="flex items-center gap-1 ml-auto">
        <template v-if="isPhone">
          <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
          <button data-testid="log-font-down" @click="adjustFont(-1)" :aria-label="t('component.logViewer.fontHint')" :title="t('component.logViewer.fontHint')"
            class="px-sm min-h-[40px] rounded-lg hover:bg-surface-container-low text-body-sm font-mono">A-</button>
          <button data-testid="log-font-up" @click="adjustFont(1)" :aria-label="t('component.logViewer.fontHint')" :title="t('component.logViewer.fontHint')"
            class="px-sm min-h-[40px] rounded-lg hover:bg-surface-container-low text-body-base font-mono">A+</button>
        </template>
        <button @click="restart" :title="t('component.logViewer.refresh')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors" :class="isPhone ? 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center' : ''"><span class="material-symbols-outlined text-body-md">refresh</span></button>
        <button @click="downloadLogs" :title="t('component.logViewer.download')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors" :class="isPhone ? 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center' : ''"><span class="material-symbols-outlined text-body-md">download</span></button>
        <button @click="copyLogs" :title="t('component.logViewer.copy')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors" :class="isPhone ? 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center' : ''"><span class="material-symbols-outlined text-body-md">content_copy</span></button>
      </div>
    </div>

    <!-- 状态行 -->
    <div class="px-md py-0.5 text-[11px] text-on-surface-variant/60 border-b border-outline-variant/50 shrink-0">{{ t('component.logViewer.stat', { loaded: lines.length, visible: visibleLines.length }) }}</div>

    <!-- 渲染区 -->
    <div ref="scrollEl" data-testid="log-scroll" @scroll="onScroll" :style="isPhone ? { fontSize: fontSize + 'px', lineHeight: Math.round(fontSize * 1.5) + 'px' } : null" class="flex-1 min-h-0 overflow-auto bg-code-surface text-on-code-surface p-md font-mono text-code-sm code-scroll" :class="wrap ? '' : '[&>div]:whitespace-pre [&>div]:overflow-x-visible'">
      <p v-if="!visibleLines.length" class="text-on-code-surface/60 py-md text-center">{{ t('component.logViewer.empty') }}</p>
      <div v-for="(log, idx) in visibleLines" :key="idx" data-testid="log-line" class="break-all" :class="[(isPhone ? '' : 'leading-relaxed'), wrap ? 'whitespace-pre-wrap' : 'whitespace-pre']">
        <span v-if="showTs" class="text-on-code-surface/50">{{ log.timestamp }} </span>
        <span data-testid="log-level-tag" :class="levelColor(log.level)">[{{ log.level }}]</span>
        <span v-for="(seg, si) in filter.highlight(log.message)" :key="si" :data-testid="seg.hit ? 'log-highlight' : undefined" :class="seg.hit ? 'bg-code-surface-selection text-on-code-surface rounded-sm' : ''">{{ seg.text }}</span>
      </div>
      <div v-if="followLog" class="w-1.5 h-4 bg-primary inline-block animate-pulse ml-1 align-middle"></div>
    </div>

    <!-- 回到底部悬浮按钮（follow 中用户上滚时出现） -->
    <button v-if="followLog && !following" data-testid="back-to-bottom" @click="backToBottom"
      class="absolute bottom-4 right-4 flex items-center gap-xs px-sm py-1 rounded-full bg-surface-container-high border border-outline-variant shadow-card text-body-xs text-primary hover:bg-surface-container-highest transition-colors">
      <span class="material-symbols-outlined text-sm">arrow_downward</span>{{ t('component.logViewer.backToBottom', { n: pausedNew }) }}
    </button>
  </div>
</template>
