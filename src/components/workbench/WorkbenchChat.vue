<script setup>
// 可复用 AI 聊天组件(源自已删除的 WorkbenchProjectChat,2026-08-25 随 AI 控制台清理):工作台项目的 agent 聊天。
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
import ApprovalModeSwitcher from './ApprovalModeSwitcher.vue'
import { applyStreamEvent, ensureFinalAnswerBlock, missingFinalTail } from './conv-stream'
import { pairRefResources } from '@/logic/refResources'
import { applyLegacyTs } from '@/utils/toolResultFormat'
import { sanitizeChatError } from '@/logic/chatErrors'
import { filterSlashItems } from '@/logic/chatPlaybooks'
import { isNearBottomCalc } from '@/logic/chatScroll'
import { getDraft, setDraft } from '@/logic/chatDrafts'
import { notify } from '@/composables/useToast'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  projectId: String,
  projectName: String,
  conversationId: { type: String, default: null },
  activeConversationId: { type: String, default: null },
  // 项目 owner(审批三档模式 2026-09-09 评审 Important#1):门执行 owner 的档位,切换器
  // 显示观看者自己的——非 owner 视图(admin 看他人项目)须隐藏,防 UI 谎报安全姿态。
  ownerId: { type: String, default: null },
})
const emit = defineEmits(['conversation-created'])

const { t } = useI18n()

const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
// 静默终止审计(2026-08-27):pollOnce 原空 catch 吞网络错误——网关重启/token 失效期间
// 看门狗与降级轮询全部静默失败,对话永久卡 thinking、审批 modal 永不弹且无任何提示。
// 连续失败 ≥3 次亮「连接中断」横幅,任一次成功即熄灭。
const netLost = ref(false)
let pollFailStreak = 0
const scrollEl = ref(null)
const taEl = ref(null)
const pendingApproval = ref(null)
// N2(2026-08-27 modal 审计):最近未决策审批。ESC/遮罩收起 modal 后,轮询已停/SSE 已断,
// 不会再自动重弹——turn 黄条成为重开入口。审批被消费(paused→running/done/failed)时清除。
const lastApproval = ref(null)
const showAiConfig = ref(false)
// 审批模式切换器可见性:ownerId 未知(未传)或观看者即 owner 才显示——切换器写的是观看者
// 自己的偏好,而服务端门逐调用读 project.ownerId 的档位;两者错位时显示 = 谎报安全姿态。
const auth = useAuthStore()
const approvalModeMine = computed(() => props.ownerId == null || props.ownerId === auth.user?.id)
// I(2026-08-17 审计):已决策(approve/deny)的审批 id——SSE 重连/轮询重放旧审批时跳过,
// 否则已 deny 的审批会重弹,再点 approve 语义混乱。跨组件实例不持久(服务端 CAS 兜底)。
const decidedApprovals = new Set()
let turnSeq = 0

// --- 异步对话轮询状态 ---
const conversationId = ref(null)
const pollTimer = ref(null)
const convStatus = ref(null)
// ── 状态清单单源(2026-09-07 contracts-01/03)──
// 此前 done/failed/cancelled 与 running 消费态在 SSE 透传、审批清理、drainQueue、compact 闸
// 各自手写内联数组,清单漂移已致实伤(cancelled 只在审批清理有、SSE 透传漏——跨实例取消后
// 状态栏恒「运行中」、排队消息永不自动出队)。全部收编到这两个常量。
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled']
// 审批消费态 = 终态 + running(resume):到达即撤审批 modal 与黄条重开入口。
// SSE 事件(status/hello)与 pollOnce 终态分支共用同一语义。
const APPROVAL_CONSUMED_STATUSES = ['running', ...TERMINAL_STATUSES]
// 服务端下发的上下文余量(Task 3 口径:{ estTokens, windowTokens, budgetTokens, recapUpTo, willTrim })
const ctxInfo = ref(null)
const recap = ref('')   // 上一段对话摘要(多轮续接时由 pollOnce 填充,顶部折叠卡渲染)
// 项目背景(2026-08-29 项目记忆 T4):AI 每轮携带的项目决策摘要;null=渲染空态卡(可一键生成)
const projectRecap = ref(null)
// recapLoaded 闸(终审 I2):首挂/切对话时对话数据未到,projectRecap 还是 null——
// 若无此闸,空态预展开会把「有记忆」卡也撑开且载入后无人收回。仅 pollOnce 载入后为 true;
// 切对话时复位,清空记忆(clearRecap/saveRecapEdit 清空分支)保持 true(转空态卡须展开)。
const recapLoaded = ref(false)
// recap 人工纠偏(T5 2026-08-31):编辑态草稿/保存中;清空走 confirm 二次确认
const recapEditing = ref(false)
const recapDraft = ref('')
const recapSaving = ref(false)
// 卡片本体(终审 I4):编辑器在 <details> 折叠 body 里,点编辑必须同步展开,
// 否则编辑态藏在折叠区,按钮又随编辑态消失——用户观感即「点了没反应」。
const projectRecapCard = ref(null)

// 空态卡默认展开(spec §3):入口必须一眼可见。不用 :open 声明式绑定——30s 自适应轮询
// 重渲染会与用户手动展开/收起互搏,改编程式一次性展开;有记忆态维持默认收起(现状)。
function expandRecapIfEmpty() {
  if (props.projectId && recapLoaded.value && !projectRecap.value && !recapEditing.value && projectRecapCard.value) {
    projectRecapCard.value.open = true
  }
}
watch(projectRecap, expandRecapIfEmpty)          // 清空/载入为无记忆 → 转空态卡 → 展开(须过 recapLoaded 闸)

function startRecapEdit() {
  recapDraft.value = projectRecap.value || ''
  recapEditing.value = true
  if (projectRecapCard.value) projectRecapCard.value.open = true
}
function cancelRecapEdit() { recapEditing.value = false; recapDraft.value = '' }

async function saveRecapEdit() {
  if (recapSaving.value) return
  // 清空 textarea 再保存 = 清空项目记忆(终审 M3):与「清空」按钮同款二次确认,
  // 不许一条无心操作就无确认地抹掉记忆;trim 后为空统一按「清空」提交(与确认语义一致)。
  const clearing = recapDraft.value.trim() === ''
  if (clearing && !window.confirm(t('workbench.chat.recapClearConfirm'))) return
  const next = clearing ? '' : recapDraft.value
  recapSaving.value = true
  try {
    await workbenchApi.updateProject(props.projectId, { recap: next })
    projectRecap.value = clearing ? null : next   // 清空 → null 转空态卡(watch 展开入口,recapLoaded 保持 true)
    recapEditing.value = false
    notify('success', clearing ? t('workbench.chat.recapClearDone') : t('workbench.chat.recapSaved'))
  } catch (e) {
    // 与 WorkbenchList 同款:透传服务端消息(如 recap 超长),比固定「保存失败」更可定位
    notify('error', e?.message || t('workbench.chat.recapSaveFailed'))
  } finally { recapSaving.value = false }
}

async function clearRecap() {
  if (!window.confirm(t('workbench.chat.recapClearConfirm'))) return
  if (recapSaving.value) return
  recapSaving.value = true
  try {
    await workbenchApi.updateProject(props.projectId, { recap: '' })
    projectRecap.value = null   // 转空态卡(watch 展开入口;recapLoaded 保持 true)
    recapEditing.value = false
    notify('success', t('workbench.chat.recapClearDone'))
  } catch (e) {
    notify('error', e?.message || t('workbench.chat.recapSaveFailed'))
  } finally { recapSaving.value = false }
}

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
const KIND_ALIASES = { pod:'pods', pods:'pods', deploy:'deployments', deployment:'deployments', svc:'services', service:'services', cm:'configmaps', configmap:'configmaps', ns:'namespaces', namespace:'namespaces', ingress:'ingresses', secret:'secrets', sts:'statefulsets', statefulset:'statefulsets', ds:'daemonsets', daemonset:'daemonsets', node:'nodes', nodes:'nodes', pv:'persistentvolumes', persistentvolume:'persistentvolumes', pvc:'persistentvolumeclaims', persistentvolumeclaim:'persistentvolumeclaims', sc:'storageclasses', storageclass:'storageclasses', netpol:'networkpolicies', networkpolicy:'networkpolicies', sa:'serviceaccounts', serviceaccount:'serviceaccounts', server:'server', ssh:'server' }
const KIND_LABELS = { pod:'Pod', pods:'Pod', deploy:'Deployment', deployment:'Deployment', svc:'Service', service:'Service', cm:'ConfigMap', configmap:'ConfigMap', ns:'Namespace', namespace:'Namespace', ingress:'Ingress', secret:'Secret', sts:'StatefulSet', statefulset:'StatefulSet', ds:'DaemonSet', daemonset:'DaemonSet', node:'Node', nodes:'Node', pv:'PersistentVolume', persistentvolume:'PersistentVolume', pvc:'PersistentVolumeClaim', persistentvolumeclaim:'PersistentVolumeClaim', sc:'StorageClass', storageclass:'StorageClass', netpol:'NetworkPolicy', networkpolicy:'NetworkPolicy', sa:'ServiceAccount', serviceaccount:'ServiceAccount', server:'Server' }
// @-syntax: @ → kind hints; @pod: → resources; @pod:ns/ → ns-scoped resources; @pod:ns/name → filtered
const MENTION_RE = /@(\w*):([^@\s]*)$/
const AT_RE = /@(\w*)$/

let debounceTimer = null
function clearSearch() { searchOpen.value = false; searchResults.value = []; kindHints.value = []; activeIndex.value = -1 }

// ── 斜杠面板(2026-08-28 spec §3.2):行首 / 触发,与 @-mention 互斥 ──
const SLASH_RE = /^\/(\w*)$/m
const slashOpen = ref(false)
const slashItems = ref([])
const slashActive = ref(-1)
function clearSlash() { slashOpen.value = false; slashItems.value = []; slashActive.value = -1 }
function isSlashDisabled(item) { return !!(item.enabled && !item.enabled({ canCompact: !compactDisabled.value })) }
function firstUsableSlashIndex(items) { const i = items.findIndex(it => !isSlashDisabled(it)); return i }
function selectSlashItem(item) {
  if (editing.value) cancelEdit()   // A3:编辑态让位——先还原暂存草稿,再执行选中项(剧本替换/compact 清输入)
  if (isSlashDisabled(item)) return   // 禁用动作不可选
  if (item.id === 'compact') { input.value = input.value.replace(/^\/\w*$/m, '').trimEnd(); clearSlash(); showCompact.value = true; return }
  input.value = t(item.bodyKey)     // 剧本:替换整个输入框(spec D1,插入后可编辑)
  clearSlash()
  nextTick(() => { if (taEl.value) { taEl.value.style.height = 'auto'; taEl.value.focus?.() } })
}

// @server 搜索:与 doSearch 同构但无 namespace 维度(server 无 ns,不做 ns/ 斜杠解析)
async function doServerSearch(q) {
  searching.value = true
  searchOpen.value = true
  try {
    const data = await workbenchApi.search(props.projectId, 'server', q)
    searchResults.value = (data && data.items) || []
    activeIndex.value = searchResults.value.length ? 0 : -1
  } catch { searchResults.value = [] }
  finally { searching.value = false }
}

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
  if (!val) { clearSearch(); clearSlash(); return }
  const slashMatch = val.match(SLASH_RE)
  if (slashMatch && !(val.match(MENTION_RE) || val.match(AT_RE))) {
    if (searchOpen.value) clearSearch()          // 互斥:后触发关前者
    slashItems.value = filterSlashItems(slashMatch[1])
    slashOpen.value = true
    slashActive.value = firstUsableSlashIndex(slashItems.value)
    return
  }
  if (slashOpen.value) clearSlash()
  const m = val.match(MENTION_RE)
  if (m) {
    // @kind:query — search resources of this kind
    const alias = m[1].toLowerCase()
    const rawQuery = m[2]
    const kind = KIND_ALIASES[alias]
    if (!kind) { clearSearch(); return }
    kindHints.value = []
    searching.value = true
    searchOpen.value = true
    // server 无 namespace,整体作为查询词(含 / 也不切)
    if (kind === 'server') { debounceTimer = setTimeout(() => doServerSearch(rawQuery), 200); return }
    // Parse ns/name from query: "default/nginx" → ns=default, q=nginx; "nginx" → q=nginx
    let ns = null, q = rawQuery
    if (rawQuery.includes('/')) { const [n, ...rest] = rawQuery.split('/'); ns = n; q = rest.join('/') }
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
  refs.value.push({ kind: item.kind, namespace: item.namespace || '', name: item.name })
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

onUnmounted(() => { unmounted = true; if (debounceTimer) clearTimeout(debounceTimer); stopPolling(); stopStreaming(); stopWatchdog(); stopStick(); if (earlierObserver) { earlierObserver.disconnect(); earlierObserver = null } })

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
  // CSO #5(2026-08-30):SSH 工具走独立标题,别落到泛化「集群变更审批」造成盲批观感
  if (n === 'wb_ssh_exec' || n === 'wb_ssh_read_file') return t('workbench.chat.sshApprovalTitle')
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
  else if (a.server) target = String(a.server) // SSH 远程主机目标
  else if (a.scope) target = String(a.scope)   // write_server_notes:服务器名或 __global__(全局备注)
  const intents = []
  if (a.sudo) intents.push('sudo')
  if (a.replicas != null) intents.push(`replicas=${a.replicas}`)
  if (a.image) intents.push(`image=${a.image}`)
  if (a.toRevision != null) intents.push(`rev=${a.toRevision}`)
  return target ? `${target}${intents.length ? ' → ' + intents.join(', ') : ''}` : ''
})
// approval-flow-01(2026-09-07):command 可能是数组(LLM 违 schema 传 argv 形态,exec 族常见)
// ——{{ }} 直插数组渲染成 "a,b,c" 逗号粘连,人审读不了;归一 join(' ') 后再渲染。
const approvalCommand = computed(() => {
  const c = pendingApproval.value?.args?.command
  if (Array.isArray(c)) return c.map(String).join(' ')
  return c ? String(c) : ''
})
// approval-flow-01:wb_ssh_job_write 应答——人必须看到"往哪个任务写什么",否则盲批安装器应答。
// 终审修复(2026-09-07 批次二):门只看 text——旧条件 jobId!=null && text!=null 在 LLM 违
// schema 漏发 jobId 时把应答文本挤没(approvalTarget 因 a.server 在场恒真,兜底 JSON 也被压
// 掉 → 无处渲染 = 盲批照旧)。jobId 段改由模板按在场渲染;text 对象形态 JSON 归一(防
// [object Object])。
const approvalJobText = computed(() => {
  const a = pendingApproval.value?.args || {}
  if (a.text == null) return ''
  return typeof a.text === 'string' ? a.text : JSON.stringify(a.text)
})
// approval-flow-01 兜底:无任何匹配分支的 requiresApproval 工具(未来新增/参数面变迁)此前只显示
// 工具名 = 盲批。完整 args JSON(截断)兜底,任何审批工具至少可见完整参数;已有结构化展示
// (command/path/content/应答/notes/target 行)的工具不再叠一份 JSON(同屏双显是噪音)。
const approvalArgsFallback = computed(() => {
  const a = pendingApproval.value?.args
  if (!a || typeof a !== 'object' || !Object.keys(a).length) return ''
  if (approvalCommand.value || approvalJobText.value || approvalTarget.value) return ''
  if (a.path != null || a.content != null || a.notes != null) return ''
  try {
    const s = JSON.stringify(a, null, 2)
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s
  } catch { return '' }
})

const HINTS = computed(() => [
  t('workbench.chat.hintReadLedger'),
  t('workbench.chat.hintWriteConfig'),
  t('workbench.chat.hintListFiles'),
])

const KIND_ICONS = { Pod:'podcasts', Deployment:'deployed_code', Service:'hub', Namespace:'folder', Ingress:'dns', ConfigMap:'description', Secret:'lock', StatefulSet:'storage', DaemonSet:'dns', Node:'memory', Persistentvolume:'sd_storage', Persistentvolumeclaim:'save', Storageclass:'database', Networkpolicy:'shield', Serviceaccount:'badge', Server:'dns' }
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
// 阅读列容器(流式消息真正生长的元素;见 startStick 注释)
const msgColEl = ref(null)
function startStick() {
  stopStick()
  const el = scrollEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  stickObserver = new ResizeObserver(() => { if (isNearBottom()) { const t = chatScroller(); if (t) t.scrollTop = t.scrollHeight } })
  // frontend-chat-03(2026-09-07 审计批次三):粘底观测必须盯**流式消息容器**——旧实现盯
  // scrollEl.firstElementChild,而有 projectId 时首子是项目背景 details 卡(常驻、高度
  // 不随消息变):delta 撑高发生在末子消息列,盯错元素 = 观测永不触发,粘底失效(渲染
  // 晚撑高时视口被顶离底部)。消息列挂 msgColEl;空态/加载态(无消息列)兜底 lastElementChild
  //(互斥 v-if 链的唯一内容子)。
  const target = msgColEl.value || el.lastElementChild
  if (target) stickObserver.observe(target)
  stickTimer = setTimeout(stopStick, 2000)
}
// 观测目标动态接线(frontend-chat-03 续):scrollToBottom→startStick 发生在 pollOnce 内部
// (重建即滚底),此刻 convLoading 仍 true——消息列(v-else)尚未渲染,msgColEl 为 null,
// 兜底 lastElementChild 拿到的是转圈占位 div,turns 渲染后该节点被替换脱链,观测落空。
// 消息列挂载时若粘底观测仍在窗内(2s),重指向 observe 到真实消息列(追加观察;脱链旧
// 节点不再回调,stopStick 统一回收,无泄漏)。
watch(msgColEl, el => { if (el && stickObserver) stickObserver.observe(el) })
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
      // 重挂载恢复(2026-09-03):运行中对话必须显式回到「运行中」UI 态——旧实现漏置 sending,
      // 悬浮窗关开/页面刷新后停止键消失、发送键回归,发消息被服务端 400「运行中不能续接」打回,
      // 观感即「运行中有时能发有时不能」。排队闸(见 send)也依赖此位。
      sending.value = true
      startStreaming(convId)
    }
    // 重挂载恢复的排队消息 × 已终态对话:没有 running→terminal 的跳变,须手动触发一次出队
    if (TERMINAL_STATUSES.includes(convStatus.value)) drainQueue()
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
    if (turns.value.length) {
      errorBanner.value = ''
      clearInterval(loadReviveTimer)
      // A4(salvage-gap 审计 2026-09-08):复活成功须按状态接线——running 与 loadConversation
      // 的重试分支同款(sending + startStreaming;测试环境无 EventSource 时其内部降级轮询),
      // 修复前只清 banner:运行中对话在本实例永久冻结(thinking turn 停在复活时检查点,
      // 终态永不到达、排队消息永不出队、发送吃 400 busy)。终态走 drainQueue 出队。
      if (convStatus.value === 'running') { sending.value = true; startStreaming(convId) }
      if (TERMINAL_STATUSES.includes(convStatus.value)) drainQueue()
    }
  }, 5000)
}

// ── 编辑重发(2026-08-28 spec §3.3):编辑态=锚+暂存草稿;发送走 edit 端点就地截断重跑 ──
const editing = ref(null) // { messageId, draft, draftRefs }
function startEdit(turn) {
  if (sending.value) return
  editing.value = { messageId: turn.messageId, draft: input.value, draftRefs: [...refs.value] }
  input.value = turn.content
  refs.value = (turn.refs || []).map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name }))
  nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto' })
}
function cancelEdit() {
  if (!editing.value) return
  input.value = editing.value.draft
  refs.value = editing.value.draftRefs
  editing.value = null
  // B5①(salvage-gap 审计 2026-09-08):终态跳变若落在编辑态,watch 的 drainQueue 被
  // editing 守卫拦下且无重试——退出编辑态时补触发一次(drainQueue 自带
  // sending/editing/pendingApproval 守卫,不满足时自然 no-op,无需在此复刻终态判定)。
  drainQueue()
}
const editAfterCount = computed(() => {
  if (!editing.value) return 0
  const i = turns.value.findIndex(t => t.messageId === editing.value.messageId)
  return i < 0 ? 0 : turns.value.length - 1 - i
})

// ── 渐进渲染窗口(2026-08-29 spec D2):只裁渲染不动数据——turns 全量供编辑计数/水合;
// 千条消息 DOM 常驻是滚动/流式瓶颈,日常只渲染尾部 WINDOW 条,顶部哨兵渐进扩。──
const WINDOW = 60
const renderLimit = ref(WINDOW)
const renderedTurns = computed(() => turns.value.slice(-renderLimit.value))
const remainingCount = computed(() => turns.value.length - renderedTurns.value.length)
async function loadEarlier() {
  if (!remainingCount.value) return
  const el = chatScroller()
  const before = el ? el.scrollHeight : 0
  renderLimit.value += WINDOW
  await nextTick()
  // prepend 锚定:扩出的前缀把内容顶下去,补差保视野不跳(spec §3)
  if (el) el.scrollTop += el.scrollHeight - before
}
// 哨兵 IntersectionObserver:进入视口自动扩(点击双保险;无 IO 环境降级仅点击)
let earlierObserver = null
function observeSentinel(el) {
  if (earlierObserver) { earlierObserver.disconnect(); earlierObserver = null }
  if (!el || typeof IntersectionObserver === 'undefined') return
  earlierObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadEarlier() }, { root: chatScroller() })
  earlierObserver.observe(el)
}

// Load existing conversation when conversationId prop is set (AFTER all refs/functions defined)
watch(() => props.conversationId, async (convId) => {
  stopPolling()
  stopStreaming()
  stopWatchdog()
  turns.value = []
  conversationId.value = null
  convStatus.value = null
  ctxInfo.value = null
  recap.value = ''
  projectRecap.value = null
  recapLoaded.value = false   // 切对话:新对话的 projectRecap 未见载入前不许空态预展开(终审 I2)
  pendingApproval.value = null
  errorBanner.value = ''
  editing.value = null   // 切对话:编辑态(锚+暂存草稿)不跨对话
  netLost.value = false
  pollFailStreak = 0
  lastApproval.value = null   // 切对话:旧对话的未决审批不得跟过来(黄条重开入口换对话即失效)
  renderLimit.value = WINDOW   // 切对话:渲染窗口重置回默认
  if (convId) {
    conversationId.value = convId
    // 恢复该对话的未发送草稿(切换/刷新不丢;key=对话id)
    input.value = getDraft(convId)
    await loadConversation(convId)
  } else {
    input.value = getDraft('new')
    // 无对话:不会有 pollOnce 载入 projectRecap——闸置 true 让空态卡照常默认展开(终审 I2)
    recapLoaded.value = true
    nextTick(expandRecapIfEmpty)
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
    // 上下文余量(Task 3 口径):服务端每轮下发 estTokens/windowTokens/recapUpTo/willTrim
    if (conv.context) ctxInfo.value = conv.context
    recap.value = conv.recap || ''
    if (conv.projectRecap !== undefined) projectRecap.value = conv.projectRecap
    // 首次载入一次性(终审 R2):置位 recapLoaded 闸与展开绑定在同一守卫分支——pollOnce
    // 每 2s 重跑,无条件 expand 会在用户手动收起空态卡后强制重开(与本文件「编程式一次性
    // 展开,不与用户手动收起互搏」的既定语义相撞)。null→null 赋值不触发 watch,首载为
    // 无记忆时的空态展开靠这一刀;此后 recapLoaded 恒 true,轮询不再碰卡片开合。
    // 首次载入一次性(终审 R2):置位 recapLoaded 闸与展开绑定在同一守卫分支——pollOnce
    // 每 2s 重跑,无条件 expand 会在用户手动收起空态卡后强制重开(与本文件「编程式一次性
    // 展开,不与用户手动收起互搏」的既定语义相撞)。null→null 赋值不触发 watch,首载为
    // 无记忆时的空态展开靠这一刀;此后 recapLoaded 恒 true,轮询不再碰卡片开合。
    if (!recapLoaded.value) {
      recapLoaded.value = true
      expandRecapIfEmpty()
    }
    // 首次加载(watch/send-remount 后 turns 为空):从对话数据重建 turns。
    let rebuiltFromMessages = false
    if (!turns.value.length) {
      if (Array.isArray(conv.messages) && conv.messages.length) {
        // 多轮渲染(T7):每条 message → 一个 ChatTurn。
        // 已落库的 assistant 消息都是 done 状态(写入时即终态);
        // 若对话仍在 running,说明最后一条 user 后 agent 尚未产出 → 末尾补一个 thinking turn。
        rebuiltFromMessages = true
        const msgs = conv.messages
        // A5(salvage-gap 审计 2026-09-08):终态 failed/cancelled 的末条 assistant 行 = 该轮抢救行
        // (服务端 salvage/cancelled 保留分支落库),重建须保真标 error——旧硬编码 done 把半截
        // 答案渲染成正常完成(ChatTurn error 态保留 content 渲染为「部分回答」,轮级失真消除)。
        const lastMsg = msgs[msgs.length - 1]
        const terminalFailed = conv.status === 'failed' || conv.status === 'cancelled'
        for (const m of msgs) {
          if (m.role === 'user') {
            turns.value.push({ _id: ++turnSeq, role: 'user', content: m.content, refs: parseRefs(m.refs), messageId: m.id })
          } else {
            // R1(2026-08-19):assistant 消息带消息级 reasoning(服务端已持久化),刷新后 thinking 可回看。
            // 存量尾巴自愈(2026-09-06):轮未完成落库的消息(失败/取消/硬断)已流出文本只在
            // content 无 trace 块,交错渲染看不见——重建时 missingFinalTail 算缺尾补块。
            const trace = applyLegacyTs(tryParseTrace(m.trace), m.createdAt)
            const tail = missingFinalTail(m.content, trace)
            if (tail) trace.push({ type: 'assistant', content: tail })
            const isFailedTurn = terminalFailed && m === lastMsg
            turns.value.push({
              _id: ++turnSeq, role: 'assistant',
              status: isFailedTurn ? 'error' : 'done',
              error: isFailedTurn ? (conv.status === 'cancelled' ? t('workbench.chat.stopped') : (sanitizeChatError(conv.error) || t('workbench.chat.agentFailed'))) : '',
              content: m.content || t('workbench.chat.noAnswer'), reasoning: m.reasoning || '', trace, steps: 0, _createdAt: m.createdAt,
            })
          }
        }
        // running/paused 且末条非 assistant-thinking:补 thinking turn(页面刷新续接运行中对话;
        // 或悬浮 Modal 打开待审批对话——paused 不补的话,审批弹着但正文无 in-flight turn,
        // approve 后 SSE 的 agentTurn 兜底到上一轮 done turn → snapshot 覆写旧答案,首轮则全丢弃)。
        const last = turns.value[turns.value.length - 1]
        if ((conv.status === 'running' || conv.status === 'paused') && !(last && last.role === 'assistant' && last.status === 'thinking')) {
          turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
        }
        // 存量缺口兜底(salvage-gap 审计 2026-09-08,病根C):服务端门扩展修复**前**的历史数据,
        // failed/cancelled 轮零产出窗口不落 assistant 行,该轮产出只活在 conv.trace——此处按
        // 「末条消息之后」切片合成 error turn(纯展示修复,不改库;新数据已由服务端落行覆盖)。
        if (terminalFailed && last && last.role === 'user') {
          const lastMsgTs = msgs.reduce((mx, x) => Math.max(mx, x.createdAt || 0), 0)
          const slice = tryParseTrace(conv.trace)
            .filter(e => e && (e.ts || 0) > lastMsgTs && e.type !== 'tool_start')
            .map(e => e.type === 'assistant' ? { type: 'assistant', content: e.message?.content ?? e.content ?? '', ts: e.ts } : e)
          if (slice.length) {
            turns.value.push({
              _id: ++turnSeq, role: 'assistant', status: 'error',
              error: conv.status === 'cancelled' ? t('workbench.chat.stopped') : (sanitizeChatError(conv.error) || t('workbench.chat.agentFailed')),
              content: '', reasoning: conv.reasoning || '', trace: slice, steps: conv.steps ?? 0, _createdAt: lastMsgTs,
            })
          }
        }
        // 存量对话兜底(2026-08-25 修复前的数据):assistant 消息级 trace 全空但对话级 trace 有工具事件
        // → 全部挂到最后一个 assistant turn(轮次边界无从划分,集中在末轮展示胜于全不可见)。
        // C-3(salvage-gap 审计 2026-09-08):过滤器补 assistant 文本事件(旧过滤器只捞 tool/denied,
        // 轮文本被主动丢弃——修了「不触发」仍丢文本)。
        const asstTurns = turns.value.filter(x => x.role === 'assistant' && x.status === 'done')
        if (asstTurns.length && asstTurns.every(x => !(x.trace || []).length)) {
          const convTrace = tryParseTrace(conv.trace)
            .filter(e => e && (e.type === 'tool' || e.type === 'denied' || e.type === 'assistant'))
            .map(e => e.type === 'assistant' ? { type: 'assistant', content: e.message?.content ?? e.content ?? '', ts: e.ts } : e)
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
      // 按轮切割(2026-08-25 闪变续修,与服务端 turnSnapshot 同口径):降级轮询路径也只取
      // 上一条消息之后的当前轮事件——conv.trace 是全对话累积,整包换入会把历史轮灌进当前 turn。
      if (trace.length) {
        const lastMsgTs = (conv.messages || []).reduce((m, x) => Math.max(m, x.createdAt || 0), 0)
        trace = trace.filter(e => e && (e.ts || 0) > lastMsgTs && e.type !== 'tool_start')
          .map(e => e.type === 'assistant' ? { type: 'assistant', content: e.content ?? e.message?.content ?? '', ts: e.ts } : e)
      }
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
          const p = { turnId: agentTurn ? agentTurn._id : null, toolCallId: pa.toolCallId, name: pa.name, args: pa.args }
          lastApproval.value = p
          pendingApproval.value = p
        } else {
          // frontend-chat-09 残余(2026-09-07 审计批次三;批二 fix-wave 只修了他端决策的
          // running/终态对齐):本实例已决策(approve/deny 已 resolve)但快照仍 paused——
          // 决策在途/服务端转换延迟的过渡窗。旧实现在此停轮询+停看门狗后此态无人再观测:
          // 过渡窗因网络分区/他端 CAS 消费永久化时,本端冻结在 paused(输入禁用、modal 被
          // decidedApprovals 压制、黄条已被决策路径清掉)。修复:①决策后观测哨——直接装
          // 2s 轮询 interval(刻意不经 startPolling:它会立即 pollOnce,本函数尚在栈上,
          // 重入会在自停/重启间振荡;上方 stopPolling 已清旧柄,守卫防重复叠加),状态离开
          // paused 后由 running(继续轮询)/终态(stopPolling)分支自然接管;②黄条重开入口
          // 保留——决策若实际未生效,用户可重开 modal 重试(已被他端消费则 CAS 400 对齐)。
          if (!pollTimer.value) pollTimer.value = setInterval(() => pollOnce(id), 2000)
          lastApproval.value = { turnId: agentTurn ? agentTurn._id : null, toolCallId: pa.toolCallId, name: pa.name, args: pa.args }
        }
      }
      sending.value = false
    } else if (conv.status === 'done') {
      stopPolling()
      stopWatchdog()
      lastApproval.value = null   // 离开 paused:黄条重开入口下线
      pendingApproval.value = null // contracts-03:审批被他端决策后,过期 modal 撤下、输入解禁
      // B5②(salvage-gap 审计 2026-09-08):成功对齐清残留横幅——failed 分支无条件置
      // errorBanner,done 分支此前不清,compact 失败等旧错误会挂在新答案上(生命周期对称)。
      errorBanner.value = ''
      // R1:done 时 conv.reasoning(终值)一并对齐到 turn——轮询降级路径无 reasoning 事件流。
      // 终答兜底(2026-08-28):交错模式终答显示唯一依赖 trace 的 assistant 终答块;本对齐路径
      // (看门狗/降级轮询,SSE 死亡窗口后)本地 trace 缺终答块时,只写 content 会让终答在交错
      // 模式无处渲染——ensureFinalAnswerBlock 补块(回退布局不受影响)。
      if (agentTurn) updateTurn(agentTurn._id, ensureFinalAnswerBlock({
        ...agentTurn,
        status: 'done',
        content: conv.content || t('workbench.chat.noAnswer'),
        reasoning: conv.reasoning || agentTurn.reasoning || '',
        steps: conv.steps ?? agentTurn.steps,
      }))
      sending.value = false
      await followBottom()
    } else if (conv.status === 'failed') {
      stopPolling()
      stopWatchdog()
      lastApproval.value = null   // 离开 paused:黄条重开入口下线
      pendingApproval.value = null // contracts-03:同 done
      // 落库 error 可能是上游网关整页 HTML(如 nginx 502)——显示前净化,原文留在库里供诊断
      const errMsg = sanitizeChatError(conv.error) || t('workbench.chat.agentFailed')
      errorBanner.value = errMsg
      if (agentTurn) updateTurn(agentTurn._id, { status: 'error', error: errMsg })
      sending.value = false
    } else if (conv.status === 'cancelled') {
      // cancelled 终态(2026-09-06 审计#8):此前无分支——跨 tab 取消/刷新后本 tab 永远轮询、
      // thinking turn 永远转圈。对齐同 tab 实时路径(SSE cancelled→error「已停止」)。
      stopPolling()
      stopWatchdog()
      lastApproval.value = null
      pendingApproval.value = null // contracts-03:同 done
      if (agentTurn) updateTurn(agentTurn._id, { status: 'error', error: t('workbench.chat.stopped') })
      sending.value = false
    } else if (conv.status === 'running') {
      // 终审修复(2026-09-07 批次二):他端 approve 后 paused→running——终态分支(contracts-03)
      // 管不到运行中,降级轮询/看门狗通路的过期 modal 会挂满整轮运行期。与 SSE 通路
      // APPROVAL_CONSUMED_STATUSES(含 running)同语义:撤过期弹窗 + 黄条重开入口下线;
      // 轮询/看门狗/sending 不动(运行仍在进行,textarea 禁用键是 pendingApproval/paused)。
      lastApproval.value = null
      pendingApproval.value = null
    }
    pollFailStreak = 0
    if (netLost.value) netLost.value = false
  } catch {
    // 网络抖动:计连败(≥3 次亮「连接中断」横幅),下次轮询自动重试——不再彻底静默
    if (++pollFailStreak >= 3) netLost.value = true
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
    // frontend-chat-04(2026-09-07 审计批次三):消息到达本身证明连接活着——重连风暴计数
    // 即刻清零。旧实现只增不清:长会话累计 6 次瞬时 CONNECTING 错误(可跨数小时)即被
    // 永久降级轮询(流式丢失)。清零先于解析:坏帧也算连接活(数据在流)。
    esErrCount = 0
    let evt
    try { evt = JSON.parse(ev.data) } catch { return }
    // ── 全局事件处理(approval/终态/end/convStatus):不依赖 agent turn ──
    // 静默终止审计(2026-08-27):旧实现开头 `if (!agentTurn) return` 把这些事件一起丢——
    // approval 丢失 = 审批 modal 永不弹、failed 丢失 = 无任何提示。turn 缺失(重建竞态/
    // 极端空态)时它们必须仍然生效。
    if (evt.type === 'hello' || evt.type === 'status') {
      if (evt.status === 'running') convStatus.value = 'running'
      // contracts-01(2026-09-07):cancelled 此前漏在透传清单外——跨实例取消后状态栏恒「运行中」、
      // 排队消息永不自动出队(convStatus watch 永不触发 drain)。与 hello 同款全量透传。
      else if (evt.status === 'paused' || TERMINAL_STATUSES.includes(evt.status)) convStatus.value = evt.status
    }
    // 审批事件:弹 modal(I:SSE 重连 replay 已决策的审批不重弹)
    if (evt.type === 'approval' && evt.pending) {
      if (!decidedApprovals.has(evt.pending.toolCallId)) {
        const pa = { turnId: activeAgentTurn()?._id ?? null, toolCallId: evt.pending.toolCallId, name: evt.pending.name, args: evt.pending.args }
        lastApproval.value = pa
        pendingApproval.value = pa
      }
    }
    // 审批已被消费(离开 paused:resume 的 running / 终态)→ 黄条重开入口下线 + 撤过期弹窗
    // (contracts-03:审批被他端决策后本实例 modal 不消失、输入框保持禁用)。
    // pendingApproval 清空只撤过期弹窗;decidedApprovals 语义不变(重放压制按 toolCallId)。
    // hello 也算:重连补齐时对话可能已 running/终态(断线窗口内审批被别处决策)。
    if ((evt.type === 'status' || evt.type === 'hello') && APPROVAL_CONSUMED_STATUSES.includes(evt.status)) {
      lastApproval.value = null
      pendingApproval.value = null
    }
    // 终态:关流;failed 同步亮顶部横幅(与轮询降级路径对齐——此前 SSE 路径只写 turn 内小红块)。
    // 事件到达本身证明连接活着 → 熄 netLost(终态后轮询/看门狗即停,不清则横幅永久残留)
    // contracts-01:cancelled 同入终态处理——sending 不清则 drainQueue 的 sending 守卫恒拦,
    // 排队消息在跨实例取消后永不自动出队(与 pollOnce cancelled 分支同款收尾)。
    if (evt.type === 'status' && TERMINAL_STATUSES.includes(evt.status)) {
      if (evt.status === 'failed') errorBanner.value = sanitizeChatError(evt.error) || t('workbench.chat.agentFailed')
      netLost.value = false; pollFailStreak = 0
      stopStreaming(); stopWatchdog(); sending.value = false; followBottom()
    }
    // end 事件:若已到终态则关流,否则也关(连接终结)
    if (evt.type === 'end') {
      stopStreaming(); sending.value = false
      // 兜底:若 end 到达但状态仍非终态(race),pollOnce 对齐一次
      if (!agentTurnDoneOrFinal()) pollOnce(id)
    }
    // ── turn 归约(需要 agent turn)──
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
    // error 缺文案兜底:cancelled(纯函数无 i18n)补「已停止」;其余(如 hello:failed 中间态)
    // 用通用失败文案——旧实现一律「已停止」,用户没停过却看到"已停止"是误导。
    if (next.status === 'error' && !next.error) {
      next.error = (evt.type === 'status' && evt.status === 'cancelled') ? t('workbench.chat.stopped') : t('workbench.chat.agentFailed')
    }
    // done 兜底(2026-08-27):content 与 trace 均无文本时 LLM 空回复会渲染纯空白——
    // SSE 路径补「无回答」(轮询路径 pollOnce 已有同款兜底)。
    if (evt.type === 'status' && evt.status === 'done') {
      const hasText = !!(next.content || '').trim() || (next.trace || []).some(e => e?.type === 'assistant' && e.content)
      if (!hasText) next.content = t('workbench.chat.noAnswer')
      // frontend-chat-01(2026-09-07):SSE 主路径 step.assistant 把轮文本清进 trace、content 归零
      // ——done 后 turn.content 恒空,复制按钮对每条刚完成的回答复制空串(刷新走 DB 重建 content
      // 又非空,前后不一致)。以 trace 末个 assistant 块回填 content(与 ensureFinalAnswerBlock
      // 反向同源:那边 content→补块,这边块→补 content);交错渲染只读 trace 块,不会双显。
      else if (!(next.content || '').trim()) {
        const finalBlock = [...(next.trace || [])].reverse().find(e => e?.type === 'assistant' && e.content)
        if (finalBlock) next.content = finalBlock.content
      }
    }
    updateTurn(agentTurn._id, next)
    // delta 事件:贴底跟随(上翻读历史不拽)
    if (evt.type === 'delta') followBottom()
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

// ── 上下文余量 + 手动压缩(T5,spec §4.4/§4.5)──
const showCompact = ref(false)
const compactInstruction = ref('')
const compacting = ref(false)
const ctxPct = computed(() => ctxInfo.value ? Math.min(100, Math.round(ctxInfo.value.estTokens / ctxInfo.value.windowTokens * 100)) : 0)
const ctxLevel = computed(() => ctxPct.value >= 90 ? 'red' : ctxPct.value >= 70 ? 'yellow' : 'gray')
const compactDisabled = computed(() => !TERMINAL_STATUSES.includes(convStatus.value))
async function doCompact() {
  if (!conversationId.value || compacting.value) return
  compacting.value = true
  try {
    const r = await workbenchApi.conversations.compact(conversationId.value, compactInstruction.value.trim())
    if (unmounted) return
    if (r?.ok) {
      showCompact.value = false; compactInstruction.value = ''
      if (r.context) ctxInfo.value = r.context   // compact 响应自带新口径,先行更新余量条
      notify('success', t('workbench.chat.context.compactDone'))
      await pollOnce(conversationId.value)   // recap/context 重算,顶部摘要卡+余量条更新
    }
  } catch (e) {
    // 非 2xx(platformHttp 抛错):modal 保持打开、指令不清空,供重试;banner+错误信息即反馈
    if (!unmounted) errorBanner.value = e?.message || t('workbench.chat.context.compactFailed')
  } finally { if (!unmounted) compacting.value = false }
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
    // 有排队消息时不回填:cancelled 终态会触发 drainQueue,回填文本会被出队内容覆盖,
    // 且「停止旧回答→队列继续」语义下旧内容无回填意义。
    // frontend-chat-07(2026-09-07 审计批次三):输入框非空(用户运行中打了未发送草稿——
    // 运行态不禁输入)也不回填——旧实现无条件覆盖,草稿凭空蒸发,用户被迫凭记忆重打。
    if (lastUser && !queued.value.length && !input.value.trim()) { input.value = lastUser.content; nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto' }) }
  } else {
    // 已终态(等):拉一次对齐显示
    try { await pollOnce(conversationId.value) } catch { /* 忽略 */ }
  }
}

// approval-flow-02(2026-09-07 审计批次三):paused 无取消入口 = 审批死局兜底——LLM 配置
// 缺失时 approve 400 恒拒(服务端保持 paused 供配置后重试),用户若只想放弃整个会话,
// 旧 UI 无路可走(输入禁用,只能刷新)。paused 态状态栏露出「取消会话」:调既有 cancel
// 端点(服务端 cancelConversation 支持 paused),本地对齐 cancelled(撤 modal/黄条、解禁
// 输入)。取消失败(他端已决策等)→ pollOnce 对齐服务端真实状态自愈。
async function cancelPaused() {
  if (!conversationId.value || convStatus.value !== 'paused') return
  let cancelled = false
  try { await workbenchApi.conversations.cancel(conversationId.value); cancelled = true } catch { cancelled = false }
  if (!cancelled) {
    try { await pollOnce(conversationId.value) } catch { /* 对齐兜底(pollOnce 内部自吞错) */ }
    return
  }
  stopStreaming(); stopPolling(); stopWatchdog()
  const at = activeAgentTurn()
  if (at && (at.status === 'pending_approval' || at.status === 'thinking')) updateTurn(at._id, { status: 'error', error: t('workbench.chat.stopped') })
  convStatus.value = 'cancelled'
  sending.value = false
  pendingApproval.value = null
  lastApproval.value = null
  errorBanner.value = ''   // 会话已整体放弃:审批失败的残留横幅(如 LLM 未配置)一并清场
}

// ── 运行中追加(2026-09-03):本地排队,本轮终态后自动逐条发出 ──
// 服务端 P0(D) 守卫拒绝运行中续接(detached run 无互斥,并发双 run 交错写 trace/消息),
// 故排队在前端完成:运行中发送 → 入队上屏 chip(可删) → watch convStatus 终态 → 出队走正常 send()。
// sessionStorage 按 conversationId 持久化:悬浮窗关闭重开/工作台切对话都会重挂载组件(key 绑定),
// 内存队列会丢——恢复后若对话已终态,由 loadConversation 末尾触发 drain。
const queued = ref([])
const queueKey = id => `wb-chat-queue:${id}`
function saveQueue() {
  const id = props.activeConversationId || conversationId.value
  if (!id) return
  try { queued.value.length ? sessionStorage.setItem(queueKey(id), JSON.stringify(queued.value)) : sessionStorage.removeItem(queueKey(id)) } catch { /* 私密模式等 */ }
}
function loadQueue() {
  const id = props.activeConversationId || conversationId.value
  if (!id) { queued.value = []; return }
  try { queued.value = JSON.parse(sessionStorage.getItem(queueKey(id)) || '[]') } catch { queued.value = [] }
}
function queueMessage(msg) {
  queued.value.push({ id: ++turnSeq, content: msg, refs: refs.value.length ? refs.value.map(r => ({ ...r })) : [] })
  refs.value = [] // chips 随首条排队消息带走(与 send 同语义)
  saveQueue()
}
function removeQueued(id) { queued.value = queued.value.filter(q => q.id !== id); saveQueue() }
function drainQueue() {
  if (!queued.value.length || sending.value || editing.value || pendingApproval.value) return
  const q = queued.value.shift()
  saveQueue()
  input.value = q.content
  if (q.refs?.length) refs.value = q.refs
  nextTick(() => send())
}
watch(convStatus, (s, o) => {
  if (TERMINAL_STATUSES.includes(s) && !TERMINAL_STATUSES.includes(o || '')) drainQueue()
})
watch(() => props.activeConversationId, () => loadQueue())
loadQueue()

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg) return
  // 运行中不拒发——入队,本轮回答结束自动发出(2026-09-03:旧实现静默 return,Workspace 里
  // 输入框全程可打字但回车石沉大海;悬浮窗重挂载后 sending=false 误放行,服务端 400 打回)
  if (sending.value) { queueMessage(msg); resetInput(); return }
  // 编辑重发分支(spec §3.3):编辑态发送走 edit 端点(服务端截断锚之后重跑),本地就地截断+新轮
  if (editing.value && props.activeConversationId) {
    const ed = editing.value
    const refsSnapshot = [...refs.value]
    const userIdx = turns.value.findIndex(t => t.messageId === ed.messageId)
    if (userIdx < 0) { editing.value = null; return }
    sending.value = true   // 前置(终审):await 期间双击不得双发;失败 catch 复位
    try {
      // references 恒传(含空数组):删光全部 @-chips 再发送时省略该键,服务端会沿用锚 refs——「删」路静默失效
      const payload = { messageId: ed.messageId, content: msg, references: refsSnapshot.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name })) }
      const resp = await workbenchApi.conversations.edit(props.activeConversationId, payload)
      if (unmounted) return
      turns.value.splice(userIdx)                       // 锚及之后全删
      // 2026-09-01 锚 id 回填:服务端已删旧锚行+append 新行,必须改持响应里的新行 id——
      // 沿用旧 id 会让同视图内第二次编辑报「编辑目标无效」。旧服务端无此字段时兜底旧值(仅首个编辑可用)。
      const newUserId = ++turnSeq
      turns.value.push({ _id: newUserId, role: 'user', content: msg, messageId: resp?.anchorMessageId || ed.messageId, refs: refsSnapshot.length ? [...refsSnapshot] : undefined })
      turns.value.push({ _id: ++turnSeq, role: 'assistant', status: 'thinking', content: '', reasoning: '', trace: [], steps: 0, denied: [], truncated: false, error: '', _startedAt: Date.now() })
      // contracts-08(2026-09-07 审计批次三,PT7):edit 响应 references 与 append/create 同款
      // 按下标配对进乐观 turn——否则编辑重发后 ResourceCard 降级回退 chip,须等刷新重建。
      // 旧服务端无该字段时不配对(零回归);refsSnapshot 空则无 chips 可配。
      if (Array.isArray(resp?.references) && resp.references.length) {
        const ut = turns.value.find(x => x._id === newUserId)
        if (ut?.refs) pairRefResources(ut.refs, resp.references)
      }
      editing.value = null
      resetInput()
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      if (resp?.context) ctxInfo.value = resp.context
      await scrollToBottom()
      startStreaming(props.activeConversationId)
    } catch (e) {
      errorBanner.value = e?.message || t('workbench.chat.agentFailed')   // 编辑态保留可重试(spec §4)
      if (!unmounted) sending.value = false
    }
    return
  }
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
  turns.value.push({ _id: userId, role: 'user', content: msg, refs: refsSnapshot ? [...refsSnapshot] : undefined, messageId: null })
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
      const resp = await workbenchApi.conversations.append(props.activeConversationId, { message: msg, references: payload.references })
      if (unmounted) return // P0(C):await 期间被卸载(切对话/关 Modal)——不再碰已死组件
      conversationId.value = props.activeConversationId
      convStatus.value = 'running'
      netLost.value = false; pollFailStreak = 0   // POST 成功 = 网络已活,熄断连横幅(免得残留到下次轮询)
      // contracts-09(2026-09-07 审计批次三):响应回带 user 消息行 id——乐观 turn 改持之,
      // 发送后本会话内即可编辑(旧实现恒 null,要等刷新重建才有 id;pollOnce 见 turns 非空不重建)。
      if (resp?.messageId) updateTurn(userId, { messageId: resp.messageId })
      if (Array.isArray(resp?.references) && resp.references.length) {
        const ut = turns.value.find(x => x._id === userId)
        if (ut?.refs) pairRefResources(ut.refs, resp.references) // 按下标配对(审计#11:同名不同 kind 不再错绑)
      }
      startStreaming(props.activeConversationId)
    } else {
      const resp = await workbenchApi.conversations.create(payload)
      if (unmounted) return // P0(C)
      const id = resp?.id
      // fix round 1(Minor):退化响应体(无 id)不得继续——旧解构 `const { id } = resp` 天然
      // 抛错进 catch 回滚;改 resp?.id 后护栏消失,undefined 会带着 conversation-created
      // (undefined) 与 startStreaming(undefined) 跑下去。抛错走既有回滚(撤 turns/还原输入/亮横幅)。
      if (!id) throw new Error(t('workbench.chat.agentFailed'))
      conversationId.value = id
      convStatus.value = 'running'
      netLost.value = false; pollFailStreak = 0   // 同上:POST 成功即网络已活
      // contracts-09:同 append 分支,create 响应亦回带首条 user 行 id。
      if (resp?.messageId) updateTurn(userId, { messageId: resp.messageId })
      // 后端取回的完整资源对象挂到 user turn 的 refs(按 name+namespace 匹配)→ ChatTurn 渲染 ResourceCard
      if (Array.isArray(resp?.references) && resp.references.length) {
        const ut = turns.value.find(x => x._id === userId)
        if (ut?.refs) pairRefResources(ut.refs, resp.references) // 按下标配对(审计#11:同名不同 kind 不再错绑)
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
    const resp = approved ? await workbenchApi.conversations.approve(id)
      : await workbenchApi.conversations.deny(id)
    if (unmounted) return // P0(C)
    // approval-flow-02(2026-09-07 审计批次三):deny 可能直接终态(无 LLM 配置:决策受理、
    // 无法续跑,服务端置 failed)——本地即刻对齐终态 + pollOnce 落显示,不建流假装 running。
    if (resp?.status && TERMINAL_STATUSES.includes(resp.status)) {
      convStatus.value = resp.status
      sending.value = false
      lastApproval.value = null   // 审批已消费:黄条重开入口下线
      await pollOnce(id)          // 终态对齐(错误横幅/turn 终态显示)
      return
    }
    convStatus.value = 'running'
    lastApproval.value = null   // 审批已消费:黄条重开入口下线
    if (pa.turnId) updateTurn(pa.turnId, { status: 'thinking' })
    startStreaming(id)
  } catch (e) {
    if (unmounted) return
    if (e?.status === 400) {
      // 400 不能预设含义(approval-flow-02,2026-09-07 审计批次三):先 pollOnce 对齐服务端
      // 真实状态,再按对齐结果分类(仍 paused 的两形状见下方 fix round 1 注;running 续流、
      // 终态收尾由对应分支撤下黄条/弹窗)。旧实现一刀切当 CAS 竞态吞掉,LLM 未配置的用户
      // 锁死在 paused 无任何提示。
      await pollOnce(conversationId.value)
      if (convStatus.value === 'paused') {
        // 对齐后仍 paused 又两形状(fix round 1 终审):
        // a) 决策未消费(如 LLM 未配置:服务端 400 状态未动)——本实例 pa 在 decidedApprovals,
        //    pollOnce 的 decided 分支不弹 modal(pendingApproval 仍 null)→ 恢复 modal+黄条
        //    供重试/改拒绝、撤销重放压制,横幅亮服务端明确文案。
        // b) 他端已消费本审批并 resume 后又停在**下一道审批**——pollOnce 已展示新审批
        //    modal/黄条(approve/deny 端点按行上的 pendingApproval 决策,不钉 toolCallId):
        //    恢复旧 pa 会盖掉新审批 = 用户看着旧工具、批准的却是没见过的新动作。旧 pa 不复活,
        //    新审批展示原样保留(pollOnce 已置 sending=false),CAS 竞态也不是错误、不亮横幅。
        if (!pendingApproval.value) {
          decidedApprovals.delete(pa.toolCallId)
          pendingApproval.value = pa
          lastApproval.value = pa
          errorBanner.value = e?.message || t('workbench.chat.agentFailed')
          sending.value = false
        }
      } else if (!agentTurnDoneOrFinal() && convStatus.value === 'running') {
        startStreaming(conversationId.value)
      } else {
        lastApproval.value = null   // 已消费(终态):黄条重开入口下线(重开注定再吃 400)
        sending.value = false
      }
    } else {
      // 网络/5xx:恢复 modal 供重试,并撤销重放压制——否则 modal 已清 + replay 被压 + 轮询已停
      // (paused 分支停轮询),本实例永远不再弹该审批,只剩别的实例能看到(2026-08-26 锁死修复)。
      decidedApprovals.delete(pa.toolCallId)
      pendingApproval.value = pa
      sending.value = false
    }
  }
}

function onKeydown(e) {
  // 中文输入法组合期(按住回车选词/确认候选):按键属 IME,不触发发送/选中。
  // keyCode 229 为旧浏览器 IME 标记,双保险。
  if (e.isComposing || e.keyCode === 229) return
  // @-mention / 斜杠下拉打开时:↑↓ 移动选中(斜杠只在可用项间移动),Enter/Tab 选中项,Esc 关闭
  if (slashOpen.value && slashItems.value.length) {
    const usable = slashItems.value.map((it, i) => isSlashDisabled(it) ? -1 : i).filter(i => i >= 0)
    if (e.key === 'Escape') { e.preventDefault(); clearSlash(); return }
    if (usable.length) {
      const pos = usable.indexOf(slashActive.value)
      if (e.key === 'ArrowDown') { e.preventDefault(); slashActive.value = usable[(pos + 1 + usable.length) % usable.length]; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashActive.value = usable[(pos - 1 + usable.length) % usable.length]; return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectSlashItem(slashItems.value[slashActive.value]); return }
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // 全禁用(如无对话时 /compact):不发送字面命令,关面板保留输入
      e.preventDefault(); clearSlash(); return
    }
  }
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
</script>

<template>
  <section class="h-full flex flex-col min-h-0 bg-surface-container-lowest">
    <!-- Status bar -->
    <div v-if="convStatus" class="shrink-0 flex items-center justify-center gap-xs py-0.5 bg-surface-container-low border-b border-outline-variant">
      <span class="w-2 h-2 rounded-full animate-pulse" :class="{ 'bg-status-running': convStatus === 'running', 'bg-status-warning': convStatus === 'paused', 'bg-error': convStatus === 'failed', 'bg-on-surface-variant/30': convStatus === 'done' || convStatus === 'cancelled' }"></span>
      <span class="text-body-xs font-medium" :class="convStatusBadgeClass">{{ convStatusLabel }}</span>
      <!-- approval-flow-02:paused 逃生口——审批死局(LLM 缺失/异地冻结)可整会话取消 -->
      <button v-if="convStatus === 'paused'" data-testid="cancel-paused-btn" type="button" @click="cancelPaused"
        class="flex items-center gap-xs px-xs rounded text-body-xs text-on-surface-variant hover:text-error transition-colors relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        <span class="material-symbols-outlined text-sm">close</span>{{ t('workbench.chat.cancelPaused') }}
      </button>
    </div>
    <div v-if="errorBanner || netLost" class="shrink-0 flex items-center gap-sm text-body-sm text-error bg-error/5 border-b border-error/20 px-md py-xs">
      <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': netLost && !errorBanner }">{{ netLost && !errorBanner ? 'progress_activity' : 'error' }}</span> {{ errorBanner || t('workbench.chat.reconnecting') }}
    </div>

    <!-- Messages -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto" @scroll="onChatScroll">
        <!-- 项目背景(2026-08-29 项目记忆;2026-09-01 常驻+空态可写):AI 每轮携带的项目决策摘要。
             脱离 v-if/v-else 链挂在滚动区顶部——无对话的新项目也要有写入入口(spec §3)。 -->
        <details v-if="projectId" ref="projectRecapCard" data-testid="project-recap-card" class="mt-md bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer select-none px-md py-sm text-body-sm font-medium text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-primary/60">folder_special</span>
            <span class="flex-1">{{ t('workbench.chat.projectRecapTitle') }}</span>
            <!-- 人工纠偏(T5)/空态写入(2026-09-01):点击不折叠卡片 -->
            <span v-if="projectRecap && !recapEditing" class="flex items-center gap-xs" @click.stop>
              <button data-testid="recap-edit-btn" type="button" @click="startRecapEdit"
                class="text-body-xs text-on-surface-variant hover:text-primary flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">edit</span>{{ t('workbench.chat.recapEdit') }}
              </button>
              <button data-testid="recap-clear-btn" type="button" @click="clearRecap"
                class="text-body-xs text-on-surface-variant hover:text-error flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">delete</span>{{ t('workbench.chat.recapClear') }}
              </button>
            </span>
            <span v-else-if="!projectRecap && !recapEditing" class="flex items-center gap-xs" @click.stop>
              <button data-testid="recap-write-btn" type="button" @click="startRecapEdit"
                class="text-body-xs text-primary hover:text-primary flex items-center gap-xs px-xs rounded transition-colors">
                <span class="material-symbols-outlined text-sm">edit</span>{{ t('workbench.chat.recapWrite') }}
              </button>
            </span>
          </summary>
          <!-- 编辑态:textarea + 保存/取消 -->
          <div v-if="recapEditing" class="px-md pb-md flex flex-col gap-xs">
            <textarea v-model="recapDraft" rows="5"
              class="w-full text-body-sm text-on-surface bg-surface-container border border-outline-variant rounded-lg px-sm py-sm focus:outline-none focus:border-primary resize-y"></textarea>
            <div class="flex items-center gap-sm">
              <button data-testid="recap-save-btn" type="button" :disabled="recapSaving" @click="saveRecapEdit"
                class="px-md py-xs text-body-sm rounded-md bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-opacity">{{ t('workbench.chat.recapSave') }}</button>
              <button data-testid="recap-cancel-btn" type="button" :disabled="recapSaving" @click="cancelRecapEdit"
                class="px-md py-xs text-body-sm rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container transition-colors">{{ t('workbench.chat.recapCancel') }}</button>
            </div>
          </div>
          <!-- 空态:说明 + 可发现性(卡已默认展开,此文案兜底被手动折叠后的再展开场景) -->
          <div v-else-if="!projectRecap" data-testid="recap-empty" class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed">
            {{ t('workbench.chat.recapEmptyHint') }}
          </div>
          <div v-else class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{{ projectRecap }}</div>
        </details>
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

      <!-- 阅读列:消息/摘要限宽居中(宽屏下行长失控、左右失衡的根因),与输入列同宽对齐。
           msgColEl = 流式消息容器(startStick 粘底观测目标,frontend-chat-03) -->
      <div v-else ref="msgColEl" class="mx-auto w-full max-w-3xl px-md">
        <!-- Recap card: earlier conversation summary (collapsible, shown only when conv.recap exists) -->
        <details v-if="recap" class="mt-md bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer select-none px-md py-sm text-body-sm font-medium text-on-surface-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-base text-primary/60">summarize</span>
            {{ t('workbench.chat.recapSummary') }}
          </summary>
          <div class="px-md pb-md text-body-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap">{{ recap }}</div>
        </details>

        <!-- Conversation -->
        <!-- 渐进窗口哨兵:还有更早消息时可扩(spec §3) -->
        <button v-if="remainingCount > 0" data-testid="load-earlier-sentinel" type="button" :ref="observeSentinel" @click="loadEarlier"
          class="mx-auto my-sm px-md py-xs text-body-xs text-on-surface-variant border border-outline-variant rounded-full hover:bg-surface-container transition-colors">
          {{ t('workbench.chat.loadEarlier', { n: remainingCount }) }}
        </button>
        <div v-for="(turn, i) in renderedTurns" :key="turn._id">
          <ChatTurn :turn="turn"
            :show-regenerate="turn.role === 'assistant' && turns.length - renderedTurns.length + i === lastAssistantIndex && !sending && ['done', 'error'].includes(turn.status)"
            :show-edit="turn.role === 'user' && !sending && !editing && !!turn.messageId"
            @regenerate="regenerate"
            @edit="startEdit(turn)"
            @reopen-approval="() => { if (lastApproval && !pendingApproval) pendingApproval = lastApproval }" />
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
      <!-- 上下文余量条(常驻,spec §4.5):灰 <70% / 黄 ≥70%(=预算线,出压缩钮) / 红 ≥90%(超线裁剪中) -->
      <div v-if="ctxInfo" data-testid="context-meter" class="flex items-center gap-sm mb-sm group relative"
        :class="{ 'text-on-surface-variant': ctxLevel === 'gray', 'text-status-warning': ctxLevel === 'yellow', 'text-error': ctxLevel === 'red' }">
        <div class="flex-1 h-1 rounded-full bg-surface-container overflow-hidden">
          <div data-testid="context-meter-bar" class="h-full rounded-full transition-all"
            :class="ctxLevel === 'red' ? 'bg-error' : ctxLevel === 'yellow' ? 'bg-status-warning' : 'bg-on-surface-variant/40'"
            :style="{ width: ctxPct + '%' }"></div>
        </div>
        <span data-testid="context-meter-label" class="text-body-xs font-mono shrink-0">≈{{ Math.round(ctxInfo.estTokens / 1000) }}k / {{ Math.round(ctxInfo.windowTokens / 1000) }}k ({{ ctxPct }}%)</span>
        <button v-if="ctxPct >= 70" data-testid="context-compact-btn" @click="showCompact = true"
          :disabled="compactDisabled" :title="compactDisabled ? t('workbench.chat.context.compactBusy') : t('workbench.chat.context.compactTitle')"
          class="shrink-0 px-sm py-0.5 border border-outline-variant rounded-lg text-body-xs hover:bg-surface-container disabled:opacity-40 flex items-center gap-xs max-sm:min-h-[40px]">
          <span class="material-symbols-outlined text-sm">compress</span>{{ t('workbench.chat.context.compact') }}
        </button>
        <!-- 详情(hover/点击展开;简化为 title + 常驻明细行) -->
        <span class="text-body-xs text-on-surface-variant/60 hidden md:inline" :title="t('workbench.chat.context.detailHint')">
          {{ t('workbench.chat.context.recapUpTo', { n: ctxInfo.recapUpTo }) }}<template v-if="ctxInfo.willTrim"> · {{ t('workbench.chat.context.willTrim') }}</template>
        </span>
      </div>

      <!-- 编辑态提示条(spec §3.3):发送即删锚后 N 条;取消还原暂存草稿 -->
      <div v-if="editing" data-testid="edit-banner" class="flex items-center gap-sm mb-sm px-md py-xs bg-status-warning/10 border border-status-warning/30 rounded-lg">
        <span class="material-symbols-outlined text-base text-status-warning">edit</span>
        <span class="text-body-xs text-status-warning flex-1">{{ t('workbench.chat.editBanner', { n: editAfterCount }) }}</span>
        <button @click="cancelEdit" class="text-body-xs text-on-surface-variant hover:text-on-surface underline">{{ t('workbench.chat.editCancel') }}</button>
      </div>

      <!-- @-ref chips -->
      <div v-if="refs.length" class="flex flex-wrap gap-xs mb-sm">
        <div v-for="(r, i) in refs" :key="i" class="flex items-center gap-xs bg-primary/10 border border-primary/20 rounded-lg px-sm py-xs">
          <span class="material-symbols-outlined text-sm text-primary">{{ refIcon(r.kind) }}</span>
          <span class="text-body-xs font-mono font-semibold text-primary">{{ r.name }}</span>
          <span v-if="r.namespace" class="text-body-xs text-on-surface-variant">{{ r.namespace }}</span>
          <button @click="removeRef(i)" class="ml-xs text-on-surface-variant hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-sm">close</span></button>
        </div>
      </div>

      <!-- 运行中追加队列(2026-09-03):本轮回答结束后自动逐条发出,可单独移除 -->
      <div v-if="queued.length" data-testid="queue-panel" class="flex flex-col gap-xs mb-sm">
        <div v-for="q in queued" :key="q.id" class="flex items-center gap-sm bg-primary/5 border border-primary/20 rounded-lg px-sm py-xs">
          <span class="material-symbols-outlined text-sm text-primary shrink-0">hourglass_top</span>
          <span class="text-body-xs text-on-surface-variant flex-1 min-w-0 truncate">{{ q.content }}</span>
          <button @click="removeQueued(q.id)" :title="t('workbench.chat.queueRemove')" class="text-on-surface-variant hover:text-error shrink-0 relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-sm">close</span></button>
        </div>
        <p class="text-body-xs text-on-surface-variant/60">{{ t('workbench.chat.queueHint') }}</p>
      </div>

      <!-- Input + search dropdown -->
      <div class="relative">
        <div class="flex items-end gap-sm bg-surface-container-low border border-outline-variant rounded-2xl px-md py-sm focus-within:border-primary/40 transition-colors">
          <textarea ref="taEl" v-model="input" @keydown="onKeydown" @input="autoGrow" :disabled="!!pendingApproval || convStatus === 'paused'" rows="1" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-sm leading-relaxed max-h-32"></textarea>
          <!-- 运行中:发送键变停止键(输错→停止→修改重发);等待审批时不显示。
               手机 40px 触控高(2026-09-09 Wave5 B7):桌面保持 w-8 h-8,手机档 min 尺寸接管 -->
          <button v-if="sending && conversationId && !pendingApproval" @click="stopRun" :title="t('workbench.chat.stop')"
            class="shrink-0 w-8 h-8 flex items-center justify-center border border-error/40 text-error rounded-xl hover:bg-error/10 transition-colors max-sm:min-h-[40px] max-sm:min-w-[40px]">
            <span class="material-symbols-outlined text-base">stop</span>
          </button>
          <button v-else @click="send" :disabled="sending || !input.trim() || !!pendingApproval || convStatus === 'paused'" class="shrink-0 w-8 h-8 flex items-center justify-center bg-primary text-on-primary rounded-xl disabled:opacity-30 hover:opacity-90 transition-opacity max-sm:min-h-[40px] max-sm:min-w-[40px]">
            <span class="material-symbols-outlined text-base">send</span>
          </button>
        </div>

        <!-- composer 工具栏:审批模式切换器(左,2026-09-09;非 owner 视图隐藏)+ AI 配置透明面板入口(右,2026-08-25 恒可见——有对话时面板显示该对话烘焙的 system) -->
        <div class="flex items-center gap-sm mt-xs" :class="approvalModeMine ? 'justify-between' : 'justify-end'">
          <ApprovalModeSwitcher v-if="approvalModeMine" />
          <button @click="showAiConfig = true" :title="t('workbench.chat.aiConfig.open')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-sm">tune</span>{{ t('workbench.chat.aiConfig.open') }}
          </button>
        </div>

        <!-- 斜杠面板:行首 / 触发;动作禁用置灰不可选 -->
        <div v-if="slashOpen" data-testid="slash-panel" class="absolute bottom-full left-0 right-0 mb-xs bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl max-h-64 overflow-y-auto z-30">
          <div class="px-md py-xs text-body-xs text-on-surface-variant border-b border-outline-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-sm">bolt</span>{{ t('workbench.chat.slash.title') }}
          </div>
          <div v-if="!slashItems.length" class="px-md py-sm text-body-sm text-on-surface-variant">{{ t('workbench.chat.slash.noMatch') }}</div>
          <button v-for="(item, i) in slashItems" :key="item.id" type="button" data-testid="slash-item"
            :title="isSlashDisabled(item) ? t('workbench.chat.context.compactBusy') : undefined"
            :class="[i === slashActive ? 'bg-primary/10' : 'hover:bg-primary/5', isSlashDisabled(item) ? 'slash-item-disabled opacity-40 cursor-not-allowed' : '']"
            class="w-full flex items-start gap-sm text-left px-md py-sm transition-colors"
            @mousedown.prevent="() => { if (!isSlashDisabled(item)) { slashActive = i; selectSlashItem(item) } }">
            <span class="material-symbols-outlined text-base text-primary mt-0.5">{{ item.icon }}</span>
            <span class="min-w-0 flex-1">
              <span class="block text-body-sm font-semibold text-on-surface truncate">{{ t(item.nameKey) }}</span>
              <span class="block text-body-xs text-on-surface-variant truncate">{{ t(item.descKey) }}</span>
            </span>
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
                <span v-if="item.kind === 'server'" class="text-body-xs text-on-surface-variant">{{ item.description }}</span>
                <span v-else class="text-body-xs text-on-surface-variant">{{ item.namespace }}</span>
              </div>
              <span v-if="item.kind === 'server' && item.clusterRef" class="ml-auto text-body-xs font-mono text-on-surface-variant border border-outline-variant rounded px-xs">{{ item.clusterRef }}</span>
            </button>
          </template>
        </div>
      </div>
      </div>
    </div>

    <!-- Approval Modal:N1(2026-08-27 modal 审计)监听 update:model-value——此前 ESC/遮罩/X 的
         close emit 丢失,pendingApproval 不清 → modal 点不动,且 ESC 栈顶恒为她,悬浮 ChatModal
         内连锁锁死。收起 = 只收 modal(黄条可重开),决策仍走批准/拒绝。 -->
    <Modal :modelValue="!!pendingApproval" :title="approvalTitle" width="max-w-2xl" priority
      @update:model-value="v => { if (!v) pendingApproval = null }">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-status-warning">{{ approvalIcon }}</span>
          <span class="font-mono font-semibold text-body-sm">{{ pendingApproval.name }}</span>
        </div>
        <p v-if="pendingApproval.name === 'apply_project_manifests'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.applyManifestsDesc')"></p>
        <p v-else-if="pendingApproval.name === 'bootstrap_ledger'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.bootstrapLedgerDesc')"></p>
        <p v-else-if="pendingApproval.name === 'wb_exec'" class="text-body-sm text-on-surface-variant" v-html="t('workbench.chat.execDesc')"></p>
        <!-- wb_* 运维工具目标行(kind/name 或 pod),wb_exec 的 ns/pod/container 归入命令块上方的目标行;
             命令块/应答块/备注块自带目标行,此处排除防同屏双目标行 -->
        <p v-if="approvalTarget && !approvalCommand && !approvalJobText && pendingApproval.args?.notes == null" class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget }}</span></p>
        <!-- CSO #5:凡 args.command 存在(wb_exec/wb_ssh_exec)一律渲染 目标+命令+sudo,SSH root 命令不再盲批。
             approval-flow-01:command 数组归一 join(' ') 后渲染(argv 形态不再逗号粘连) -->
        <template v-if="approvalCommand">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget || '—' }}</span></p>
          <p v-if="pendingApproval.args?.sudo" class="text-body-sm font-semibold text-status-warning">{{ t('workbench.chat.sudoLabel') }}</p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ approvalCommand }}</pre>
        </template>
        <!-- approval-flow-01:wb_ssh_job_write 应答——server(+jobId 若在场)目标行 + 将写入 stdin 的文本;
             终审修复:jobId 段仅在场时渲染(LLM 违 schema 漏发 jobId 不再把整块应答展示挤没) -->
        <template v-if="approvalJobText">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget || '—' }}</span><template v-if="pendingApproval.args?.jobId != null"> · jobId: <span class="font-mono text-on-surface">{{ pendingApproval.args?.jobId }}</span></template></p>
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.approvalJobText') }}</p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ approvalJobText }}</pre>
        </template>
        <!-- approval-flow-01:write_server_notes 台账备注——scope 目标行 + notes 正文(整体覆盖) -->
        <template v-if="pendingApproval.args?.notes != null">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.targetLabel') }}: <span class="font-mono text-on-surface">{{ approvalTarget || '—' }}</span></p>
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.approvalNotes') }}</p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args.notes }}</pre>
        </template>
        <template v-if="pendingApproval.args?.path">
          <p class="text-body-sm text-on-surface-variant">Path: <span class="font-mono text-on-surface">{{ pendingApproval.args.path }}</span></p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args.content }}</pre>
        </template>
        <pre v-else-if="pendingApproval.args?.content" class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ pendingApproval.args.content }}</pre>
        <!-- approval-flow-01 兜底:无任何匹配分支的审批工具渲染完整 args JSON(截断)——盲批最后防线 -->
        <template v-if="approvalArgsFallback">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.approvalArgs') }}</p>
          <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest border border-outline-variant rounded-lg p-md">{{ approvalArgsFallback }}</pre>
        </template>
      </div>
      <template #actions>
        <button data-testid="approval-deny" @click="decideApproval(false)" :disabled="sending"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container max-sm:flex-1 max-sm:min-h-[44px] max-sm:text-body-md">{{ t('workbench.chat.reject') }}</button>
        <button data-testid="approval-approve" @click="decideApproval(true)" :disabled="sending"
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40 max-sm:flex-1 max-sm:min-h-[44px] max-sm:text-body-md">{{ t('workbench.chat.approve') }}</button>
      </template>
    </Modal>

    <!-- 上下文压缩 Modal(spec §4.4):全部历史(含旧摘要)重压为一份摘要,仅留最近 2 条全文 -->
    <Modal :modelValue="showCompact" :title="t('workbench.chat.context.compactTitle')"
      @update:model-value="v => showCompact = v">
      <div v-if="showCompact" data-testid="context-compact-modal" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ t('workbench.chat.context.compactDesc') }}</p>
        <textarea v-model="compactInstruction" rows="2" :placeholder="t('workbench.chat.context.compactInstruction')"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm resize-none outline-none focus:border-primary/40"></textarea>
      </div>
      <template #actions>
        <button @click="showCompact = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ t('common.cancel') }}</button>
        <button @click="doCompact" :disabled="compacting" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">{{ t('workbench.chat.context.compactGo') }}</button>
      </template>
    </Modal>
    <AiConfigPanel v-model="showAiConfig" :conversation-id="conversationId" />
  </section>
</template>
