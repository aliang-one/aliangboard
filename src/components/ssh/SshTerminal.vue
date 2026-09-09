<script setup>
// SSH 服务器终端：浏览器 xterm.js ↔ 网关保活 SSH 会话(sshTerminalStream)。
// 与 InteractiveTerminal 的差异：无 shell 降级梯子(远端 shell 由服务器定)；
// sid 恒定 → 断开/刷新后重连,网关先回放快照(徽标「已回放」)再续直播。
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { sshTerminalStream } from '@/api/client'
import { codeTheme } from '@/styles/code-theme'
import { useIsPhone } from '@/composables/useBreakpoint'
import { useTerminalFont } from '@/composables/useTerminalFont'
import TerminalKeyBar from '@/components/common/TerminalKeyBar.vue'

const { t } = useI18n()
const { isPhone } = useIsPhone()

const props = defineProps({
  serverId: { type: String, required: true },
  serverName: { type: String, default: '' },
  sid: { type: String, required: true },           // 恒定 sid:网关按 sid 保活/回放
  autoConnect: { type: Boolean, default: false },   // 浮窗模式:挂载即连
  // 单行头部收编(2026-09-08,取代 closable):false = 装饰圆点 | 'window' = 浮窗
  // (●●● 变真窗口钮 + 头部即拖拽把手 + open_in_new 迁入) | 'page' = 独立标签页(仅红点=关窗)
  chrome: { type: [Boolean, String], default: false },
  maximized: { type: Boolean, default: false },     // 绿点字形(最大化/还原)状态
})
// 窗口控制由父级处置(浮窗红=sshStore.closeWindow 杀会话+摘记录;弹窗红=杀会话+关标签页;
// 组件保持哑,不直接碰 store)
const emit = defineEmits(['win-close', 'win-minimize', 'win-maximize', 'open-external'])
const isChrome = computed(() => props.chrome === 'window' || props.chrome === 'page')
const isWindowChrome = computed(() => props.chrome === 'window')

const root = ref(null)
// idle 未连接 | connecting 连接中 | open 会话进行中 | reconnecting 断线自动重连中 | closed 会话结束 | error 出错
const status = ref('idle')
const statusMsg = ref('')
const replayed = ref(false)   // 收到过回放帧(同 sid 重连) → 头部徽标

let term = null, fit = null, stream = null, ro = null
let gen = 0                   // 连接代际:重连时旧流回调作废,避免重复 handleEnd

// 手机虚拟按键条输入(Wave5 B6,与 pod 终端同源):复用 term.onData 同款数据通路
// (WS 协议语义不变)+ 发送后回焦 xterm 收软键盘(终审 B)
function sendInput(d) { stream?.send(d); term?.focus() }

// 手机字号热调(Wave5 B6,与 pod 终端同源 useTerminalFont):term/fit 为晚绑定局部实例,经 getter 传入
const { termFont, adjustFont, resetFont } = useTerminalFont({ term: () => term, fit: () => fit })

// 断线自动重连(2026-09-08 线上事故:WS 瞬断被显示成「会话结束」,用户被迫手动刷新):
// 曾成功 open 的流断开 → 指数退避自动重连同 sid(网关回放续跑)。首连握手失败(401/502)
// 走既有探针/手动重试,CH_ERROR 终态(LOST/属主不符)重连无意义,均不自动重试。
// 退避清零须过稳定窗(复查#3):连接反复「秒开秒断」不重置计数,防 reload/抖动下的重连风暴。
const RECONNECT_BASE_MS = 1000, RECONNECT_CAP_MS = 30000, RECONNECT_MAX_ATTEMPTS = 10, RECONNECT_STABLE_MS = 15000
let reconnectAttempts = 0
let reconnectTimer = null
let stableTimer = null

function setStatus(s, msg = '') { status.value = s; statusMsg.value = msg }

function ensureTerm() {
  if (term) return
  resetFont()  // 重连重建时复位(与 pod 终端同款,终审 E):热调值不跨会话残留
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
let resizeTimer = null  // 初始 resize 重试定时器(需在 teardown 清理)
function closeStream() {
  gen++
  if (resizeTimer) { clearInterval(resizeTimer); resizeTimer = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (stableTimer) { clearTimeout(stableTimer); stableTimer = null }
  try { stream?.close() } catch { /* noop */ }
  stream = null
}
function teardown() {
  closeStream()
  try { ro?.disconnect() } catch { /* noop */ }
  ro = null
  try { term?.dispose() } catch { /* noop */ }
  term = null
}

function openStream() {
  gen++
  const my = gen
  let openedThisGen = false   // 本代流是否成功握手(区分「断线」与「从未连上」)
  stream = sshTerminalStream({
    serverId: props.serverId,
    sid: props.sid,
    cols: term.cols,
    rows: term.rows,
    onStdout: d => { if (term) term.write(d) },
    onReplay: d => { if (term) term.write(d); replayed.value = true },
    onOpen: () => {
      if (my !== gen) return
      openedThisGen = true
      if (reconnectAttempts > 0) term?.writeln(`\x1b[32m${t('terminal.reconnected')}\x1b[0m`)
      // 熬过稳定窗才清零退避(复查#3:闪断不重置,防重连风暴;窗口内断开计数继续爬)
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => { stableTimer = null; if (my === gen) reconnectAttempts = 0 }, RECONNECT_STABLE_MS)
      setStatus('open')
    },
    onError: m => { if (my === gen) handleEnd(m) },
    onClose: () => {
      if (my !== gen || status.value === 'error' || status.value === 'closed') return
      // 首连握手失败(401/502):探针已分流鉴权,本地报 closed 交手动重试;重连轮次中的
      // 握手失败(如 502 闪断)计入退避继续重试
      if (!openedThisGen && reconnectAttempts === 0) { handleEnd(); return }
      scheduleReconnect()
    },
  })
  const tryResize = () => { if (stream?.isOpen && term) { stream.resize({ cols: term.cols, rows: term.rows }); return true } return false }
  if (!tryResize()) resizeTimer = setInterval(() => { if (tryResize() || status.value === 'closed' || status.value === 'error') { clearInterval(resizeTimer); resizeTimer = null } }, 120)
}

function scheduleReconnect() {
  reconnectAttempts++
  if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) { handleEnd(); return }
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_CAP_MS)
  setStatus('reconnecting')
  term?.writeln(`\x1b[33m${t('terminal.reconnecting', { n: reconnectAttempts })}\x1b[0m`)
  const my = gen
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // gen 变(手动 connect/unmount)或已进入终态 → 本次自动重连作废
    if (my === gen && status.value === 'reconnecting') connect()
  }, delay)
}

function handleEnd(errMsg) {
  if (errMsg) term?.writeln(`\x1b[31m${errMsg}\x1b[0m`)
  else term?.writeln(`\x1b[33m${t('terminal.sessionEnded', { detail: '' })}\x1b[0m`)
  // 终态立即收流(复查#4 前端半):不等浏览器/服务端侧握手收尾,当前代 WS 主动关闭,
  // 免得半开连接挂着吃网关 liveness ping(服务端 LOST 亦会关,此处为双保险)。
  try { stream?.close() } catch { /* noop */ }
  setStatus(errMsg ? 'error' : 'closed', errMsg || '')
}

async function connect() {
  teardown()
  replayed.value = false
  setStatus('connecting')
  await nextTick()          // 等 <div ref="root"> 挂载,xterm 才能 open
  ensureTerm()
  term.writeln(`\x1b[36m${t('ssh.connectingHint', { name: props.serverName || props.serverId })}\x1b[0m`)
  openStream()               // 状态在 onOpen(真握手成功)时才转 open
  if (root.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { try { fit?.fit() } catch { /* noop */ } })
    ro.observe(root.value)
  }
}

onMounted(() => { if (props.autoConnect) connect() })
onUnmounted(teardown)

// 从最小化恢复时重新 fit xterm(display:none→block 后尺寸可能未更新)
function refit() { try { fit?.fit() } catch { /* noop */ } }
// 恢复窗口时的按需建连(2026-09-04 事故③):仅在未连接时才发起——已连接(open)不重连,
// 断开/出错时允许用 connect() 手动重试
function connectIfIdle() {
  if (status.value === 'idle' || status.value === 'closed' || status.value === 'error') connect()
}
defineExpose({ refit, replayed, connectIfIdle, connect, status })
</script>

<template>
  <div class="h-full flex flex-col min-h-0 bg-code-surface rounded-lg overflow-hidden border border-outline-variant/20">
    <!-- 终端 -->
    <div class="flex items-center justify-between px-md py-xs bg-code-surface-dim border-b border-outline-variant/20 shrink-0 min-w-0"
         :class="isWindowChrome ? 'cursor-move select-none' : ''"
         :data-window-drag="isWindowChrome ? '' : null">
      <div class="flex items-center gap-sm min-w-0 flex-1">
        <!-- ●●● chrome=真窗口钮(红关/黄最小化/绿最大化,组 hover 浮字形,macOS 语义);非 chrome=装饰 -->
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
        <span class="text-code-sm text-on-surface-variant ml-sm truncate font-mono">ssh://{{ serverName || serverId }}</span>
        <span v-if="replayed" data-test="replayBadge" class="text-body-xs text-primary ml-xs shrink-0" :title="t('ssh.replayedBadge')">↺ {{ t('ssh.replayedBadge') }}</span>
      </div>
      <div class="flex items-center gap-sm shrink-0">
        <span v-if="status === 'open'" class="flex items-center gap-xs">
          <span class="w-2 h-2 rounded-full bg-primary-container animate-pulse-status"></span>
          <span class="text-body-sm text-primary">Live</span>
        </span>
        <span v-else class="text-body-sm text-on-surface-variant">{{ status === 'connecting' ? t('terminal.statusConnecting') : status === 'reconnecting' ? t('terminal.statusReconnecting') : status === 'error' ? 'Error' : 'Disconnected' }}</span>
        <button data-test="btnReconnect" @click="connect" :title="t('ssh.reconnect')" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-lg">refresh</span>
        </button>
        <button v-if="isWindowChrome" data-test="btnOpenExternal" @click="emit('open-external')" :title="t('terminal.openInNewTabTitle')"
          class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined text-lg">open_in_new</span>
        </button>
      </div>
    </div>
    <div ref="root" class="flex-1 min-h-0 p-sm"></div>
    <!-- 手机档虚拟按键条(Wave5 B6,与 pod 终端同源):软键盘发不出的 Esc/Tab/方向键/Ctrl+C
         刚需 + 字号钮;字号钮经默认槽注入(渲染在 7 键之前,与 pod 布局一致) -->
    <TerminalKeyBar v-if="isPhone" :send="sendInput">
      <button @pointerdown.prevent @click="adjustFont(-1)"
        class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono font-semibold active:bg-primary-container/20 transition-colors">A-</button>
      <button @pointerdown.prevent @click="adjustFont(1)"
        class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono font-semibold active:bg-primary-container/20 transition-colors">A+</button>
    </TerminalKeyBar>
    <p v-if="statusMsg" class="px-md py-xs text-xs text-error bg-error-container/10">{{ statusMsg }}</p>
  </div>
</template>
