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
import { workbenchApi } from '@/api/client'
import Modal from '@/components/common/Modal.vue'

const props = defineProps({
  projectId: String,
  projectName: String,
  conversationId: { type: String, default: null },
})
const emit = defineEmits(['conversation-created'])

const { t } = useI18n()

const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
const scrollEl = ref(null)
const pendingApproval = ref(null)
let turnSeq = 0

// --- 异步对话轮询状态 ---
const conversationId = ref(null)
const pollTimer = ref(null)
const convStatus = ref(null)

// --- @-mention state ---
const refs = ref([])
const searchResults = ref([])
const searching = ref(false)
const searchOpen = ref(false)
const kindHints = ref([])  // @ 后无 : → kind 补全
const KIND_ALIASES = { pod:'pods', pods:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', cm:'configmaps', configmap:'configmaps', ns:'namespaces', namespace:'namespaces', ingress:'ingresses', secret:'secrets', sts:'statefulsets', statefulset:'statefulsets', ds:'daemonsets', daemonset:'daemonsets' }
const KIND_LABELS = { pod:'Pod', pods:'Pod', deploy:'Deployment', deployment:'Deployment', svc:'Service', service:'Service', cm:'ConfigMap', configmap:'ConfigMap', ns:'Namespace', namespace:'Namespace', ingress:'Ingress', secret:'Secret', sts:'StatefulSet', statefulset:'StatefulSet', ds:'DaemonSet', daemonset:'DaemonSet' }
// @-syntax: @ → kind hints; @pod: → resources; @pod:ns/ → ns-scoped resources; @pod:ns/name → filtered
const MENTION_RE = /@(\w*):([^@\s]*)$/
const AT_RE = /@(\w*)$/

let debounceTimer = null
function clearSearch() { searchOpen.value = false; searchResults.value = []; kindHints.value = [] }

async function doSearch(kind, q, ns) {
  searching.value = true
  searchOpen.value = true
  try {
    const data = await workbenchApi.search(props.projectId, kind, q)
    let items = (data && data.items) || []
    if (ns) items = items.filter(it => it.namespace === ns)
    searchResults.value = items
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

onUnmounted(() => { if (debounceTimer) clearTimeout(debounceTimer); stopPolling() })

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

function toolCount(trace) { return (trace || []).filter(e => e.type === 'tool' || e.type === 'denied').length }
function fmtResult(v) { if (v == null) return ''; return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }

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
  turns.value = []
  conversationId.value = null
  convStatus.value = null
  pendingApproval.value = null
  errorBanner.value = ''
  if (convId) {
    conversationId.value = convId
    await pollOnce(convId)
    if (convStatus.value === 'running') startPolling(convId)
  }
}, { immediate: true })

function startPolling(id) {
  stopPolling()
  pollTimer.value = setInterval(() => pollOnce(id), 2000)
  // 立即首次拉取(不等 2s)
  pollOnce(id)
}

async function pollOnce(id) {
  try {
    const conv = await workbenchApi.conversations.get(id)
    convStatus.value = conv.status
    const agentTurn = turns.value.find(x => x._id === turnSeq && x.role === 'assistant')
    // 更新 trace
    let trace = []
    if (conv.trace) { try { trace = JSON.parse(conv.trace) } catch { trace = [] } }
    if (agentTurn) {
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

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg || sending.value) return
  const userId = ++turnSeq
  const agentId = ++turnSeq
  turns.value.push({ _id: userId, role: 'user', content: msg, refs: refs.value.length ? [...refs.value] : undefined })
  turns.value.push({ _id: agentId, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
  input.value = ''
  sending.value = true
  await scrollToBottom()
  try {
    const payload = { projectId: props.projectId, message: msg }
    if (refs.value.length) {
      payload.references = refs.value.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name }))
      refs.value = []
    }
    const { id } = await workbenchApi.conversations.create(payload)
    conversationId.value = id
    convStatus.value = 'running'
    emit('conversation-created', id)
    startPolling(id)
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
    startPolling(id)
  } catch (e) {
    if (pa.turnId) updateTurn(pa.turnId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') })
    sending.value = false
  }
}

function onKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
function useHint(h) { input.value = h }
function clearChat() { stopPolling(); turns.value = []; pendingApproval.value = null; errorBanner.value = ''; conversationId.value = null; convStatus.value = null }
</script>

<template>
  <section class="h-full flex flex-col min-h-0 bg-surface-container-lowest">
    <!-- Status bar -->
    <div v-if="convStatus" class="shrink-0 flex items-center justify-center gap-xs py-xs bg-surface-container-low border-b border-outline-variant">
      <span class="w-2 h-2 rounded-full animate-pulse" :class="{ 'bg-status-running': convStatus === 'running', 'bg-status-warning': convStatus === 'paused', 'bg-error': convStatus === 'failed', 'bg-on-surface-variant/30': convStatus === 'done' }"></span>
      <span class="text-body-xs font-medium" :class="convStatusBadgeClass">{{ convStatusLabel }}</span>
    </div>
    <div v-if="errorBanner" class="shrink-0 flex items-center gap-sm text-body-sm text-error bg-error/5 border-b border-error/20 px-md py-sm"><span class="material-symbols-outlined text-base">error</span> {{ errorBanner }}</div>

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

      <!-- Conversation -->
      <div v-for="turn in turns" :key="turn._id" class="px-md py-sm">
        <!-- User message -->
        <div v-if="turn.role === 'user'" class="flex justify-end mb-sm">
          <div class="max-w-[80%]">
            <!-- Ref cards (resource previews) -->
            <div v-if="turn.refs && turn.refs.length" class="flex flex-wrap gap-xs mb-xs justify-end">
              <div v-for="(r, i) in turn.refs" :key="i" class="flex items-center gap-xs bg-primary/10 border border-primary/20 rounded-lg px-sm py-xs">
                <span class="material-symbols-outlined text-sm text-primary">{{ refIcon(r.kind) }}</span>
                <div class="flex flex-col">
                  <span class="text-body-xs font-mono font-semibold text-primary">{{ r.name }}</span>
                  <span class="text-body-xs text-on-surface-variant">{{ r.kind }} · {{ r.namespace }}</span>
                </div>
              </div>
            </div>
            <div class="bg-primary-container text-on-primary-container rounded-2xl rounded-br-md px-md py-sm">
              <p class="text-body-sm whitespace-pre-wrap break-words leading-relaxed">{{ turn.content }}</p>
            </div>
          </div>
        </div>

        <!-- Assistant message -->
        <div v-else class="flex flex-col gap-sm mb-sm">
          <!-- Tool trace (compact, expandable) -->
          <details v-if="turn.trace && turn.trace.length" class="group">
            <summary class="cursor-pointer flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-on-surface py-xs select-none">
              <span class="material-symbols-outlined text-sm group-open:rotate-90 transition-transform">chevron_right</span>
              <span class="material-symbols-outlined text-sm text-primary/60">account_tree</span>
              {{ toolCount(turn.trace) }} tool calls
            </summary>
            <div class="ml-md mt-xs flex flex-col gap-xs border-l-2 border-outline-variant pl-md">
              <div v-for="(ev, j) in turn.trace" :key="j">
                <div v-if="ev.type === 'tool'" class="bg-surface-container-low rounded-lg border border-outline-variant overflow-hidden">
                  <div class="flex items-center gap-xs px-sm py-xs bg-surface-container/50">
                    <span class="material-symbols-outlined text-sm text-status-running">play_arrow</span>
                    <span class="text-body-xs font-mono font-semibold text-on-surface">{{ ev.name }}</span>
                  </div>
                  <pre v-if="fmtResult(ev.result)" class="px-sm py-xs max-h-28 overflow-y-auto font-mono text-body-xs text-on-surface-variant bg-surface-container-lowest whitespace-pre-wrap break-all">{{ fmtResult(ev.result) }}</pre>
                </div>
                <div v-else-if="ev.type === 'denied'" class="flex items-center gap-xs px-sm py-xs text-body-xs text-status-warning bg-status-warning/5 rounded-lg">
                  <span class="material-symbols-outlined text-sm">block</span>
                  <span class="font-mono font-semibold">{{ ev.name }}</span> rejected
                </div>
              </div>
            </div>
          </details>

          <!-- Thinking -->
          <div v-if="turn.status === 'thinking' && !(turn.trace && turn.trace.length)" class="flex items-center gap-sm px-sm">
            <div class="flex gap-0.5">
              <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 0ms"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 150ms"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" style="animation-delay: 300ms"></span>
            </div>
            <span class="text-body-sm text-on-surface-variant">Thinking...</span>
          </div>

          <!-- Pending approval -->
          <div v-else-if="turn.status === 'pending_approval'" class="flex items-center gap-sm px-sm py-sm bg-status-warning/5 border border-status-warning/30 rounded-xl">
            <span class="material-symbols-outlined text-base text-status-warning">pending_actions</span>
            <span class="text-body-sm text-status-warning font-medium">Waiting for approval...</span>
          </div>

          <!-- Error -->
          <div v-else-if="turn.status === 'error'" class="flex items-start gap-sm px-md py-sm bg-error/5 border border-error/20 rounded-xl">
            <span class="material-symbols-outlined text-base text-error mt-0.5">error</span>
            <span class="text-body-sm text-error whitespace-pre-wrap break-words">{{ turn.error }}</span>
          </div>

          <!-- Done (answer) -->
          <template v-else-if="turn.status === 'done'">
            <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-md px-md py-sm">
              <p class="text-body-sm text-on-surface whitespace-pre-wrap break-words leading-relaxed">{{ turn.content || t('workbench.chat.noAnswer') }}</p>
            </div>
            <div class="flex items-center gap-sm text-body-xs text-on-surface-variant px-xs">
              <span>{{ turn.steps }} steps</span>
              <span v-if="turn.truncated" class="text-status-warning">⚠ truncated</span>
            </div>
          </template>
        </div>
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
          <textarea v-model="input" @keydown="onKeydown" :disabled="sending || !!pendingApproval" rows="1" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-sm leading-relaxed max-h-32"></textarea>
          <button @click="send" :disabled="sending || !input.trim() || !!pendingApproval" class="shrink-0 w-8 h-8 flex items-center justify-center bg-primary text-on-primary rounded-xl disabled:opacity-30 hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-base">send</span>
          </button>
        </div>

        <!-- @-mention dropdown -->
        <div v-if="searchOpen" class="absolute bottom-full left-0 right-0 mb-xs bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl max-h-64 overflow-y-auto z-30">
          <template v-if="kindHints.length">
            <div class="px-md py-xs text-body-xs text-on-surface-variant border-b border-outline-variant">{{ t('workbench.chat.atMentionHint') }}</div>
            <button v-for="h in kindHints" :key="h.alias" @mousedown.prevent="selectKind(h.alias)" class="w-full flex items-center gap-sm text-left px-md py-sm hover:bg-primary/5 transition-colors">
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
            <button v-for="(item, i) in searchResults" :key="i" @mousedown.prevent="selectRef(item)" class="w-full flex items-center gap-sm text-left px-md py-sm hover:bg-primary/5 transition-colors">
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
