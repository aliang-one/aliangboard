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
import AiConfigPanel from './AiConfigPanel.vue'
import { applyStreamEvent } from './conv-stream'
import { applyLegacyTs } from '@/utils/toolResultFormat'
import { sanitizeChatError } from '@/logic/chatErrors'
import { isNearBottomCalc } from '@/logic/chatScroll'
import { getDraft, setDraft } from '@/logic/chatDrafts'

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
const showAiConfig = ref(false)
// I(2026-08-17 审计):已决策(approve/deny)的审批 id——SSE 重连/轮询重放旧审批时跳过,
// 否则已 deny 的审批会重弹,再点 approve 语义混乱。跨组件实例不持久(服务端 CAS 兜底)。
const decidedApprovals = new Set()
let turnSeq = 0

// --- 异步对话轮询状态 ---
const conversationId = ref(null)
const pollTimer = ref(null)
const convStatus = ref(null)
const recap = ref('')   // 上一段对话摘要(多轮续接时由 pollOnce 填充,顶部折叠卡渲染)

// --- SSE streaming 状态(T8:优先用 EventSource,断线降级 pollOnce) ---
let es = null
// P0(C):异步链(send/审批/regenerate)跨过组件生命周期后,闭包不得再碰已卸载组件——
// 否则会在死组件上 startStreaming 新建 EventSource/定时器,无人回收(泄漏)。
let unmounted = false
let esErrCount = 0 // onerror 中 CONNECTING 态的自动重连次数(防风暴,>5 降级轮询)
let watchdogTimer = null // SSE 看门狗(dev31);顶部声明避免 TDZ(immediate watch 在声明前调 stopWatchdog)

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

onUnmounted(() => { unmounted = true; if (debounceTimer) clearTimeout(debounceTimer); stopPolling(); stopStreaming(); stopWatchdog(); stopStick() })

const convStatusLabel = computed(() => {
  const labels = { running: t('workbench.chat.convStatus.running'), paused: t('workbench.chat.convStatus.paused'), done: t('workbench.chat.convStatus.done'), failed: t('workbench.chat.convStatus.failed'), cancelled: t('workbench.chat.convStatus.cancelled') }
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
// 强落底(打开/切换对话/发送/用户点「回到底部」):先落一次,再开「粘底观测」——
// ResizeObserver 盯内容高度,markdown/Prism/字体/图片晚撑高也持续钉底(替代固定 250ms
// 补偿:渲染快的多滚无谓,渲染慢的仍不够)。用户滚离底部即自然停观测(isNearBottom false),
// 2s 后渲染稳定自动停;无 ResizeObserver 环境(测试)静默退化为单次落底。
let stickObserver = null, stickTimer = null
function stopStick() { if (stickObserver) { stickObserver.disconnect(); stickObserver = null } if (stickTimer) { clearTimeout(stickTimer); stickTimer = null } }
function startStick() {
  stopStick()
  const el = scrollEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  stickObserver = new ResizeObserver(() => { if (isNearBottom()) { const t = chatScroller(); if (t) t.scrollTop = t.scrollHeight } })
  if (el.firstElementChild) stickObserver.observe(el.firstElementChild)
  stickTimer = setTimeout(stopStick, 2000)
}
async function scrollToBottom() {
  await nextTick()
  const t = chatScroller(); if (!t) return
  t.scrollTop = t.scrollHeight
  startStick()
}
// 跟随落底(流式 delta/done):仅当用户本来贴底才跟——上翻读历史不被拽到底(标准聊天交互)。
// 先 await nextTick 再量:delta 的内容此刻才渲染,渲染前量高度会差一段(慢流尾段差一行)。
async function followBottom() { if (!isNearBottom()) return; await nextTick(); const t = chatScroller(); if (t) t.scrollTop = t.scrollHeight }
// 「回到底部」按钮:非贴底时露出(流式中上翻读历史的回程入口)
const showJumpBtn = ref(false)
function onChatScroll() { showJumpBtn.value = !isNearBottom() }
// 草稿实时保存(空值即删;发送后 resetInput 自动清)
watch(input, v => setDraft(conversationId.value || 'new', v))

// --- 异步轮询 ---
function stopPolling() { if (pollTimer.value) { clearInterval(pollTimer.value); pollTimer.value = null } }

// 对话初载(R2,2026-08-19):此前 watch 里单发 pollOnce + catch 静默——瞬时网络错误下
// turns 为空 → 渲染空态建议卡,观感即"对话丢失"。修复:500ms/1s/2s 退避重试;重试期间
// loading 态;重试任一次成功且 running 也起 SSE(不只首次);全部失败 → loadFailed banner。
// pollOnce 内部吞错,失败以 convStatus 仍为 null 判定(成功必置 running/paused/done/failed/cancelled)。
const convLoading = ref(false)
const LOAD_RETRY_DELAYS = [500, 1000, 2000]
async function loadConversation(convId) {
  convLoading.value = true
  try {
    await pollOnce(convId)
    for (const delay of LOAD_RETRY_DELAYS) {
      if (convStatus.value !== null || unmounted) break
      await new Promise(r => setTimeout(r, delay))
      if (unmounted) return
      await pollOnce(convId)
    }
    if (unmounted) return
    if (convStatus.value === null) {
      errorBanner.value = t('workbench.chat.loadFailed')
      // 后台续命重试(2026-08-25):初始 3.5s 退避全失败(网关重启窗口常超此值)后不再放弃——
      // 每 5s 重试(≤6 次),网关回来即重建历史;期间 send 有防线不会顶掉空态。
      scheduleLoadRevive(convId)
    } else if (convStatus.value === 'running') {
      startStreaming(convId)
    }
  } finally {
    if (!unmounted) convLoading.value = false
  }
}

// 加载失败后的后台续命重试:5s×6。成功(轮到 turns)即清 banner;组件卸载/切对话自然失效。
let loadReviveTimer = null
function scheduleLoadRevive(convId) {
  let tries = 0
  clearInterval(loadReviveTimer)
  loadReviveTimer = setInterval(async () => {
    if (unmounted || conversationId.value !== convId || turns.value.length) { clearInterval(loadReviveTimer); return }
    if (++tries > 6) { clearInterval(loadReviveTimer); return }
    await pollOnce(convId)
    if (turns.value.length) { errorBanner.value = ''; clearInterval(loadReviveTimer) }
  }, 5000)
}

// Load existing conversation when conversationId prop is set (AFTER all refs/functions defined)
watch(() => props.conversationId, async (convId) => {
  stopPolling()
  stopStreaming()
  stopWatchdog()
  turns.value = []
  conversationId.value = null
  convStatus.value = null
  recap.value = ''
  pendingApproval.value = null
  errorBanner.value = ''
  if (convId) {
    conversationId.value = convId
    // 恢复该对话的未发送草稿(切换/刷新不丢;key=对话id)
    input.value = getDraft(convId)
    await loadConversation(convId)
  } else {
    input.value = getDraft('new')
  }
}, { immediate: true })

function startPolling(id) {
  stopPolling()
  pollTimer.value = setInterval(() => pollOnce(id), 2000)
  // 立即首次拉取(不等 2s)
  pollOnce(id)
}

// ── SSE 看门狗(dev31):SSE 期间并行跑 10s 慢速对齐轮询 ──
// 动机:SSE 死亡而 onerror 未触发时(事件丢失/中间层静默断连),此前无任何机制兜底——
// 审批永远不弹、终答永远不落地,用户必须手动刷新(刷新走 pollOnce 才看到)。
// 看门狗保证:paused/done/failed 状态漂移 ≤10s 被对齐(pollOnce 的 paused 分支弹审批
// modal、done 分支落地终答)。正常运行时 pollOnce 无副作用(不覆盖 live content)。
function startWatchdog(id) {
  stopWatchdog()
  watchdogTimer = setInterval(() => {
    if (agentTurnDoneOrFinal()) { stopWatchdog(); return }
    pollOnce(id)
  }, 10000)
}
function stopWatchdog() { if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null } }

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
            // R1(2026-08-19):assistant 消息带消息级 reasoning(服务端已持久化),刷新后 thinking 可回看。
            turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'done', content: m.content || t('workbench.chat.noAnswer'), reasoning: m.reasoning || '', trace: applyLegacyTs(tryParseTrace(m.trace), m.createdAt), steps: 0, _createdAt: m.createdAt })
          }
        }
        // running/paused 且末条非 assistant-thinking:补 thinking turn(页面刷新续接运行中对话;
        // 或悬浮 Modal 打开待审批对话——paused 不补的话,审批弹着但正文无 in-flight turn,
        // approve 后 SSE 的 agentTurn 兜底到上一轮 done turn → snapshot 覆写旧答案,首轮则全丢弃)。
        const last = turns.value[turns.value.length - 1]
        if ((conv.status === 'running' || conv.status === 'paused') && !(last && last.role === 'assistant' && last.status === 'thinking')) {
          turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
        }
        // 存量对话兜底(2026-08-25 修复前的数据):assistant 消息级 trace 全空但对话级 trace 有工具事件
        // → 全部挂到最后一个 assistant turn(轮次边界无从划分,集中在末轮展示胜于全不可见)。
        const asstTurns = turns.value.filter(x => x.role === 'assistant' && x.status === 'done')
        if (asstTurns.length && asstTurns.every(x => !(x.trace || []).length)) {
          const convTrace = tryParseTrace(conv.trace).filter(e => e.type === 'tool' || e.type === 'denied')
          if (convTrace.length) {
            const lastAsst = asstTurns[asstTurns.length - 1]
            lastAsst.trace = applyLegacyTs(convTrace, lastAsst._createdAt || null)
          }
        }
      } else {
        // 旧单轮数据 fallback(无 messages 数组):user from conv.userMessage + agent thinking。
        if (conv.userMessage) turns.value.push({ _id: ++turnSeq, role: 'user', content: conv.userMessage })
        turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
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
      // 保留尾部未配对的 tool_start(运行中工具的转圈 chip):它不落库(dev27 瞬态设计),
      // 看门狗 10s 对齐轮询用 DB trace 整体覆盖时会把运行指示器抹掉——恰好在长工具
      // (wb_exec 30s)执行期间最需要它的时候。工具完成事件到达时按 name 配对移除。
      const trailing = []
      for (let i = (agentTurn.trace || []).length - 1; i >= 0; i--) {
        if (agentTurn.trace[i]?.type === 'tool_start') trailing.unshift(agentTurn.trace[i])
        else break
      }
      // 闪变修复(2026-08-25):trace 对齐与下方 content 同守卫(!es)——SSE 活跃时 live trace 是
      // 权威(当前轮、瘦身事件),conv.trace 是全对话累积(全量形状),10s 看门狗无条件覆写会让
      // 交错渲染的数据集每 10s 整体跳变 → 内容周期性消失/复现。SSE 不在(降级轮询)才用 DB 对齐。
      if (!es) agentTurn.trace = [...trace, ...trailing]
      agentTurn.steps = conv.steps ?? agentTurn.steps
      // R3(2026-08-19):SSE 不在(降级轮询/无 EventSource)时回放 conv 级检查点——
      // 服务端每 200 字落库的 content/reasoning 是此路径唯一可见进度,不回放则用户看着
      // 流出的半截回答在刷新后只剩转圈。!es 守卫必须保留:SSE 活跃时本地增量 ≥ 检查点,
      // 看门狗 10s 对齐轮询若覆写会把 live 内容倒退回滞后快照。
      if (!es && (conv.status === 'running' || conv.status === 'paused')) {
        if (conv.content) agentTurn.content = conv.content
        if (conv.reasoning) agentTurn.reasoning = conv.reasoning
      }
    }
    // 首次重建(打开/切换/刷新对话)后滚到底部:聊天约定落在最新消息,
    // 此前停在顶部 → 用户被迫从最老历史一点点往下翻。
    if (rebuiltFromMessages) await scrollToBottom()
    if (conv.status === 'paused') {
      stopPolling()
      stopWatchdog()
      let pa = null
      try { pa = conv.pendingApproval ? JSON.parse(conv.pendingApproval) : null } catch { pa = null }
      if (agentTurn) updateTurn(agentTurn._id, { status: 'pending_approval', steps: conv.steps ?? agentTurn.steps })
      if (pa) {
        // I:重放已决策的审批(轮询侧)不重弹
        if (!decidedApprovals.has(pa.toolCallId)) {
          pendingApproval.value = { turnId: agentTurn ? agentTurn._id : null, toolCallId: pa.toolCallId, name: pa.name, args: pa.args }
        }
      }
      sending.value = false
    } else if (conv.status === 'done') {
      stopPolling()
      stopWatchdog()
      // R1:done 时 conv.reasoning(终值)一并对齐到 turn——轮询降级路径无 reasoning 事件流
      if (agentTurn) updateTurn(agentTurn._id, { status: 'done', content: conv.content || t('workbench.chat.noAnswer'), reasoning: conv.reasoning || agentTurn.reasoning || '', steps: conv.steps ?? agentTurn.steps })
      sending.value = false
      await followBottom()
    } else if (conv.status === 'failed') {
      stopPolling()
      stopWatchdog()
      // 落库 error 可能是上游网关整页 HTML(如 nginx 502)——显示前净化,原文留在库里供诊断
      const errMsg = sanitizeChatError(conv.error) || t('workbench.chat.agentFailed')
      errorBanner.value = errMsg
      if (agentTurn) updateTurn(agentTurn._id, { status: 'error', error: errMsg })
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
  startWatchdog(id) // SSE 死亡无 onerror 时 ≤10s 对齐兜底(dev31)
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
      reasoning: agentTurn.reasoning || '',
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
    // 审批事件:弹 modal(I:SSE 重连 replay 已决策的审批不重弹)
    if (evt.type === 'approval' && evt.pending) {
      if (!decidedApprovals.has(evt.pending.toolCallId)) {
        pendingApproval.value = { turnId: agentTurn._id, toolCallId: evt.pending.toolCallId, name: evt.pending.name, args: evt.pending.args }
      }
    }
    // delta 事件:贴底跟随(上翻读历史不拽)
    if (evt.type === 'delta') followBottom()
    // 终态:关流
    if (evt.type === 'status' && (evt.status === 'done' || evt.status === 'failed')) {
      stopStreaming(); stopWatchdog(); sending.value = false; followBottom()
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

// 重新生成最后一条回复(P1):调 regenerate 端点(服务端截掉最后 user 之后的回复重跑),
// 本地同步移除该 assistant turn → 补 thinking → 续流。failed turn 重试同路径。
const lastAssistantIndex = computed(() => {
  for (let i = turns.value.length - 1; i >= 0; i--) if (turns.value[i].role === 'assistant') return i
  return -1
})
async function regenerate() {
  const id = props.activeConversationId || conversationId.value
  if (!id || sending.value) return
  errorBanner.value = ''
  try {
    await workbenchApi.conversations.regenerate(id)
    if (unmounted) return // P0(C)
    if (lastAssistantIndex.value >= 0) turns.value.splice(lastAssistantIndex.value, 1)
    turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
    conversationId.value = id
    convStatus.value = 'running'
    sending.value = true
    await scrollToBottom()
    startStreaming(id)
  } catch (e) {
    errorBanner.value = e.message || t('workbench.chat.agentFailed')
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
    stopStreaming(); stopPolling(); stopWatchdog()
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
  // 「历史被顶掉」防线(2026-08-25):对话存在但从未成功加载(网关抖动→loadFailed 空态)时,
  // 直接发消息会让本地 turns 只剩本轮——观感即"历史全消失"。先补一次加载,仍失败则拦下发。
  if (conversationId.value && !turns.value.length) {
    await pollOnce(conversationId.value)
    if (!turns.value.length) {
      errorBanner.value = t('workbench.chat.loadFailed')
      return
    }
  }
  const userId = ++turnSeq
  const agentId = ++turnSeq
  const refsSnapshot = refs.value.length ? [...refs.value] : null // P0(B):失败回滚用
  turns.value.push({ _id: userId, role: 'user', content: msg, refs: refsSnapshot ? [...refsSnapshot] : undefined })
  turns.value.push({ _id: agentId, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
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
      if (unmounted) return // P0(C):await 期间被卸载(切对话/关 Modal)——不再碰已死组件
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      if (Array.isArray(references) && references.length) {
        const ut = turns.value.find(x => x._id === userId)
        if (ut?.refs) ut.refs.forEach(ref => { ref.resource = references.find(r => r?.metadata?.name === ref.name && (r?.metadata?.namespace || '') === (ref.namespace || '')) })
      }
      startStreaming(props.activeConversationId)
    } else {
      const { id, references } = await workbenchApi.conversations.create(payload)
      if (unmounted) return // P0(C)
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
    // P0(B):发送失败回滚——幻影 user turn 从未落库,残留会永久混进后续真实历史
    // (pollOnce 见 turns 非空不重建,直到刷新才"反向蒸发");输入/草稿/refs 还原,不必凭记忆重打。
    turns.value = turns.value.filter(x => x._id !== userId && x._id !== agentId)
    input.value = msg
    setDraft(conversationId.value || 'new', msg)
    if (refsSnapshot) refs.value = refsSnapshot
    errorBanner.value = e.message || t('workbench.chat.agentFailed')
    sending.value = false
  }
}

async function decideApproval(approved) {
  const pa = pendingApproval.value
  if (!pa || !conversationId.value) return
  pendingApproval.value = null
  decidedApprovals.add(pa.toolCallId) // I:决策后,该审批的重放(SSE/轮询)不再弹
  sending.value = true
  await scrollToBottom()
  try {
    const id = conversationId.value
    if (approved) { await workbenchApi.conversations.approve(id) }
    else { await workbenchApi.conversations.deny(id) }
    if (unmounted) return // P0(C)
    convStatus.value = 'running'
    if (pa.turnId) updateTurn(pa.turnId, { status: 'thinking' })
    startStreaming(id)
  } catch (e) {
    if (!unmounted && pa.turnId) updateTurn(pa.turnId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') })
    if (!unmounted) sending.value = false
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
function clearChat() { stopPolling(); stopStreaming(); stopWatchdog(); turns.value = []; pendingApproval.value = null; errorBanner.value = ''; conversationId.value = null; convStatus.value = null; recap.value = '' }
</script>

<template>
  <section class="h-full flex flex-col min-h-0 bg-surface-container-lowest">
    <!-- Status bar -->
    <div v-if="convStatus" class="shrink-0 flex items-center justify-center gap-xs py-0.5 bg-surface-container-low border-b border-outline-variant">
      <span class="w-2 h-2 rounded-full animate-pulse" :class="{ 'bg-status-running': convStatus === 'running', 'bg-status-warning': convStatus === 'paused', 'bg-error': convStatus === 'failed', 'bg-on-surface-variant/30': convStatus === 'done' || convStatus === 'cancelled' }"></span>
      <span class="text-body-xs font-medium" :class="convStatusBadgeClass">{{ convStatusLabel }}</span>
    </div>
    <div v-if="errorBanner" class="shrink-0 flex items-center gap-sm text-body-sm text-error bg-error/5 border-b border-error/20 px-md py-xs"><span class="material-symbols-outlined text-base">error</span> {{ errorBanner }}</div>

    <!-- Messages -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" @scroll="onChatScroll">
      <!-- 对话初载/退避重试中(R2):显示 loading 而非空态——单发静默失败曾让"没加载出来"
           被误读成"没有对话";加载失败(errorBanner)时同样不出建议卡,由 banner 示错 -->
      <div v-if="convLoading || (!turns.length && errorBanner)" class="h-full flex items-center justify-center">
        <span class="material-symbols-outlined animate-spin text-2xl text-on-surface-variant">{{ convLoading ? 'progress_activity' : 'cloud_off' }}</span>
      </div>
      <!-- Empty state:轻量建议式(去大图标孤岛/全宽边框按钮),附 @-mention 可发现性提示 -->
      <div v-else-if="!turns.length" class="h-full flex flex-col items-center justify-center px-lg">
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
        <div v-for="(turn, i) in turns" :key="turn._id">
          <ChatTurn :turn="turn"
            :show-regenerate="turn.role === 'assistant' && i === lastAssistantIndex && !sending && ['done', 'error'].includes(turn.status)"
            @regenerate="regenerate" />
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

        <!-- AI 配置透明面板入口(2026-08-25):恒可见——有对话时面板显示该对话烘焙的 system -->
        <div class="flex justify-end mt-xs">
          <button @click="showAiConfig = true" :title="t('workbench.chat.aiConfig.open')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-sm">tune</span>{{ t('workbench.chat.aiConfig.open') }}
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
    <AiConfigPanel v-model="showAiConfig" :conversation-id="conversationId" />
  </section>
</template>
