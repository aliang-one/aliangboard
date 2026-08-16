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
import { isNearBottomCalc } from '@/logic/chatScroll'

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
let esErrCount = 0 // onerror 中 CONNECTING 态的自动重连次数(防风暴,>5 降级轮询)

// --- @-mention state ---
const refs = ref([])
const searchResults = ref([])
const searching = ref(false)
const searchOpen = ref(false)
const kindHints = ref([])  // @ 后无 : → kind 补全
const activeIndex = ref(-1)  // @-mention 下拉键盘选中索引(-1=无)
const mentionItems = computed(() => kindHints.value.length ? kindHints.value : searchResults.value)
const KIND_ALIASES = { pod:'pods', pods:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', cm:'configmaps', configmap:'configmaps', ns:'namespaces', namespace:'namespaces', ingress:'ingresses', secret:'secrets', sts:'statefulsets', statefulset:'statefulsets', ds:'daemonsets', daemonset:'daemonsets', node:'nodes', nodes:'nodes', pv:'persistentvolumes', persistentvolume:'persistentvolumes', pvc:'persistentvolumeclaims', persistentvolumeclaim:'persistentvolumeclaims', sc:'storageclasses', storageclass:'storageclasses', netpol:'networkpolicies', networkpolicy:'networkpolicies', sa:'serviceaccounts', serviceaccount:'serviceaccounts' }
const KIND_LABELS = { pod:'Pod', pods:'Pod', deploy:'Deployment', deployment:'Deployment', svc:'Service', service:'Service', cm:'ConfigMap', configmap:'ConfigMap', ns:'Namespace', namespace:'Namespace', ingress:'Ingress', secret:'Secret', sts:'StatefulSet', statefulset:'StatefulSet', ds:'DaemonSet', daemonset:'DaemonSet', node:'Node', nodes:'Node', pv:'PersistentVolume', persistentvolume:'PersistentVolume', pvc:'PersistentVolumeClaim', persistentvolumeclaim:'PersistentVolumeClaim', sc:'StorageClass', storageclass:'StorageClass', netpol:'NetworkPolicy', networkpolicy:'NetworkPolicy', sa:'ServiceAccount', serviceaccount:'ServiceAccount' }
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

// 审批弹窗:按工具选图标/标题/目标行(wb_exec 等运维工具不再套"写文件"文案)
const APPROVAL_ICONS = { apply_project_manifests: 'rocket_launch', bootstrap_ledger: 'fact_check', wb_exec: 'terminal', wb_scale: 'unfold_more', wb_restart: 'restart_alt', wb_update_image: 'system_update_alt', wb_rollout_undo: 'undo' }
const approvalIcon = computed(() => APPROVAL_ICONS[pendingApproval.value?.name] || 'edit_document')
const approvalTitle = computed(() => {
  const n = pendingApproval.value?.name
  if (n === 'wb_exec') return t('workbench.chat.execApprovalTitle')
  if (n && n.startsWith('wb_')) return t('workbench.chat.actionApprovalTitle')
  return t('workbench.chat.writeFileApproval')
})
// 目标行 + 变更意图:审批前必须能看到"改哪个对象、改成什么"(replicas/image/revision),否则是盲审
const approvalTarget = computed(() => {
  const a = pendingApproval.value?.args || {}
  const ns = a.namespace ? `${a.namespace}/` : ''
  let target = ''
  if (a.pod) target = `${ns}${a.pod}${a.container ? ` (${a.container})` : ''}`
  else if (a.kind && a.name) target = `${ns}${a.kind}/${a.name}`
  const intents = []
  if (a.replicas != null) intents.push(`replicas=${a.replicas}`)
  if (a.image) intents.push(`image=${a.image}`)
  if (a.toRevision != null) intents.push(`rev=${a.toRevision}`)
  return target ? `${target}${intents.length ? ' → ' + intents.join(', ') : ''}` : ''
})

const HINTS = computed(() => [
  t('workbench.chat.hintReadLedger'),
  t('workbench.chat.hintWriteConfig'),
  t('workbench.chat.hintListFiles'),
])

const KIND_ICONS = { Pod:'podcasts', Deployment:'deployed_code', Service:'hub', Namespace:'folder', Ingress:'dns', ConfigMap:'description', Secret:'lock', StatefulSet:'storage', DaemonSet:'dns', Node:'memory', Persistentvolume:'sd_storage', Persistentvolumeclaim:'save', Storageclass:'database', Networkpolicy:'shield', Serviceaccount:'badge' }
function refIcon(kind) {
  if (!kind) return 'label'
  const k = kind.charAt(0).toUpperCase() + kind.slice(1).replace(/s$/, '')
  return KIND_ICONS[k] || KIND_ICONS[kind] || 'extension'
}

function updateTurn(tid, patch) { const t = turns.value.find(x => x._id === tid); if (t) Object.assign(t, patch) }

// 当前活动 agent turn:多轮对话必须取【最后一个】thinking(本轮占位)——取首个会把
// delta/status/trace 写到历史 turn 上、新 turn 永久 spinner("思考中…"卡到刷新才见结果)。
// 轮询路径曾修过(Finding #1);SSE 路径 2026-08-14 修(同款 bug,此前测试环境无
// EventSource 全走轮询,从未暴露)。无 thinking(已终态后的迟到事件)兜底最后一个 assistant。
function activeAgentTurn() {
  const rev = [...turns.value].reverse()
  return rev.find(x => x.role === 'assistant' && x.status === 'thinking') ?? rev.find(x => x.role === 'assistant')
}
// 滚到真正可滚的容器:聊天区若未获得视口高度约束(h-full 链在 AppLayout transition 层断裂,
// scrollEl 自动撑高永不溢出),滚动实际发生在页面级容器——向上找最近的溢出祖先滚它。
function scrollableOf(el) {
  let n = el
  while (n && n !== document.body) {
    if (n.scrollHeight > n.clientHeight + 1) return n
    n = n.parentElement
  }
  return el
}
function chatScroller() { const el = scrollEl.value; return el ? scrollableOf(el) : null }
function isNearBottom() { const t = chatScroller(); if (!t) return true; return isNearBottomCalc(t.scrollHeight, t.scrollTop, t.clientHeight) }
// 强落底(打开/切换对话/发送/用户点「回到底部」):nextTick + rAF + 250ms 三段补偿——
// markdown/Prism 高亮/字体在首渲后仍会撑高,单次 nextTick 会落在半途。
async function scrollToBottom() {
  await nextTick()
  let t = chatScroller(); if (!t) return
  t.scrollTop = t.scrollHeight
  requestAnimationFrame(() => { const t2 = chatScroller(); if (t2) t2.scrollTop = t2.scrollHeight })
  setTimeout(() => { const t2 = chatScroller(); if (t2) t2.scrollTop = t2.scrollHeight }, 250)
}
// 跟随落底(流式 delta/done):仅当用户本来贴底才跟——上翻读历史不被拽到底(标准聊天交互)。
function followBottom() { if (isNearBottom()) { const t = chatScroller(); if (t) t.scrollTop = t.scrollHeight } }
// 「回到底部」按钮:非贴底时露出(流式中上翻读历史的回程入口)
const showJumpBtn = ref(false)
function onChatScroll() { showJumpBtn.value = !isNearBottom() }

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
    // running/paused 需操作末尾的 thinking turn(刚补的)。重建分支不做 last-assistant 兜底
    // (rebuilt turns 全终态,误兜底会把 done 覆盖成 running 语义)。
    // 非重建(send/续接路径)与 SSE onmessage 共用 activeAgentTurn()(见其注释)。
    const agentTurn = rebuiltFromMessages
      ? [...turns.value].reverse().find(x => x.role === 'assistant' && x.status === 'thinking')
      : activeAgentTurn()
    // 更新 trace(running/paused 时的 live trace;done+rebuilt 时各 turn 已自带 trace,不覆盖)
    if (agentTurn) {
      let trace = []
      if (conv.trace) { try { trace = JSON.parse(conv.trace) } catch { trace = [] } }
      agentTurn.trace = trace
      agentTurn.steps = conv.steps ?? agentTurn.steps
    }
    // 首次重建(打开/切换/刷新对话)后滚到底部:聊天约定落在最新消息,
    // 此前停在顶部 → 用户被迫从最老历史一点点往下翻。
    if (rebuiltFromMessages) await scrollToBottom()
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
  // 同款 first-match 陷阱:取首个 assistant(历史 done)会把续接中的对话误判"已终态"
  // → SSE 断线时不降级轮询(es.onerror 早退)→ 本轮 thinking 卡死。
  const at = activeAgentTurn()
  if (!at) return true
  return at.status === 'done' || at.status === 'error' || at.status === 'pending_approval'
}

function startStreaming(id) {
  stopStreaming()
  stopPolling()
  esErrCount = 0 // 每次建连重置重连风暴计数
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
    const agentTurn = activeAgentTurn()
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
    // cancelled 事件 reducer 不带文案(纯函数无 i18n),这里用 t() 补"已停止"
    if (next.status === 'error' && !next.error) next.error = t('workbench.chat.stopped')
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
    // delta 事件:贴底跟随(上翻读历史不拽)
    if (evt.type === 'delta') followBottom()
    // 终态:关流
    if (evt.type === 'status' && (evt.status === 'done' || evt.status === 'failed')) {
      stopStreaming(); sending.value = false; followBottom()
    }
    // end 事件:若已到终态则关流,否则也关(连接终结)
    if (evt.type === 'end') {
      stopStreaming(); sending.value = false
      // 兜底:若 end 到达但状态仍非终态(race),pollOnce 对齐一次
      if (!agentTurnDoneOrFinal()) pollOnce(id)
    }
  }
  es.onerror = () => {
    // 断流修复(2026-08-16):readyState=CONNECTING 表示浏览器将自动重连(~3s)——不关流,
    // 重连后服务端补发 snapshot,中段文本无缝续上(旧实现这里直接 close + 降级轮询,
    // 轮询不显示增量 → "回答到一半就没有后续流式"的直接原因)。
    // CLOSED(服务端正常关流且未自动重连)或重连风暴(>5 次未恢复)才降级轮询兜底。
    if (es && es.readyState === 0 /* CONNECTING */ && esErrCount < 5) { esErrCount++; return }
    stopStreaming()
    // 已到终态:无需降级
    if (agentTurnDoneOrFinal()) { sending.value = false; return }
    // 未到终态:降级到轮询兜底(pollOnce 对齐一次 + startPolling 继续)
    pollOnce(id).then(() => {
      if (!agentTurnDoneOrFinal() && convStatus.value === 'running') startPolling(id)
    })
  }
}

// 停止运行中的对话(输错内容→停止→修改重发):调 cancel 端点;本地即刻停流/停轮询、
// thinking turn 置停止态,并把最后一条 user 消息回填输入框供修改重发。
// 竞态:agent 恰在 cancel 前完成 → cancel 返 400 → pollOnce 对齐终态。
async function stopRun() {
  if (!conversationId.value || !sending.value) return
  const lastUser = [...turns.value].reverse().find(x => x.role === 'user')
  let cancelled = false
  try { await workbenchApi.conversations.cancel(conversationId.value); cancelled = true }
  catch { cancelled = false }
  if (cancelled) {
    stopStreaming(); stopPolling()
    const at = activeAgentTurn()
    if (at && at.status === 'thinking') updateTurn(at._id, { status: 'error', error: t('workbench.chat.stopped') })
    convStatus.value = 'cancelled'
    sending.value = false
    if (lastUser) { input.value = lastUser.content; nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto' }) }
  } else {
    // 已终态(等):拉一次对齐显示
    try { await pollOnce(conversationId.value) } catch { /* 忽略 */ }
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
      const { references } = await workbenchApi.conversations.append(props.activeConversationId, { message: msg, references: payload.references })
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      if (Array.isArray(references) && references.length) {
        const ut = turns.value.find(x => x._id === userId)
        if (ut?.refs) ut.refs.forEach(ref => { ref.resource = references.find(r => r?.metadata?.name === ref.name && (r?.metadata?.namespace || '') === (ref.namespace || '')) })
      }
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
  // 中文输入法组合期(按住回车选词/确认候选):按键属 IME,不触发发送/选中。
  // keyCode 229 为旧浏览器 IME 标记,双保险。
  if (e.isComposing || e.keyCode === 229) return
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
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" @scroll="onChatScroll">
      <!-- Empty state:轻量建议式(去大图标孤岛/全宽边框按钮),附 @-mention 可发现性提示 -->
      <div v-if="!turns.length" class="h-full flex flex-col items-center justify-center px-lg">
        <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-sm">
          <span class="material-symbols-outlined text-xl text-primary">smart_toy</span>
        </div>
        <p class="text-body-md font-semibold text-on-surface">{{ t('workbench.chat.title') }}</p>
        <p class="text-body-sm text-on-surface-variant text-center mt-xs mb-lg">{{ t('workbench.chat.hint') }}</p>
        <div class="flex flex-col gap-xs w-full max-w-md">
          <button v-for="h in HINTS" :key="h" @click="useHint(h)" class="group flex items-center gap-sm text-body-sm text-on-surface-variant rounded-lg px-md py-sm text-left hover:bg-surface-container-low hover:text-on-surface transition-colors">
            <span class="material-symbols-outlined text-base text-primary/50 group-hover:text-primary transition-colors">arrow_forward</span>{{ h }}
          </button>
        </div>
        <p class="text-body-xs text-on-surface-variant/60 mt-lg flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">alternate_email</span>{{ t('workbench.chat.atMentionHint') }}
        </p>
      </div>

      <!-- 阅读列:消息/摘要限宽居中(宽屏下行长失控、左右失衡的根因),与输入列同宽对齐 -->
      <div v-else class="mx-auto w-full max-w-3xl px-md">
        <!-- Recap card: earlier conversation summary (collapsible, shown only when conv.recap exists) -->
        <details v-if="recap" class="mt-md bg-surface-container-low border border-outline-variant rounded-lg">
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

        <!-- 回到底部:非贴底时悬浮露出(流式中上翻读历史的回程入口;sticky 随内容驻留视口底) -->
        <div v-if="showJumpBtn" class="sticky bottom-2 flex justify-end pr-sm pointer-events-none">
          <button @click="scrollToBottom()" :title="t('workbench.chat.jumpBottom')"
            class="pointer-events-auto flex items-center justify-center w-8 h-8 rounded-full bg-surface-container-high text-on-surface-variant border border-outline-variant shadow-card hover:bg-surface-container-highest hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-base">arrow_downward</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Input area(与阅读列同宽对齐,消息/输入左右边缘一致) -->
    <div class="shrink-0 border-t border-outline-variant p-md bg-surface-container-lowest">
      <div class="mx-auto w-full max-w-3xl">
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
          <textarea ref="taEl" v-model="input" @keydown="onKeydown" @input="autoGrow" :disabled="!!pendingApproval" rows="1" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-sm leading-relaxed max-h-32"></textarea>
          <!-- 运行中:发送键变停止键(输错→停止→修改重发);等待审批时不显示 -->
          <button v-if="sending && conversationId && !pendingApproval" @click="stopRun" :title="t('workbench.chat.stop')"
            class="shrink-0 w-8 h-8 flex items-center justify-center border border-error/40 text-error rounded-xl hover:bg-error/10 transition-colors">
            <span class="material-symbols-outlined text-base">stop</span>
          </button>
          <button v-else @click="send" :disabled="sending || !input.trim() || !!pendingApproval" class="shrink-0 w-8 h-8 flex items-center justify-center bg-primary text-on-primary rounded-xl disabled:opacity-30 hover:opacity-90 transition-opacity">
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
    </div>

    <!-- Approval Modal -->
    <Modal :modelValue="!!pendingApproval" :title="approvalTitle" width="max-w-2xl">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-status-warning">{{ approvalIcon }}</span>
          <span class="font-mono font-semibold text-body-sm">{{ pendingApproval.name }}</span>
        </div>
        <p v-if="pendingApproval.name === 'apply_project_manifests'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.applyManifestsDesc')"></p>
        <p v-else-if="pendingApproval.name === 'bootstrap_ledger'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.bootstrapLedgerDesc')"></p>
        <p v-else-if="pendingApproval.name === 'wb_exec'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.execDesc')"></p>
        <!-- wb_* 运维工具目标行(kind/name 或 pod),wb_exec 的 ns/pod/container 归入命令块上方的目标行 -->
        <p v-if="approvalTarget && pendingApproval.name !== 'wb_exec'" class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget }}</span></p>
        <template v-if="pendingApproval.name === 'wb_exec'">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget }}</span></p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args?.command }}</pre>
        </template>
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
