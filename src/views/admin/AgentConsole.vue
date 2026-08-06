<script setup>
// AI 控制台(第二阶段切片 4 + 3b):聊天 + 工具调用 trace + 写操作人审。
// 聊天框 → POST /api/agent/chat { message, apiKeyId, history } →
//   status:'done' → 展示终答 + trace;
//   status:'pending_approval' → 弹审批 Modal,用户批准/拒绝后带 resume 回传续跑(状态在浏览器↔网关往返,服务端无会话)。
// agent 用调用者选的 API key(绑 SA + tier);写操作实际执行仍走底座 callTool 全链(RBAC 兜底)。
import { ref, computed, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'

const { t } = useI18n()
const keys = ref([])
const clusters = ref([])
const loadingKeys = ref(true)
const selectedKeyId = ref('')
// turn: { _id, role:'user'|'assistant', status:'thinking'|'pending_approval'|'done'|'error', content, trace:[], steps, denied, truncated, error }
const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
const scrollEl = ref(null)
const pendingApproval = ref(null)   // { turnId, toolCallId, name, args, runContext, queue, denied, steps }
let turnSeq = 0

const HINT_KEYS = [
  'admin.agent.hint1',
  'admin.agent.hint2',
  'admin.agent.hint3',
]

const activeKeys = computed(() => keys.value.filter(k => !k.revokedAt))
const selectedKey = computed(() => activeKeys.value.find(k => k.id === selectedKeyId.value) || null)
const clusterName = id => clusters.value.find(c => c.id === id)?.name || (id ? id.slice(0, 8) : '-')
const TIER_STYLE = { read: 'bg-status-running/10 text-status-running', operator: 'bg-status-warning/10 text-status-warning', admin: 'bg-error/10 text-error' }

async function loadKeys() {
  loadingKeys.value = true
  try {
    const [kr, cr] = await Promise.all([adminApi.apikeys.list(), adminApi.clusters.list()])
    keys.value = kr.apikeys || []
    clusters.value = cr.clusters || []
    const first = keys.value.find(k => !k.revokedAt)
    if (first) selectedKeyId.value = first.id
  } catch (e) {
    notify('error', e.message || t('admin.agent.loadKeysFailed'))
  } finally {
    loadingKeys.value = false
  }
}
onMounted(loadKeys)

function toolCount(trace) {
  return (trace || []).filter(e => e.type === 'tool' || e.type === 'denied').length
}
function fmtArgs(args) {
  try { const s = JSON.stringify(args); return s === '{}' ? '' : s } catch { return String(args) }
}
function fmtResult(v) {
  if (v == null) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

// 走 reactive proxy 改 turn(push 进 turns 的对象要经 find 返回的代理改才触发更新)
function updateTurn(id, patch) {
  const t = turns.value.find(x => x._id === id)
  if (t) Object.assign(t, patch)
}

async function scrollToBottom() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

// 历史只取已完成的 turn(待审/思考中的不喂回去)
function buildHistory() {
  return turns.value
    .filter(t => t.role === 'user' || (t.role === 'assistant' && t.status === 'done'))
    .map(t => ({ role: t.role, content: t.content }))
}

// 把一次 chat 响应(初始或 resume)应用到对应 assistant turn
function applyResponse(agentId, res) {
  const t = turns.value.find(x => x._id === agentId)
  if (t && Array.isArray(res.trace) && res.trace.length) t.trace.push(...res.trace)
  if (res.status === 'pending_approval') {
    updateTurn(agentId, { status: 'pending_approval', steps: res.steps ?? t.steps, denied: res.denied || [], truncated: false })
    pendingApproval.value = {
      turnId: agentId, toolCallId: res.pending.toolCallId, name: res.pending.name, args: res.pending.args,
      runContext: res.runContext, queue: res.queue, denied: res.denied, steps: res.steps,
    }
  } else { // done
    updateTurn(agentId, {
      status: 'done',
      content: res.content || t('admin.agent.noAnswer'),
      steps: res.steps ?? 0,
      denied: res.denied || [],
      truncated: !!res.truncated,
    })
  }
}

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg || sending.value) return
  if (!selectedKey.value) { errorBanner.value = t('admin.agent.selectKeyFirst'); return }
  const history = buildHistory()
  const userId = ++turnSeq, agentId = ++turnSeq
  turns.value.push({ _id: userId, role: 'user', content: msg })
  turns.value.push({ _id: agentId, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
  input.value = ''
  sending.value = true
  await scrollToBottom()
  try {
    const res = await adminApi.agent.chat({ message: msg, apiKeyId: selectedKey.value.id, history })
    applyResponse(agentId, res)
  } catch (e) {
    updateTurn(agentId, { status: 'error', error: e.message || t('admin.agent.callFailed') })
    if (e.status === 503) errorBanner.value = e.message
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

async function decideApproval(approved) {
  const pa = pendingApproval.value
  if (!pa || sending.value) return
  pendingApproval.value = null
  updateTurn(pa.turnId, { status: 'thinking' })
  sending.value = true
  await scrollToBottom()
  try {
    const res = await adminApi.agent.chat({
      apiKeyId: selectedKey.value.id,
      resume: { runContext: pa.runContext, queue: pa.queue, denied: pa.denied, steps: pa.steps, toolCallId: pa.toolCallId, approved },
    })
    applyResponse(pa.turnId, res)
  } catch (e) {
    updateTurn(pa.turnId, { status: 'error', error: e.message || t('admin.agent.resumeFailed') })
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}
function useHint(h) { input.value = t(h) }
function clearChat() { turns.value = []; pendingApproval.value = null; errorBanner.value = '' }
</script>

<template>
  <section class="animate-fade-in h-full flex flex-col gap-md min-h-0">
    <!-- Header + 控制条 -->
    <div class="shrink-0 flex flex-col gap-sm">
      <div class="flex items-start justify-between gap-md">
        <div>
          <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm">
            <span class="material-symbols-outlined">smart_toy</span> {{ $t('admin.agent.title') }}
            <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold bg-status-warning/10 text-status-warning">{{ $t('admin.agent.writeNeedsApproval') }}</span>
          </h2>
          <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('admin.agent.subtitle') }}</p>
        </div>
        <button v-if="turns.length" @click="clearChat" class="shrink-0 flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">
          <span class="material-symbols-outlined text-base">delete_sweep</span> {{ $t('admin.agent.clear') }}
        </button>
      </div>

      <!-- Key 选择条 -->
      <div class="flex flex-wrap items-center gap-md bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm">
        <span class="material-symbols-outlined text-on-surface-variant">vpn_key</span>
        <select v-model="selectedKeyId" :disabled="loadingKeys" class="bg-transparent text-body-sm font-medium outline-none min-w-[220px]">
          <option value="" disabled>{{ loadingKeys ? $t('common.loading') : $t('admin.agent.selectKey') }}</option>
          <option v-for="k in activeKeys" :key="k.id" :value="k.id">{{ k.prefix }}… · {{ k.tier }} · {{ clusterName(k.clusterId) }}</option>
        </select>
        <template v-if="selectedKey">
          <span class="text-body-xs text-on-surface-variant">SA:</span>
          <span class="font-mono text-body-xs text-on-surface-variant">{{ selectedKey.boundSA_namespace }}/{{ selectedKey.boundSA_name }}</span>
          <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="TIER_STYLE[selectedKey.tier]">{{ selectedKey.tier }}</span>
        </template>
        <span v-if="!activeKeys.length && !loadingKeys" class="text-body-xs text-status-warning">{{ $t('admin.agent.noKeysWarning') }}</span>
      </div>

      <div v-if="errorBanner" class="flex items-center gap-sm text-body-sm text-error bg-error/5 border border-error/20 rounded-lg px-md py-sm">
        <span class="material-symbols-outlined text-base">error</span> {{ errorBanner }}
      </div>
    </div>

    <!-- 对话区 -->
    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-md pr-xs">
      <!-- 空状态 -->
      <div v-if="!turns.length" class="flex-1 flex items-center justify-center">
        <div class="text-center max-w-md">
          <span class="material-symbols-outlined text-5xl text-on-surface-variant/40">forum</span>
          <p class="text-body-md text-on-surface-variant mt-md">{{ $t('admin.agent.emptyHint') }}</p>
          <div class="flex flex-col gap-xs mt-sm text-left">
            <button v-for="h in HINT_KEYS" :key="h" @click="useHint(h)" class="text-body-sm text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm hover:border-primary/50 hover:text-primary transition-colors">{{ $t(h) }}</button>
          </div>
        </div>
      </div>

      <!-- 每轮 -->
      <div v-for="t in turns" :key="t._id" class="flex" :class="t.role === 'user' ? 'justify-end' : 'justify-start'">
        <!-- user -->
        <div v-if="t.role === 'user'" class="max-w-[80%] bg-primary-container text-on-primary-container rounded-2xl rounded-br-sm px-md py-sm">
          <p class="text-body-sm whitespace-pre-wrap break-words">{{ t.content }}</p>
        </div>

        <!-- assistant -->
        <div v-else class="w-full max-w-[92%] flex flex-col gap-sm">
          <!-- 工具调用 trace(折叠;静态 open 避免与浏览器 toggle 打架) -->
          <details v-if="t.trace && t.trace.length" open class="bg-surface-container-low border border-outline-variant rounded-lg">
            <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant select-none flex items-center gap-xs">
              <span class="material-symbols-outlined text-base">account_tree</span> {{ $t('admin.agent.toolTrace', { n: toolCount(t.trace) }) }}
            </summary>
            <div class="px-md pb-md flex flex-col gap-sm">
              <div v-for="(ev, j) in t.trace" :key="j" class="text-body-xs">
                <div v-if="ev.type === 'assistant' && ev.message?.tool_calls?.length" class="flex items-center gap-xs text-on-surface-variant py-xs">
                  <span class="material-symbols-outlined text-sm">psychology</span>
                  <span>{{ $t('admin.agent.decideCall', { tools: ev.message.tool_calls.map(c => c.function?.name).filter(Boolean).join(', ') }) }}</span>
                </div>
                <div v-else-if="ev.type === 'tool'" class="border border-outline-variant rounded-lg overflow-hidden">
                  <div class="flex items-center gap-xs px-sm py-xs bg-surface-container">
                    <span class="material-symbols-outlined text-sm text-status-running">play_circle</span>
                    <span class="font-mono font-semibold">{{ ev.name }}</span>
                    <span v-if="fmtArgs(ev.args)" class="font-mono text-on-surface-variant truncate">{{ fmtArgs(ev.args) }}</span>
                  </div>
                  <pre v-if="fmtResult(ev.result)" class="px-sm py-xs max-h-48 overflow-y-auto font-mono text-code-sm bg-surface-container-lowest whitespace-pre-wrap break-all">{{ fmtResult(ev.result) }}</pre>
                </div>
                <div v-else-if="ev.type === 'denied'" class="flex items-center gap-xs px-sm py-xs bg-status-warning/10 text-status-warning rounded-lg">
                  <span class="material-symbols-outlined text-sm">block</span>
                  <span class="font-mono font-semibold">{{ ev.name }}</span>
                  <span>{{ $t('admin.agent.userDenied') }}</span>
                </div>
              </div>
            </div>
          </details>

          <!-- 状态体 -->
          <div v-if="t.status === 'thinking' && !(t.trace && t.trace.length)" class="flex items-center gap-sm text-body-sm text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined animate-spin text-base">progress_activity</span> {{ $t('admin.agent.thinking') }}
          </div>
          <div v-else-if="t.status === 'pending_approval'" class="flex items-center gap-xs text-body-sm text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined text-base">pending_actions</span> {{ $t('admin.agent.pendingApprovalHint') }}
          </div>
          <div v-else-if="t.status === 'error'" class="flex items-start gap-xs text-body-sm text-error bg-error/5 border border-error/20 rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined text-base mt-0.5">error</span>
            <span class="whitespace-pre-wrap break-words">{{ t.error }}</span>
          </div>
          <template v-else-if="t.status === 'done'">
            <div class="text-body-md text-on-surface whitespace-pre-wrap break-words bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">{{ t.content }}</div>
            <div class="flex flex-wrap items-center gap-md text-body-xs text-on-surface-variant px-xs">
              <span>{{ $t('admin.agent.stepsTaken', { n: t.steps }) }}</span>
              <span v-if="t.truncated" class="text-status-warning">{{ $t('admin.agent.truncated') }}</span>
              <span v-if="t.denied && t.denied.length" class="text-status-warning">{{ $t('admin.agent.writeOpsDenied', { n: t.denied.length }) }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="shrink-0 flex items-end gap-sm bg-surface-container-lowest border border-outline-variant rounded-xl p-sm">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="sending || !selectedKey || !!pendingApproval"
        rows="2"
        :placeholder="selectedKey ? $t('admin.agent.inputPlaceholder') : $t('admin.agent.selectKeyFirst')"
        class="flex-1 bg-transparent resize-none outline-none text-body-sm px-sm py-sm max-h-40"
      ></textarea>
      <button @click="send" :disabled="sending || !input.trim() || !selectedKey || !!pendingApproval" class="shrink-0 flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
        <span class="material-symbols-outlined text-base">send</span> {{ $t('admin.agent.send') }}
      </button>
    </div>

    <!-- 写操作审批 Modal(只能经按钮关闭;backdrop 点击被忽略) -->
    <Modal :modelValue="!!pendingApproval" :title="$t('admin.agent.approvalTitle')" width="max-w-lg">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <p class="text-body-sm text-on-surface-variant">{{ $t('admin.agent.approvalDesc') }}</p>
        <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md flex flex-col gap-xs">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-status-warning">build_circle</span>
            <span class="font-mono font-semibold text-body-md">{{ pendingApproval.name }}</span>
          </div>
          <template v-if="pendingApproval.name === 'scale'">
            <p class="text-body-sm">{{ $t('admin.agent.scaleDesc', { kind: pendingApproval.args.kind, name: pendingApproval.args.name, ns: pendingApproval.args.namespace }) }}</p>
            <p class="text-body-md">{{ $t('admin.agent.targetReplicas') }}<span class="font-bold text-status-warning text-headline-sm">{{ pendingApproval.args.replicas }}</span><span class="text-body-xs text-on-surface-variant ml-xs">{{ $t('admin.agent.replicasClamp') }}</span></p>
          </template>
          <template v-else-if="pendingApproval.name === 'restart'">
            <p class="text-body-sm">{{ $t('admin.agent.restartDesc', { kind: pendingApproval.args.kind, name: pendingApproval.args.name, ns: pendingApproval.args.namespace }) }}</p>
          </template>
          <template v-else>
            <pre class="font-mono text-code-sm whitespace-pre-wrap break-all">{{ fmtResult(pendingApproval.args) }}</pre>
          </template>
        </div>
      </div>
      <template #actions>
        <button @click="decideApproval(false)" :disabled="sending" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ $t('admin.agent.reject') }}</button>
        <button @click="decideApproval(true)" :disabled="sending" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">{{ $t('admin.agent.approve') }}</button>
      </template>
    </Modal>
  </section>
</template>
