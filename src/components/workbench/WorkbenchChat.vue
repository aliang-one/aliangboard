<script setup>
// 可复用 AI 聊天组件(从 WorkbenchProjectChat 提取):工作台项目的 agent 聊天。
// props: projectId / projectName。无路由依赖,适合侧栏嵌入。
// → POST /api/workbench/conversations { projectId, message, references } → { id, status:'running' }
// → 每 2s GET /api/workbench/conversations/:id → 更新 turns/trace
// → status==='paused' → 弹审批 modal;approve/deny → POST → 继续轮询
// → status==='done' → 显示终答 + 停轮询;status==='failed' → 显示错误 + 停轮询。
// 审批 modal 展 path+content。
import { ref, computed, nextTick, watch, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { workbenchApi, getPlatformToken } from '@/api/client'
import Modal from '@/components/common/Modal.vue'
import ChatTurn from './ChatTurn.vue'
import { applyStreamEvent } from './conv-stream'

const props = defineProps({
  projectId: String,
  projectName: String,
  conversationId: { type: String, default: null },
  activeConversationId: { type: String, default: null },
})
const emit = defineEmits(['conversation-created'])

const { t } = useI18n()

const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
const scrollEl = ref(null)
const taEl = ref(null)
const pendingApproval = ref(null)
let turnSeq = 0

// --- 异步对话轮询状态 ---
const conversationId = ref(null)
const pollTimer = ref(null)
const convStatus = ref(null)
const recap = ref('')   // 上一段对话摘要(多轮续接时由 pollOnce 填充,顶部折叠卡渲染)

// --- SSE streaming 状态(T8:优先用 EventSource,断线降级 pollOnce) ---
let es = null

// --- @-mention state ---
const refs = ref([])
const searchResults = ref([])
const searching = ref(false)
const searchOpen = ref(false)
const kindHints = ref([])  // @ 后无 : → kind 补全
const activeIndex = ref(-1)  // @-mention 下拉键盘选中索引(-1=无)
const mentionItems = computed(() => kindHints.value.length ? kindHints.value : searchResults.value)
const KIND_ALIASES = { pod:'pods', pods:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', cm:'configmaps', configmap:'configmaps', ns:'namespaces', namespace:'namespaces', ingress:'ingresses', secret:'secrets', sts:'statefulsets', statefulset:'statefulsets', ds:'daemonsets', daemonset:'daemonsets' }
const KIND_LABELS = { pod:'Pod', pods:'Pod', deploy:'Deployment', deployment:'Deployment', svc:'Service', service:'Service', cm:'ConfigMap', configmap:'ConfigMap', ns:'Namespace', namespace:'Namespace', ingress:'Ingress', secret:'Secret', sts:'StatefulSet', statefulset:'StatefulSet', ds:'DaemonSet', daemonset:'DaemonSet' }
// @-syntax: @ → kind hints; @pod: → resources; @pod:ns/ → ns-scoped resources; @pod:ns/name → filtered
const MENTION_RE = /@(\w*):([^@\s]*)$/
const AT_RE = /@(\w*)$/

let debounceTimer = null
function clearSearch() { searchOpen.value = false; searchResults.value = []; kindHints.value = []; activeIndex.value = -1 }

async function doSearch(kind, q, ns) {
  searching.value = true
  searchOpen.value = true
  try {
    const data = await workbenchApi.search(props.projectId, kind, q)
    let items = (data && data.items) || []
    if (ns) items = items.filter(it => it.namespace === ns)
    searchResults.value = items
    activeIndex.value = items.length ? 0 : -1
  } catch { searchResults.value = [] }
  finally { searching.value = false }
}

watch(input, (val) => {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  if (!val) { clearSearch(); return }
  const m = val.match(MENTION_RE)
  if (m) {
    // @kind:query — search resources of this kind
    const alias = m[1].toLowerCase()
    const rawQuery = m[2]
    const kind = KIND_ALIASES[alias]
    if (!kind) { clearSearch(); return }
    // Parse ns/name from query: "default/nginx" → ns=default, q=nginx; "nginx" → q=nginx
    let ns = null, q = rawQuery
    if (rawQuery.includes('/')) { const [n, ...rest] = rawQuery.split('/'); ns = n; q = rest.join('/') }
    // 切到搜索模式:清掉 kind hints(否则模板 v-if="kindHints.length" 持续命中,搜索结果永不显示);
    // 立即置 searching=true,避免 200ms debounce 期间先闪一下"无匹配资源"。
    kindHints.value = []
    searching.value = true
    searchOpen.value = true
    debounceTimer = setTimeout(() => doSearch(kind, q, ns), 200)
  } else {
    // @alias (no colon yet) → show kind hints immediately
    const atMatch = val.match(AT_RE)
    if (atMatch) {
      const typed = atMatch[1].toLowerCase()
      kindHints.value = Object.entries(KIND_LABELS)
        .filter(([k]) => k.startsWith(typed))
        .map(([k, label]) => ({ alias: k, label }))
      searchOpen.value = kindHints.value.length > 0
      searchResults.value = []
      activeIndex.value = kindHints.value.length ? 0 : -1
    } else {
      clearSearch()
    }
  }
})

function selectRef(item) {
  refs.value.push({ kind: item.kind, namespace: item.namespace, name: item.name })
  // 从 input 删除 @kind:query token
  input.value = input.value.replace(MENTION_RE, '').trimEnd()
  clearSearch()
}

function selectKind(alias) {
  // 把 @alias 补成 @alias:（光标位置不重要,replace 替换末尾）
  input.value = input.value.replace(/@(\w*)$/, `@${alias}:`)
  kindHints.value = []
  searchOpen.value = false
}

function removeRef(idx) { refs.value.splice(idx, 1) }

onUnmounted(() => { if (debounceTimer) clearTimeout(debounceTimer); stopPolling(); stopStreaming() })

const convStatusLabel = computed(() => {
  const labels = { running: t('workbench.chat.convStatus.running'), paused: t('workbench.chat.convStatus.paused'), done: t('workbench.chat.convStatus.done'), failed: t('workbench.chat.convStatus.failed') }
  return labels[convStatus.value] || ''
})

const convStatusBadgeClass = computed(() => {
  switch (convStatus.value) {
    case 'running': return 'bg-status-running/10 text-status-running'
    case 'paused': return 'bg-status-warning/10 text-status-warning'
    case 'done': return 'bg-status-success/10 text-status-success'
    case 'failed': return 'bg-error/10 text-error'
    default: return 'bg-surface-container text-on-surface-variant'
  }
})

const HINTS = computed(() => [
  t('workbench.chat.hintReadLedger'),
  t('workbench.chat.hintWriteConfig'),
  t('workbench.chat.hintListFiles'),
])

const KIND_ICONS = { Pod:'podcasts', Deployment:'deployed_code', Service:'hub', Namespace:'folder', Ingress:'dns', ConfigMap:'description', Secret:'lock', StatefulSet:'storage', DaemonSet:'dns' }
function refIcon(kind) {
  if (!kind) return 'label'
  const k = kind.charAt(0).toUpperCase() + kind.slice(1).replace(/s$/, '')
  return KIND_ICONS[k] || KIND_ICONS[kind] || 'extension'
}

function updateTurn(tid, patch) { const t = turns.value.find(x => x._id === tid); if (t) Object.assign(t, patch) }
async function scrollToBottom() { await nextTick(); if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight }

// --- 异步轮询 ---
function stopPolling() { if (pollTimer.value) { clearInterval(pollTimer.value); pollTimer.value = null } }

// Load existing conversation when conversationId prop is set (AFTER all refs/functions defined)
watch(() => props.conversationId, async (convId) => {
  stopPolling()
  stopStreaming()
  turns.value = []
  conversationId.value = null
  convStatus.value = null
  recap.value = ''
  pendingApproval.value = null
  errorBanner.value = ''
  if (convId) {
    conversationId.value = convId
    await pollOnce(convId)
    if (convStatus.value === 'running') startStreaming(convId)
  }
}, { immediate: true })

function startPolling(id) {
  stopPolling()
  pollTimer.value = setInterval(() => pollOnce(id), 2000)
  // 立即首次拉取(不等 2s)
  pollOnce(id)
}

// 解析消息的 refs 字段(后端存 JSON 字符串)为数组,供 ChatTurn ResourceCard 渲染。
function parseRefs(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
}
function tryParseTrace(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : [] } catch { return [] }
}

async function pollOnce(id) {
  try {
    const conv = await workbenchApi.conversations.get(id)
    convStatus.value = conv.status
    recap.value = conv.recap || ''
    // 首次加载(watch/send-remount 后 turns 为空):从对话数据重建 turns。
    let rebuiltFromMessages = false
    if (!turns.value.length) {
      if (Array.isArray(conv.messages) && conv.messages.length) {
        // 多轮渲染(T7):每条 message → 一个 ChatTurn。
        // 已落库的 assistant 消息都是 done 状态(写入时即终态);
        // 若对话仍在 running,说明最后一条 user 后 agent 尚未产出 → 末尾补一个 thinking turn。
        rebuiltFromMessages = true
        const msgs = conv.messages
        for (const m of msgs) {
          if (m.role === 'user') {
            turns.value.push({ _id: ++turnSeq, role: 'user', content: m.content, refs: parseRefs(m.refs) })
          } else {
            turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'done', content: m.content || t('workbench.chat.noAnswer'), trace: tryParseTrace(m.trace), steps: 0 })
          }
        }
        // running 且末条非 assistant-thinking:补 thinking turn(如页面刷新续接运行中对话)。
        const last = turns.value[turns.value.length - 1]
        if (conv.status === 'running' && !(last && last.role === 'assistant' && last.status === 'thinking')) {
          turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
        }
      } else {
        // 旧单轮数据 fallback(无 messages 数组):user from conv.userMessage + agent thinking。
        if (conv.userMessage) turns.value.push({ _id: ++turnSeq, role: 'user', content: conv.userMessage })
        turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
      }
    }
    // 从 messages 重建时,turns 已是终态(done/failed 不需再改,各 turn 自带 per-message content);
    // running/paused 需操作末尾的 thinking turn(刚补的)。
    // 非重建(send/续接路径,turns 由 send() 填充):多轮续接时 turns 已含历史 done assistant,
    // 必须取最后一个 thinking assistant(running/paused 刚补的占位),否则取首个会把旧 turn 覆盖、
    // 新 thinking turn 卡死(永久 spinner + 答案重复)。无 thinking 则回退最后一个 assistant。
    const agentTurn = rebuiltFromMessages
      ? [...turns.value].reverse().find(x => x.role === 'assistant' && x.status === 'thinking')
      : ([...turns.value].reverse().find(x => x.role === 'assistant' && x.status === 'thinking')
        ?? [...turns.value].reverse().find(x => x.role === 'assistant'))
    // 更新 trace(running/paused 时的 live trace;done+rebuilt 时各 turn 已自带 trace,不覆盖)
    if (agentTurn) {
      let trace = []
      if (conv.trace) { try { trace = JSON.parse(conv.trace) } catch { trace = [] } }
      agentTurn.trace = trace
      agentTurn.steps = conv.steps ?? agentTurn.steps
    }
    if (conv.status === 'paused') {
      stopPolling()
      let pa = null
      try { pa = conv.pendingApproval ? JSON.parse(conv.pendingApproval) : null } catch { pa = null }
      if (agentTurn) updateTurn(agentTurn._id, { status: 'pending_approval', steps: conv.steps ?? agentTurn.steps })
      if (pa) {
        pendingApproval.value = { turnId: agentTurn ? agentTurn._id : null, toolCallId: pa.toolCallId, name: pa.name, args: pa.args }
      }
      sending.value = false
    } else if (conv.status === 'done') {
      stopPolling()
      if (agentTurn) updateTurn(agentTurn._id, { status: 'done', content: conv.content || t('workbench.chat.noAnswer'), steps: conv.steps ?? agentTurn.steps })
      sending.value = false
      await scrollToBottom()
    } else if (conv.status === 'failed') {
      stopPolling()
      errorBanner.value = conv.error || t('workbench.chat.agentFailed')
      if (agentTurn) updateTurn(agentTurn._id, { status: 'error', error: conv.error || t('workbench.chat.agentFailed') })
      sending.value = false
    }
  } catch {
    // 网络抖动:忽略,下次轮询重试
  }
}

// --- SSE streaming(T8:优先路径,EventSource 收实时事件 → applyStreamEvent 归约 → updateTurn) ---
// 断线/降级兜底:es.onerror → 关流 + pollOnce(id) 对齐一次 + startPolling 继续轮询。
function stopStreaming() { if (es) { es.close(); es = null } }

function agentTurnDoneOrFinal() {
  const at = turns.value.find(x => x.role === 'assistant')
  if (!at) return true
  return at.status === 'done' || at.status === 'error' || at.status === 'pending_approval'
}

function startStreaming(id) {
  stopStreaming()
  stopPolling()
  const token = getPlatformToken()
  // EventSource 不能加自定义 header;走 ?token= query(服务端 requirePlatform 已支持 query 回退)。
  const url = `/api/workbench/conversations/${encodeURIComponent(id)}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
  try {
    es = new EventSource(url)
  } catch {
    // EventSource 不可用(降级):回退轮询
    startPolling(id)
    return
  }
  es.onmessage = (ev) => {
    let evt
    try { evt = JSON.parse(ev.data) } catch { return }
    const agentTurn = turns.value.find(x => x.role === 'assistant')
    if (!agentTurn) return
    // 归约事件 → 新状态快照
    const next = applyStreamEvent({
      status: agentTurn.status,
      content: agentTurn.content,
      trace: agentTurn.trace || [],
      steps: agentTurn.steps,
      denied: agentTurn.denied || [],
      truncated: !!agentTurn.truncated,
      pendingApproval: pendingApproval.value,
      error: agentTurn.error || '',
    }, evt)
    updateTurn(agentTurn._id, next)
    // 同步 convStatus 状态栏
    if (evt.type === 'hello' || evt.type === 'status') {
      if (evt.status === 'running') convStatus.value = 'running'
      else if (evt.status === 'done' || evt.status === 'failed' || evt.status === 'paused') convStatus.value = evt.status
    }
    // 审批事件:弹 modal
    if (evt.type === 'approval' && evt.pending) {
      pendingApproval.value = { turnId: agentTurn._id, toolCallId: evt.pending.toolCallId, name: evt.pending.name, args: evt.pending.args }
    }
    // delta 事件:自动滚到底
    if (evt.type === 'delta') scrollToBottom()
    // 终态:关流
    if (evt.type === 'status' && (evt.status === 'done' || evt.status === 'failed')) {
      stopStreaming(); sending.value = false; scrollToBottom()
    }
    // end 事件:若已到终态则关流,否则也关(连接终结)
    if (evt.type === 'end') {
      stopStreaming(); sending.value = false
      // 兜底:若 end 到达但状态仍非终态(race),pollOnce 对齐一次
      if (!agentTurnDoneOrFinal()) pollOnce(id)
    }
  }
  es.onerror = () => {
    // 连接异常(EventSource 默认会自动重连,这里主动关闭避免重复连接)
    stopStreaming()
    // 已到终态:无需降级
    if (agentTurnDoneOrFinal()) { sending.value = false; return }
    // 未到终态:降级到轮询兜底(pollOnce 对齐一次 + startPolling 继续)
    pollOnce(id).then(() => {
      if (!agentTurnDoneOrFinal() && convStatus.value === 'running') startPolling(id)
    })
  }
}

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg || sending.value) return
  const userId = ++turnSeq
  const agentId = ++turnSeq
  turns.value.push({ _id: userId, role: 'user', content: msg, refs: refs.value.length ? [...refs.value] : undefined })
  turns.value.push({ _id: agentId, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
  resetInput()
  sending.value = true
  await scrollToBottom()
  try {
    const payload = { projectId: props.projectId, message: msg }
    if (refs.value.length) {
      payload.references = refs.value.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name }))
      refs.value = []
    }
    // 续接既有对话(append) vs 新建对话(create):
    // activeConversationId 来自父级(选中的对话)— 有则 POST /messages 续接,不 emit conversation-created;
    // 无则 POST /conversations 新建并通知父级刷新列表。
    // feature LLM 硬化:startStreaming(EventSource SSE)为 主路径;es.onerror 降级到 pollOnce + startPolling 兜底。
    if (props.activeConversationId) {
      await workbenchApi.conversations.append(props.activeConversationId, { message: msg, references: payload.references })
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      startStreaming(props.activeConversationId)
    } else {
      const { id, references } = await workbenchApi.conversations.create(payload)
      conversationId.value = id
      convStatus.value = 'running'
      // 后端取回的完整资源对象挂到 user turn 的 refs(按 name+namespace 匹配)→ ChatTurn 渲染 ResourceCard
      if (Array.isArray(references) && references.length) {
        const ut = turns.value.find(x => x._id === userId)
        if (ut?.refs) ut.refs.forEach(ref => { ref.resource = references.find(r => r?.metadata?.name === ref.name && (r?.metadata?.namespace || '') === (ref.namespace || '')) })
      }
      emit('conversation-created', id)
      startStreaming(id)
    }
  } catch (e) {
    updateTurn(agentId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') })
    if (e.status === 503) errorBanner.value = e.message
    sending.value = false
  }
}

async function decideApproval(approved) {
  const pa = pendingApproval.value
  if (!pa || !conversationId.value) return
  pendingApproval.value = null
  sending.value = true
  await scrollToBottom()
  try {
    const id = conversationId.value
    if (approved) { await workbenchApi.conversations.approve(id) }
    else { await workbenchApi.conversations.deny(id) }
    convStatus.value = 'running'
    if (pa.turnId) updateTurn(pa.turnId, { status: 'thinking' })
    startStreaming(id)
  } catch (e) {
    if (pa.turnId) updateTurn(pa.turnId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') })
    sending.value = false
  }
}

function onKeydown(e) {
  // @-mention 下拉打开时:↑↓ 移动选中,Enter/Tab 选中项,Esc 关闭
  if (searchOpen.value && mentionItems.value.length) {
    const n = mentionItems.value.length
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex.value = (activeIndex.value + 1) % n; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex.value = (activeIndex.value - 1 + n) % n; return }
    if ((e.key === 'Enter' || e.key === 'Tab') && activeIndex.value >= 0) {
      e.preventDefault()
      const item = mentionItems.value[activeIndex.value]
      if (kindHints.value.length) selectKind(item.alias); else selectRef(item)
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); return }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}
function autoGrow(e) {
  const ta = e.target
  ta.style.height = 'auto'
  ta.style.height = Math.min(ta.scrollHeight, 128) + 'px' // max-h-32 = 8rem ≈ 128px
}
function resetInput() {
  input.value = ''
  nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto' })
}
function useHint(h) { input.value = h }
function clearChat() { stopPolling(); stopStreaming(); turns.value = []; pendingApproval.value = null; errorBanner.value = ''; conversationId.value = null; convStatus.value = null; recap.value = '' }
</script>

<template>
  <section class="h-full flex flex-col min-h-0 bg-surface-container-lowest">
    <!-- Status bar -->
    <div v-if="convStatus" class="shrink-0 flex items-center justify-center gap-xs py-0.5 bg-surface-container-low border-b border-outline-variant">
      <span class="w-2 h-2 rounded-full animate-pulse" :class="{ 'bg-status-running': convStatus === 'running', 'bg-status-warning': convStatus === 'paused', 'bg-error': convStatus === 'failed', 'bg-on-surface-variant/30': convStatus === 'done' }"></span>
      <span class="text-body-xs font-medium" :class="convStatusBadgeClass">{{ convStatusLabel }}</span>
    </div>
    <div v-if="errorBanner" class="shrink-0 flex items-center gap-sm text-body-sm text-error bg-error/5 border-b border-error/20 px-md py-xs"><span class="material-symbols-outlined text-base">error</span> {{ errorBanner }}</div>

    <!-- Messages -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto">
      <!-- Empty state -->
      <div v-if="!turns.length" class="h-full flex flex-col items-center justify-center px-lg">
        <div class="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-md">
          <span class="material-symbols-outlined text-2xl text-primary">smart_toy</span>
        </div>
        <p class="text-body-md font-semibold text-on-surface mb-xs">{{ t('workbench.chat.title') }}</p>
        <p class="text-body-sm text-on-surface-variant text-center mb-md">{{ t('workbench.chat.hint') }}</p>
        <div class="flex flex-col gap-xs w-full max-w-sm">
          <button v-for="h in HINTS" :key="h" @click="useHint(h)" class="flex items-center gap-sm text-body-sm text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-xl px-md py-sm hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all">
            <span class="material-symbols-outlined text-base text-primary/60">arrow_forward</span>{{ h }}
          </button>
        </div>
      </div>

      <!-- Recap card: earlier conversation summary (collapsible, shown only when conv.recap exists) -->
      <details v-if="recap" class="mx-md mt-md bg-surface-container-low border border-outline-variant rounded-lg">
        <summary class="cursor-pointer select-none px-md py-sm text-body-sm font-medium text-on-surface-variant flex items-center gap-xs">
          <span class="material-symbols-outlined text-base text-primary/60">summarize</span>
          {{ t('workbench.chat.recapSummary') }}
        </summary>
        <div class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{{ recap }}</div>
      </details>

      <!-- Conversation -->
      <div v-for="turn in turns" :key="turn._id">
        <ChatTurn :turn="turn" />
      </div>
    </div>

    <!-- Input area -->
    <div class="shrink-0 border-t border-outline-variant p-md bg-surface-container-lowest">
      <!-- @-ref chips -->
      <div v-if="refs.length" class="flex flex-wrap gap-xs mb-sm">
        <div v-for="(r, i) in refs" :key="i" class="flex items-center gap-xs bg-primary/10 border border-primary/20 rounded-lg px-sm py-xs">
          <span class="material-symbols-outlined text-sm text-primary">{{ refIcon(r.kind) }}</span>
          <span class="text-body-xs font-mono font-semibold text-primary">{{ r.name }}</span>
          <span class="text-body-xs text-on-surface-variant">{{ r.namespace }}</span>
          <button @click="removeRef(i)" class="ml-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-sm">close</span></button>
        </div>
      </div>

      <!-- Input + search dropdown -->
      <div class="relative">
        <div class="flex items-end gap-sm bg-surface-container-low border border-outline-variant rounded-2xl px-md py-sm focus-within:border-primary/40 transition-colors">
          <textarea ref="taEl" v-model="input" @keydown="onKeydown" @input="autoGrow" :disabled="sending || !!pendingApproval" rows="1" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-sm leading-relaxed max-h-32"></textarea>
          <button @click="send" :disabled="sending || !input.trim() || !!pendingApproval" class="shrink-0 w-8 h-8 flex items-center justify-center bg-primary text-on-primary rounded-xl disabled:opacity-30 hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-base">send</span>
          </button>
        </div>

        <!-- @-mention dropdown -->
        <div v-if="searchOpen" class="absolute bottom-full left-0 right-0 mb-xs bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl max-h-64 overflow-y-auto z-30">
          <template v-if="kindHints.length">
            <div class="px-md py-xs text-body-xs text-on-surface-variant border-b border-outline-variant">{{ t('workbench.chat.atMentionHint') }}</div>
            <button v-for="(h, i) in kindHints" :key="h.alias" @mousedown.prevent="selectKind(h.alias)" class="w-full flex items-center gap-sm text-left px-md py-sm transition-colors"
              :class="i === activeIndex ? 'bg-primary/10' : 'hover:bg-primary/5'">
              <span class="material-symbols-outlined text-base text-primary">{{ refIcon(h.alias) }}</span>
              <span class="text-body-sm font-semibold text-on-surface">{{ h.label }}</span>
              <span class="text-body-xs text-on-surface-variant font-mono ml-auto">@{{ h.alias }}:</span>
            </button>
          </template>
          <template v-else>
            <div v-if="searching" class="px-md py-sm text-body-sm text-on-surface-variant flex items-center gap-sm">
              <span class="material-symbols-outlined animate-spin text-base">progress_activity</span> {{ t('workbench.chat.atMentionSearching') }}
            </div>
            <div v-else-if="!searchResults.length" class="px-md py-sm text-body-sm text-on-surface-variant">{{ t('workbench.chat.atMentionNoResults') }}</div>
            <button v-for="(item, i) in searchResults" :key="i" @mousedown.prevent="selectRef(item)" class="w-full flex items-center gap-sm text-left px-md py-sm transition-colors"
              :class="i === activeIndex ? 'bg-primary/10' : 'hover:bg-primary/5'">
              <span class="material-symbols-outlined text-base text-primary">{{ refIcon(item.kind) }}</span>
              <div class="flex flex-col">
                <span class="text-body-sm font-mono font-semibold text-on-surface">{{ item.name }}</span>
                <span class="text-body-xs text-on-surface-variant">{{ item.namespace }}</span>
              </div>
            </button>
          </template>
        </div>
      </div>
    </div>

    <!-- Approval Modal -->
    <Modal :modelValue="!!pendingApproval" :title="t('workbench.chat.writeFileApproval')" width="max-w-2xl">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-status-warning">{{ pendingApproval.name === 'apply_project_manifests' ? 'rocket_launch' : 'edit_document' }}</span>
          <span class="font-mono font-semibold text-body-sm">{{ pendingApproval.name }}</span>
        </div>
        <p v-if="pendingApproval.name === 'apply_project_manifests'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.applyManifestsDesc')"></p>
        <p v-else-if="pendingApproval.name === 'bootstrap_ledger'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.bootstrapLedgerDesc')"></p>
        <template v-if="pendingApproval.args?.path">
          <p class="text-body-sm text-on-surface-variant">Path: <span class="font-mono text-on-surface">{{ pendingApproval.args.path }}</span></p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args.content }}</pre>
        </template>
        <pre v-else-if="pendingApproval.args?.content" class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args.content }}</pre>
      </div>
      <template #actions>
        <button @click="decideApproval(false)" :disabled="sending" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ t('workbench.chat.reject') }}</button>
        <button @click="decideApproval(true)" :disabled="sending" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">{{ t('workbench.chat.approve') }}</button>
      </template>
    </Modal>
  </section>
</template>
