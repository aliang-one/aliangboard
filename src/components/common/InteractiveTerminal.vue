<script setup>
// Pod exec 终端：浏览器 xterm.js ↔ Gateway WebSocket ↔ K8s（client-node exec，SPDY/WS）。
// 仅在 remoteMode 下建立真实 exec；演示数据模式下给出提示（exec 无法在 mock 上运行）。
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useClusterStore } from '@/stores/cluster'
import { execStream } from '@/api/client'

const props = defineProps({
  podName: { type: String, default: '' },
  namespace: { type: String, default: '' },
  container: { type: String, default: '' },
  command: { type: String, default: '/bin/sh' },
  attach: { type: Boolean, default: false },   // true = kubectl attach（连主进程 stdio），否则 exec 开新 shell
})

const store = useClusterStore()
const root = ref(null)
// idle 未连接 | connecting 连接中 | open 会话进行中 | closed 正常结束 | error 出错
const status = ref('idle')
const statusMsg = ref('')

let term = null
let fit = null
let stream = null
let ro = null

function setStatus(s, msg = '') { status.value = s; statusMsg.value = msg }

function initTerm() {
  if (term) return
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "JetBrains Mono NF", monospace',
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

function teardown() {
  try { stream?.close() } catch { /* noop */ }
  stream = null
  try { ro?.disconnect() } catch { /* noop */ }
  ro = null
  try { term?.dispose() } catch { /* noop */ }
  term = null
}

async function connect() {
  if (!store.remoteMode) return
  if (!props.podName || !props.namespace) { setStatus('error', '缺少 Pod / namespace 上下文'); return }
  teardown()
  setStatus('connecting')
  await nextTick()          // 等待 <div ref="root"> 挂载，xterm 才能 open
  initTerm()
  term.writeln(`\x1b[36m${props.attach ? 'attach' : 'exec'} ${props.namespace}/${props.podName}（${props.container || '默认容器'}）…\x1b[0m`)
  stream = execStream({
    namespace: props.namespace,
    pod: props.podName,
    container: props.container,
    command: props.command,
    attach: props.attach,
    onStdout: d => term.write(d),
    onStderr: d => term.write(d),
    onExit: s => {
      term.writeln(`\x1b[33m[会话结束 status=${s?.status || '?'}${s?.code != null ? ` code=${s.code}` : ''}]\x1b[0m`)
      setStatus('closed')
    },
    onError: m => { term.writeln(`\x1b[31m${m}\x1b[0m`); setStatus('error', m) },
    onClose: () => { if (status.value !== 'error' && status.value !== 'closed') setStatus('closed') },
  })
  // 首帧前先发送初始尺寸（WS 一旦 open 即发）
  const tryResize = () => {
    if (stream?.isOpen && term) { stream.resize({ cols: term.cols, rows: term.rows }); return true }
    return false
  }
  if (!tryResize()) { const t = setInterval(() => { if (tryResize() || status.value === 'closed' || status.value === 'error') clearInterval(t) }, 120) }
  setStatus('open')
  // 容器尺寸变化时自适应
  if (root.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { try { fit?.fit() } catch { /* noop */ } })
    ro.observe(root.value)
  }
}

onMounted(() => { /* 等待用户点击 Connect */ })
onUnmounted(teardown)

// 已连接时切换容器 / 模式 → 重连
watch(() => props.container, () => { if (stream || status.value === 'open') connect() })
watch(() => props.attach, () => { if (stream || status.value === 'open') connect() })
</script>

<template>
  <div class="flex flex-col bg-[#0b1c30] rounded-lg overflow-hidden border border-outline-variant/20">
    <!-- 未连接 / 演示模式 -->
    <div v-if="status === 'idle'" class="flex flex-col items-center justify-center gap-md p-xl">
      <span class="material-symbols-outlined text-4xl text-on-surface-variant">terminal</span>
      <p v-if="!store.remoteMode" class="text-body-sm text-on-surface-variant text-center max-w-md">
        终端（kubectl exec）需要连接真实集群；当前为演示数据模式，无法进入容器。
      </p>
      <p v-else class="text-body-sm text-on-surface-variant">
        exec 进入 <span class="font-mono text-on-surface">{{ container || '默认容器' }}</span>
      </p>
      <button v-if="store.remoteMode" @click="connect" :disabled="status === 'connecting'"
        class="px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 flex items-center gap-sm disabled:opacity-50">
        <span class="material-symbols-outlined">terminal</span>
        {{ status === 'connecting' ? '连接中…' : 'Connect to Terminal' }}
      </button>
    </div>

    <!-- 终端 -->
    <template v-else>
      <div class="flex items-center justify-between px-md py-xs bg-[#1a1c1e] border-b border-outline-variant/20">
        <div class="flex items-center gap-sm">
          <div class="flex gap-1">
            <span class="w-2.5 h-2.5 rounded-full bg-error/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-tertiary-fixed-dim/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-primary-container/70"></span>
          </div>
          <span class="text-code-sm text-on-surface-variant ml-sm">{{ podName }}:{{ container || 'main' }}</span>
        </div>
        <div class="flex items-center gap-sm">
          <span v-if="status === 'open'" class="flex items-center gap-xs">
            <span class="w-2 h-2 rounded-full bg-primary-container animate-pulse-status"></span>
            <span class="text-body-sm text-primary">Live</span>
          </span>
          <span v-else class="text-body-sm text-on-surface-variant">{{ status === 'connecting' ? '连接中…' : status === 'error' ? 'Error' : 'Disconnected' }}</span>
          <button @click="connect" title="重新连接" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined text-lg">refresh</span>
          </button>
        </div>
      </div>
      <div ref="root" class="p-sm" style="height: 460px"></div>
      <p v-if="statusMsg" class="px-md py-xs text-body-xs text-error bg-error-container/10">{{ statusMsg }}</p>
    </template>
  </div>
</template>
