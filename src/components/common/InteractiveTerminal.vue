<script>
// 手机虚拟按键字节表(VT100/xterm 标准):无物理键盘时的 exec 刚需(spec §5)
export const KEY_BYTES = { 'Esc': '\x1b', 'Tab': '\t', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', 'Ctrl+C': '\x03' }
// 手机档字号热调(Task 2,mobile Wave 3):8~20px 钳制,默认=创建 term 的 fontSize(13)
export const FONT_MIN = 8, FONT_MAX = 20
export const clampFont = n => Math.min(FONT_MAX, Math.max(FONT_MIN, n))
</script>

<script setup>
// Pod exec 终端：浏览器 xterm.js ↔ Gateway WebSocket ↔ K8s（client-node exec）。
// 鲁棒性：默认走 PATH 解析的 sh；用户可选 bash/ash/绝对路径/自定义命令；
// 所选 shell 不可用（无输出即退出）时自动降级尝试下一个，全失败则提示用「调试容器」。
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useClusterStore } from '@/stores/cluster'
import { execStream, api } from '@/api/client'
import { codeTheme } from '@/styles/code-theme'
import { useIsPhone } from '@/composables/useBreakpoint'

const { t } = useI18n()
const { isPhone } = useIsPhone()

const props = defineProps({
  podName: { type: String, default: '' },
  namespace: { type: String, default: '' },
  container: { type: String, default: '' },
  sessionId: { type: String, default: '' },
  attach: { type: Boolean, default: false },   // true = kubectl attach（连主进程 stdio），否则 exec 开 shell
  autoConnect: { type: Boolean, default: false }, // true = 挂载即自动连接（浮动窗口模式）
  // 单行头部收编(2026-09-08):false = 内嵌(PodDetail,现状装饰圆点) | 'window' = 浮窗
  // (●●● 变真窗口钮 + 头部即拖拽把手 + open_in_new + 双击改名) | 'page' = 独立标签页(仅红点=关窗)。
  chrome: { type: [Boolean, String], default: false },
  title: { type: String, default: '' },           // chrome='window' 头部显示名(=terminal.name)
  maximized: { type: Boolean, default: false },   // 绿点字形(最大化/还原)状态,由壳层 maximize-change 回灌
})
const emit = defineEmits(['win-close', 'win-minimize', 'win-maximize', 'open-external', 'rename'])

const isChrome = computed(() => props.chrome === 'window' || props.chrome === 'page')
const isWindowChrome = computed(() => props.chrome === 'window')

// 双击改名(2026-09-08 自 TerminalWindow 壳层标题栏迁入,浮窗头部承担)
const editing = ref(false)
const nameInput = ref('')
function startRename() {
  if (!isWindowChrome.value) return
  nameInput.value = props.title
  editing.value = true
}
function saveRename() {
  const v = nameInput.value.trim()
  editing.value = false
  if (v && v !== props.title) emit('rename', v)
}
// 外部改名生效(同窗口他处改)时退出编辑态,避免输入框悬留旧草稿
watch(() => props.title, () => { editing.value = false })

const store = useClusterStore()
const root = ref(null)
// idle 未连接 | connecting 连接中 | open 会话进行中 | closed 正常结束 | error 出错
const status = ref('idle')
const statusMsg = ref('')
const persistent = ref(null)   // null=未知, true=持久(tmux), false=一次性(无 tmux / attach)

// shell 候选：PATH 解析优先（sh 能命中 ash/dash/bash 等），覆盖 Alpine(ash)/Debian(bash)/绝对路径
const SHELLS = ['sh', 'bash', 'ash', '/bin/sh', '/bin/bash']
const shellIdx = ref(0)
const customShell = ref('')
const cmd = computed(() => customShell.value.trim() || SHELLS[shellIdx.value] || 'sh')
// 网关 auto 探测实际用上的 shell（CH_MODE 回传）。自动模式下 cmd 是前端假设（sh），
// 真实 shell 由网关定（bash 优先）；头部以此展示，手测时可直接确认拿到了 bash。
const actualShell = ref('')
// 自动检测全失败后才让用户手动选/填 shell（默认不展示选择器）
const manualNeeded = ref(false)
const manualCmd = ref('')

let term = null, fit = null, stream = null, ro = null
let gotOutput = false     // 本次连接是否收到过输出（判断 shell 是否真的起来）
let gen = 0               // 连接代际：降级重连时自增，旧流的回调按代际作废，避免重复降级

function setStatus(s, msg = '') { status.value = s; statusMsg.value = msg }

// 手机虚拟按键条输入:复用 term.onData 同款数据通路(WS 协议语义不变)
function sendInput(d) { stream?.send(d); term?.focus() }

// 手机字号热调:term.options.fontSize 热改后立即 fit 重排行;term 未初始化时静默安全
const termFont = ref(13)
function adjustFont(delta) {
  termFont.value = clampFont(termFont.value + delta)
  if (term) { term.options.fontSize = termFont.value; fit?.fit() }
}

function ensureTerm() {
  if (term) return
  termFont.value = 13  // 重连重建时复位(终审 E):热调值不跨会话残留
  term = new Terminal({
    cursorBlink: true, fontSize: termFont.value,
    fontFamily: '"JetBrains Mono","JetBrains Mono NF",monospace',
    theme: { background: codeTheme.surface, foreground: codeTheme.onSurface, cursor: codeTheme.onSurface, selectionBackground: codeTheme.selection },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(root.value)
  term.onData(d => stream?.send(d))
  term.onResize(({ cols, rows }) => stream?.resize({ cols, rows }))
  term.focus()
  nextTick(() => { try { fit.fit() } catch { /* 容器尚未布局 */ } })
}
let resizeTimer = null  // 初始 resize 重试定时器（需在 teardown 清理）
function closeStream() { gen++; if (resizeTimer) { clearInterval(resizeTimer); resizeTimer = null }; try { stream?.close() } catch { /* noop */ } stream = null }
function teardown() { closeStream(); try { ro?.disconnect() } catch { /* noop */ } ro = null; try { term?.dispose() } catch { /* noop */ } term = null }

// 建立一次 exec 流（attach 模式不走 shell 选择，连主进程 stdio）
function openStream() {
  gen++
  const my = gen
  gotOutput = false
  stream = execStream({
    namespace: props.namespace,
    pod: props.podName,
    container: props.container,
    command: cmd.value,
    attach: props.attach,
    sid: props.sessionId,
    // 自动模式首连才带 auto（网关探测最优 shell，bash 优先；dash 无 tab 补全）。
    // 降级重试/手动选择不带：网关须尊重前端指定的 shell，否则探测结果覆盖梯子选择导致死循环。
    auto: !props.attach && !customShell.value && shellIdx.value === 0,
    onStdout: d => { gotOutput = true; term.write(d) },
    onStderr: d => { gotOutput = true; term.write(d) },
    onExit: s => { if (my === gen) handleEnd(s?.status, s?.code) },
    onError: m => { if (my === gen) handleEnd(undefined, undefined, m) },
    // 握手失败(典型=K8s token 过期被 401 拒):发廉价探针,401 拦截器自动清 session 并
    // 跳集群选择页(与 SSH 流的 401 探针同款恢复路径);探针失败静默,错误面保持原样。
    onHandshakeFailure: () => { api.k8s('/version').catch(() => {}) },
    onClose: () => { if (my === gen && status.value !== 'error' && status.value !== 'closed') handleEnd() },
    onMode: m => { persistent.value = !!m?.persistent; if (m?.shell) actualShell.value = m.shell },
  })
  const tryResize = () => { if (stream?.isOpen && term) { stream.resize({ cols: term.cols, rows: term.rows }); return true } return false }
  if (!tryResize()) { resizeTimer = setInterval(() => { if (tryResize() || status.value === 'closed' || status.value === 'error') { clearInterval(resizeTimer); resizeTimer = null } }, 120) }
}

// 会话结束处理：exec 模式下，若全程无输出且非自定义命令且还有候选 shell → 自动降级重试
function handleEnd(statusVal, code, errMsg) {
  if (!props.attach && !gotOutput && !customShell.value && shellIdx.value < SHELLS.length - 1) {
    const prev = SHELLS[shellIdx.value]
    shellIdx.value++
    term.writeln(`\x1b[33m${t('terminal.shellUnavailable', { prev, cmd: cmd.value })}\x1b[0m`)
    closeStream()
    openStream()
    return
  }
  if (errMsg) term.writeln(`\x1b[31m${errMsg}\x1b[0m`)
  else {
    const detail = `${statusVal ? ` status=${statusVal}` : ''}${code != null ? ` code=${code}` : ''}`
    term.writeln(`\x1b[33m${t('terminal.sessionEnded', { detail })}\x1b[0m`)
  }
  if (!props.attach && !gotOutput && !customShell.value && shellIdx.value >= SHELLS.length - 1) {
    term.writeln(`\x1b[31m${t('terminal.allShellsFailed')}\x1b[0m`)
    manualNeeded.value = true   // 自动检测全失败：交给用户手动选/填
  }
  setStatus(errMsg ? 'error' : 'closed', errMsg || '')
}

async function connect(opts = {}) {
  if (!props.podName || !props.namespace) { setStatus('error', t('terminal.missingContext')); return }
  teardown()
  persistent.value = null
  actualShell.value = ''      // 每次新连接由 CH_MODE 重新回传
  // 自动连接（非手动）：清掉自定义命令，从首选 shell 起步并允许自动降级
  if (!opts.manual) { customShell.value = ''; shellIdx.value = 0 }
  manualNeeded.value = false
  setStatus('connecting')
  await nextTick()          // 等待 <div ref="root"> 挂载，xterm 才能 open
  ensureTerm()
  term.writeln(`\x1b[36m${t('terminal.connectingHint', { action: props.attach ? 'attach' : `exec ${cmd.value}`, namespace: props.namespace, pod: props.podName, container: props.container || t('terminal.defaultContainer') })}\x1b[0m`)
  openStream()
  setStatus('open')
  if (root.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { try { fit?.fit() } catch { /* noop */ } })
    ro.observe(root.value)
  }
}

// 用户手动指定命令连接（自动检测全失败时使用；指定后不再自动降级）
function connectManual() {
  customShell.value = manualCmd.value.trim() || SHELLS[shellIdx.value]
  connect({ manual: true })
}

onMounted(() => { if (props.autoConnect) connect() })
onUnmounted(teardown)

// 从最小化恢复时重新 fit xterm（display:none→block 后尺寸可能未更新）
function refit() { try { fit?.fit() } catch { /* noop */ } }
// 恢复按需建连（minimized 挂载不自动连；任务栏恢复 open 时若从未连接则补连）
function connectIfIdle() { if (status.value === 'idle') connect() }
defineExpose({ refit, connectIfIdle })
// 已连接时切换容器 / 模式 → 重连
watch(() => props.container, () => { if (stream || status.value === 'open') connect() })
watch(() => props.attach, () => { if (stream || status.value === 'open') connect() })
</script>

<template>
  <div class="h-full flex flex-col min-h-0 bg-code-surface rounded-lg overflow-hidden border border-outline-variant/20">
    <!-- 头部:chrome 模式恒渲染(idle 未连接的浮窗也须有窗口钮可点,否则关不掉);
         内嵌模式维持现状——连接开始后才出现 -->
    <div v-if="isChrome || status !== 'idle'"
      class="flex items-center justify-between px-md py-xs bg-code-surface-dim border-b border-outline-variant/20 shrink-0 min-w-0"
      :class="isWindowChrome ? 'cursor-move select-none' : ''"
      :data-window-drag="isWindowChrome ? '' : null">
      <div class="flex items-center gap-sm min-w-0 flex-1">
        <!-- ●●● chrome=真窗口钮(红关/黄最小化/绿最大化,组 hover 浮字形,macOS 语义);内嵌=装饰 -->
        <div v-if="isChrome" class="flex gap-1.5 items-center group shrink-0">
          <button data-test="dot-close" @click="emit('win-close')" :title="t('terminal.closeTerminalTitle')"
            class="w-3 h-3 rounded-full flex items-center justify-center bg-error/70 hover:bg-error transition-colors relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
            <span class="material-symbols-outlined text-on-error opacity-0 group-hover:opacity-100 max-sm:opacity-100" style="font-size:11px;line-height:1">close</span>
          </button>
          <button v-if="isWindowChrome" data-test="dot-minimize" @click="emit('win-minimize')" :title="t('terminal.minimizeTitle')"
            class="w-3 h-3 rounded-full flex items-center justify-center bg-tertiary-fixed-dim/70 hover:bg-tertiary-fixed-dim transition-colors relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
            <span class="material-symbols-outlined text-on-surface opacity-0 group-hover:opacity-100 max-sm:opacity-100" style="font-size:11px;line-height:1">remove</span>
          </button>
          <button v-if="isWindowChrome" data-test="dot-maximize" @click="emit('win-maximize')" :title="maximized ? t('terminal.restoreTitle') : t('terminal.maximizeTitle')"
            class="w-3 h-3 rounded-full flex items-center justify-center bg-primary-container/70 hover:bg-primary-container transition-colors relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
            <span class="material-symbols-outlined text-on-surface opacity-0 group-hover:opacity-100 max-sm:opacity-100" style="font-size:11px;line-height:1">{{ maximized ? 'fullscreen_exit' : 'fullscreen' }}</span>
          </button>
        </div>
        <div v-else class="flex gap-1 shrink-0">
          <span class="w-2.5 h-2.5 rounded-full bg-error/70"></span>
          <span class="w-2.5 h-2.5 rounded-full bg-tertiary-fixed-dim/70"></span>
          <span class="w-2.5 h-2.5 rounded-full bg-primary-container/70"></span>
        </div>
        <!-- 名称/信息:浮窗=显示名(双击改名,pod:容器·shell 进 tooltip);其余=pod:容器·shell 原样 -->
        <input v-if="editing" v-model="nameInput" data-test="term-title-input" data-no-drag
               @blur="saveRename" @keydown.enter="saveRename" @keydown.esc="editing = false"
               class="flex-1 min-w-0 w-0 bg-surface-container-lowest border border-primary rounded px-sm py-0.5 text-body-sm font-mono focus:outline-none" />
        <span v-else-if="isWindowChrome && title" data-test="term-title" @dblclick="startRename"
              class="min-w-0 flex-1 text-code-sm text-on-surface truncate font-mono"
              :title="`${title} · ${podName}:${container || 'main'}${!attach && (actualShell || cmd) ? ' · ' + (actualShell || cmd) : ''}（${t('terminal.dblClickRename', { name: title })}）`">
          {{ title }}
        </span>
        <span v-else class="text-code-sm text-on-surface-variant truncate">{{ podName }}:{{ container || 'main' }}<span v-if="!attach" class="text-on-surface-variant/50"> · {{ actualShell || cmd }}</span></span>
        <span v-if="persistent === true" class="text-body-xs text-primary ml-xs shrink-0" :title="t('terminal.persistentHint')">✓ {{ t('terminal.persistentBadge') }}</span>
        <span v-else-if="persistent === false" class="text-body-xs text-tertiary ml-xs shrink-0" :title="t('terminal.ephemeralHint')">⚠ {{ t('terminal.ephemeralBadge') }}</span>
      </div>
      <div class="flex items-center gap-sm shrink-0">
        <span v-if="status === 'open'" class="flex items-center gap-xs">
          <span class="w-2 h-2 rounded-full bg-primary-container animate-pulse-status"></span>
          <span class="text-body-sm text-primary">Live</span>
        </span>
        <span v-else-if="status !== 'idle'" class="text-body-sm text-on-surface-variant">{{ status === 'connecting' ? t('terminal.statusConnecting') : status === 'error' ? 'Error' : 'Disconnected' }}</span>
        <button @click="connect" :title="t('terminal.reconnectTitle')" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-lg">refresh</span>
        </button>
        <button v-if="isWindowChrome" data-test="btn-open-external" @click="emit('open-external')" :title="t('terminal.openInNewTabTitle')"
          class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-lg">open_in_new</span>
        </button>
      </div>
    </div>

    <!-- 未连接 -->
    <div v-if="status === 'idle'" class="flex-1 flex flex-col items-center justify-center gap-md p-xl">
      <span class="material-symbols-outlined text-4xl text-on-surface-variant">terminal</span>
      <p class="text-body-sm text-on-surface-variant">
        exec {{ t('terminal.execInto') }} <span class="font-mono text-on-surface">{{ container || t('terminal.defaultContainer') }}</span>
      </p>
      <p class="text-body-xs text-on-surface-variant/60">{{ t('terminal.autoDetectHint') }}</p>
      <button @click="connect" :disabled="status === 'connecting'"
        class="px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 flex items-center gap-sm disabled:opacity-50">
        <span class="material-symbols-outlined">terminal</span>
        Connect to Terminal
      </button>
    </div>

    <!-- 终端 -->
    <template v-else>
      <div ref="root" class="flex-1 min-h-0 p-sm"></div>
      <!-- 手机档虚拟按键条:无物理键盘时的 exec 刚需(Esc/Tab/方向键/Ctrl+C) -->
      <div v-if="isPhone" data-test="term-keybar" class="flex items-center gap-1 px-sm py-1 border-t border-outline-variant bg-surface-container-low overflow-x-auto shrink-0">
        <button @pointerdown.prevent @click="adjustFont(-1)"
          class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono font-semibold active:bg-primary-container/20 transition-colors">A-</button>
        <button @pointerdown.prevent @click="adjustFont(1)"
          class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono font-semibold active:bg-primary-container/20 transition-colors">A+</button>
        <button v-for="(bytes, key) in KEY_BYTES" :key="key" @pointerdown.prevent @click="sendInput(bytes)"
          class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono active:bg-primary-container/20 transition-colors">
          {{ key }}
        </button>
      </div>
      <p v-if="statusMsg" class="px-md py-xs text-xs text-error bg-error-container/10">{{ statusMsg }}</p>
      <!-- 自动检测全失败：手动选/填 shell -->
      <div v-if="manualNeeded" class="px-md py-sm bg-surface-container-low border-t border-outline-variant shrink-0">
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ t('terminal.manualNeededHint') }}</p>
        <div class="flex items-center gap-xs">
          <select v-model.number="shellIdx" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-1 text-body-xs font-mono focus:ring-2 focus:ring-primary">
            <option v-for="(s, i) in SHELLS" :key="s" :value="i">{{ s }}</option>
          </select>
          <input v-model="manualCmd" :placeholder="t('terminal.manualCmdPlaceholder')" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-1 text-body-xs font-mono focus:ring-2 focus:ring-primary" @keydown.enter="connectManual" />
          <button @click="connectManual" class="px-sm py-1 bg-primary text-on-primary rounded-lg text-body-xs font-semibold hover:opacity-90 shrink-0">{{ t('terminal.connectWithCmd') }}</button>
        </div>
      </div>
    </template>
  </div>
</template>
