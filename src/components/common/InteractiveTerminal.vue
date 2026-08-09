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
import { execStream } from '@/api/client'

const { t } = useI18n()

const props = defineProps({
  podName: { type: String, default: '' },
  namespace: { type: String, default: '' },
  container: { type: String, default: '' },
  attach: { type: Boolean, default: false },   // true = kubectl attach（连主进程 stdio），否则 exec 开 shell
  autoConnect: { type: Boolean, default: false }, // true = 挂载即自动连接（浮动窗口模式）
})

const store = useClusterStore()
const root = ref(null)
// idle 未连接 | connecting 连接中 | open 会话进行中 | closed 正常结束 | error 出错
const status = ref('idle')
const statusMsg = ref('')

// shell 候选：PATH 解析优先（sh 能命中 ash/dash/bash 等），覆盖 Alpine(ash)/Debian(bash)/绝对路径
const SHELLS = ['sh', 'bash', 'ash', '/bin/sh', '/bin/bash']
const shellIdx = ref(0)
const customShell = ref('')
const cmd = computed(() => customShell.value.trim() || SHELLS[shellIdx.value] || 'sh')
// 自动检测全失败后才让用户手动选/填 shell（默认不展示选择器）
const manualNeeded = ref(false)
const manualCmd = ref('')

let term = null, fit = null, stream = null, ro = null
let gotOutput = false     // 本次连接是否收到过输出（判断 shell 是否真的起来）
let gen = 0               // 连接代际：降级重连时自增，旧流的回调按代际作废，避免重复降级

function setStatus(s, msg = '') { status.value = s; statusMsg.value = msg }

function ensureTerm() {
  if (term) return
  term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: '"JetBrains Mono","JetBrains Mono NF",monospace',
    theme: { background: '#0b1c30', foreground: '#cfe3ff', cursor: '#cfe3ff', selectionBackground: '#1f3b5e' },
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
    onStdout: d => { gotOutput = true; term.write(d) },
    onStderr: d => { gotOutput = true; term.write(d) },
    onExit: s => { if (my === gen) handleEnd(s?.status, s?.code) },
    onError: m => { if (my === gen) handleEnd(undefined, undefined, m) },
    onClose: () => { if (my === gen && status.value !== 'error' && status.value !== 'closed') handleEnd() },
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
defineExpose({ refit })
// 已连接时切换容器 / 模式 → 重连
watch(() => props.container, () => { if (stream || status.value === 'open') connect() })
watch(() => props.attach, () => { if (stream || status.value === 'open') connect() })
</script>

<template>
  <div class="flex flex-col min-h-0 bg-[#0b1c30] rounded-lg overflow-hidden border border-outline-variant/20">
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
      <div class="flex items-center justify-between px-md py-xs bg-[#1a1c1e] border-b border-outline-variant/20 shrink-0">
        <div class="flex items-center gap-sm">
          <div class="flex gap-1">
            <span class="w-2.5 h-2.5 rounded-full bg-error/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-tertiary-fixed-dim/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-primary-container/70"></span>
          </div>
          <span class="text-code-sm text-on-surface-variant ml-sm">{{ podName }}:{{ container || 'main' }}<span v-if="!attach" class="text-on-surface-variant/50"> · {{ cmd }}</span></span>
        </div>
        <div class="flex items-center gap-sm">
          <span v-if="status === 'open'" class="flex items-center gap-xs">
            <span class="w-2 h-2 rounded-full bg-primary-container animate-pulse-status"></span>
            <span class="text-body-sm text-primary">Live</span>
          </span>
          <span v-else class="text-body-sm text-on-surface-variant">{{ status === 'connecting' ? t('terminal.statusConnecting') : status === 'error' ? 'Error' : 'Disconnected' }}</span>
          <button @click="connect" :title="t('terminal.reconnectTitle')" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-lg">refresh</span>
          </button>
        </div>
      </div>
      <div ref="root" class="flex-1 min-h-0 p-sm"></div>
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
