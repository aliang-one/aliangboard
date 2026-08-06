<script setup>
// 项目 AI 助手(W4b-step3):工作台项目的 agent 聊天。workbench-only(无 API key)。
// → POST /api/agent/chat { projectId, message, resume? } → done(终答+trace)/ pending_approval(write_project_file 人审)。
// 历史走服务端(workbench_history),客户端不传 history。审批 modal 展 path+content。
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { workbenchApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id
const projectName = ref('')
const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
const scrollEl = ref(null)
const pendingApproval = ref(null)
let turnSeq = 0

const HINTS = [
  '读集群台账,总结这个集群已具备的能力',
  '帮我写一个 ns=app 的 ConfigMap 到 manifests/app-config.yaml',
  '看一下现有 manifests/ 下有什么文件',
]

function toolCount(trace) { return (trace || []).filter(e => e.type === 'tool' || e.type === 'denied').length }
function fmtResult(v) { if (v == null) return ''; return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }

function updateTurn(tid, patch) { const t = turns.value.find(x => x._id === tid); if (t) Object.assign(t, patch) }
async function scrollToBottom() { await nextTick(); if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight }

function applyResponse(agentId, res) {
  const t = turns.value.find(x => x._id === agentId)
  if (t && Array.isArray(res.trace) && res.trace.length) t.trace.push(...res.trace)
  if (res.status === 'pending_approval') {
    updateTurn(agentId, { status: 'pending_approval', steps: res.steps ?? t.steps, denied: res.denied || [], truncated: false })
    pendingApproval.value = { turnId: agentId, toolCallId: res.pending.toolCallId, name: res.pending.name, args: res.pending.args, runContext: res.runContext, queue: res.queue, denied: res.denied, steps: res.steps }
  } else {
    updateTurn(agentId, { status: 'done', content: res.content || '(无回答)', steps: res.steps ?? 0, denied: res.denied || [], truncated: !!res.truncated })
  }
}

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg || sending.value) return
  const userId = ++turnSeq
  const agentId = ++turnSeq
  turns.value.push({ _id: userId, role: 'user', content: msg })
  turns.value.push({ _id: agentId, role: 'assistant', status: 'thinking', content: '', trace: [], steps: 0, denied: [], truncated: false, error: '' })
  input.value = ''
  sending.value = true
  await scrollToBottom()
  try {
    const res = await workbenchApi.chat({ projectId: id, message: msg })
    applyResponse(agentId, res)
  } catch (e) {
    updateTurn(agentId, { status: 'error', error: e.message || 'agent 失败' })
    if (e.status === 503) errorBanner.value = e.message
  } finally { sending.value = false; await scrollToBottom() }
}

async function decideApproval(approved) {
  const pa = pendingApproval.value
  if (!pa || sending.value) return
  pendingApproval.value = null
  updateTurn(pa.turnId, { status: 'thinking' })
  sending.value = true
  await scrollToBottom()
  try {
    const res = await workbenchApi.chat({ projectId: id, resume: { runContext: pa.runContext, queue: pa.queue, denied: pa.denied, steps: pa.steps, toolCallId: pa.toolCallId, approved } })
    applyResponse(pa.turnId, res)
  } catch (e) { updateTurn(pa.turnId, { status: 'error', error: e.message || 'resume 失败' }) }
  finally { sending.value = false; await scrollToBottom() }
}

function onKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
function useHint(h) { input.value = h }
function clearChat() { turns.value = []; pendingApproval.value = null; errorBanner.value = '' }

onMounted(async () => {
  try { const r = await workbenchApi.getProject(id); projectName.value = r.project?.name || '项目' }
  catch (e) { errorBanner.value = e.message || '加载项目失败' }
})
</script>

<template>
  <section class="animate-fade-in h-full flex flex-col gap-md min-h-0">
    <div class="shrink-0 flex items-center gap-sm">
      <button @click="router.push({ name: 'WorkbenchProject', params: { id } })" class="p-1 rounded hover:bg-surface-container text-on-surface-variant"><span class="material-symbols-outlined">arrow_back</span></button>
      <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-xs"><span class="material-symbols-outlined">smart_toy</span>{{ projectName }}</h2>
      <span class="text-body-sm text-on-surface-variant">· AI 助手</span>
      <button v-if="turns.length" @click="clearChat" class="ml-auto flex items-center gap-xs px-md py-xs border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container"><span class="material-symbols-outlined text-sm">delete_sweep</span>清空</button>
    </div>
    <p class="shrink-0 text-body-sm text-on-surface-variant -mt-sm">先 read_ledger 复用集群能力,再 read/write 项目 manifests。写文件需你审批(原样批准);apply 到集群是 W5。</p>

    <div v-if="errorBanner" class="shrink-0 flex items-center gap-sm text-body-sm text-error bg-error/5 border border-error/20 rounded-lg px-md py-sm"><span class="material-symbols-outlined text-base">error</span> {{ errorBanner }}</div>

    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-md pr-xs">
      <div v-if="!turns.length" class="flex-1 flex items-center justify-center">
        <div class="text-center max-w-md">
          <span class="material-symbols-outlined text-5xl text-on-surface-variant/40">smart_toy</span>
          <p class="text-body-md text-on-surface-variant mt-md">告诉助手要做什么,或试试:</p>
          <div class="flex flex-col gap-xs mt-sm text-left">
            <button v-for="h in HINTS" :key="h" @click="useHint(h)" class="text-body-sm text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm hover:border-primary/50 hover:text-primary transition-colors">{{ h }}</button>
          </div>
        </div>
      </div>

      <div v-for="t in turns" :key="t._id" class="flex" :class="t.role === 'user' ? 'justify-end' : 'justify-start'">
        <div v-if="t.role === 'user'" class="max-w-[80%] bg-primary-container text-on-primary-container rounded-2xl rounded-br-sm px-md py-sm">
          <p class="text-body-sm whitespace-pre-wrap break-words">{{ t.content }}</p>
        </div>
        <div v-else class="w-full max-w-[92%] flex flex-col gap-sm">
          <details v-if="t.trace && t.trace.length" open class="bg-surface-container-low border border-outline-variant rounded-lg">
            <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant select-none flex items-center gap-xs">
              <span class="material-symbols-outlined text-base">account_tree</span> 工具调用 trace · {{ toolCount(t.trace) }} 步
            </summary>
            <div class="px-md pb-md flex flex-col gap-sm">
              <div v-for="(ev, j) in t.trace" :key="j" class="text-body-xs">
                <div v-if="ev.type === 'assistant' && ev.message?.tool_calls?.length" class="flex items-center gap-xs text-on-surface-variant py-xs">
                  <span class="material-symbols-outlined text-sm">psychology</span>
                  <span>决定调用:{{ ev.message.tool_calls.map(c => c.function?.name).filter(Boolean).join(', ') }}</span>
                </div>
                <div v-else-if="ev.type === 'tool'" class="border border-outline-variant rounded-lg overflow-hidden">
                  <div class="flex items-center gap-xs px-sm py-xs bg-surface-container">
                    <span class="material-symbols-outlined text-sm text-status-running">play_circle</span>
                    <span class="font-mono font-semibold">{{ ev.name }}</span>
                  </div>
                  <pre v-if="fmtResult(ev.result)" class="px-sm py-xs max-h-40 overflow-y-auto font-mono text-body-xs bg-surface-container-lowest whitespace-pre-wrap break-all">{{ fmtResult(ev.result) }}</pre>
                </div>
                <div v-else-if="ev.type === 'denied'" class="flex items-center gap-xs px-sm py-xs bg-status-warning/10 text-status-warning rounded-lg">
                  <span class="material-symbols-outlined text-sm">block</span><span class="font-mono font-semibold">{{ ev.name }}</span><span>用户拒绝执行</span>
                </div>
              </div>
            </div>
          </details>

          <div v-if="t.status === 'thinking' && !(t.trace && t.trace.length)" class="flex items-center gap-sm text-body-sm text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined animate-spin text-base">progress_activity</span> 思考中…
          </div>
          <div v-else-if="t.status === 'pending_approval'" class="flex items-center gap-xs text-body-sm text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined text-base">pending_actions</span> agent 想写文件,请在弹窗审批
          </div>
          <div v-else-if="t.status === 'error'" class="flex items-start gap-xs text-body-sm text-error bg-error/5 border border-error/20 rounded-2xl rounded-tl-sm px-md py-sm">
            <span class="material-symbols-outlined text-base mt-0.5">error</span><span class="whitespace-pre-wrap break-words">{{ t.error }}</span>
          </div>
          <template v-else-if="t.status === 'done'">
            <div class="text-body-md text-on-surface whitespace-pre-wrap break-words bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">{{ t.content }}</div>
            <div class="flex items-center gap-md text-body-xs text-on-surface-variant px-xs"><span>耗时 {{ t.steps }} 步</span><span v-if="t.truncated" class="text-status-warning">⚠ 达到最大步数</span></div>
          </template>
        </div>
      </div>
    </div>

    <div class="shrink-0 flex items-end gap-sm bg-surface-container-lowest border border-outline-variant rounded-xl p-sm">
      <textarea v-model="input" @keydown="onKeydown" :disabled="sending || !!pendingApproval" rows="2" placeholder="告诉助手做什么…(Enter 发送)" class="flex-1 bg-transparent resize-none outline-none text-body-sm px-sm py-sm max-h-40"></textarea>
      <button @click="send" :disabled="sending || !input.trim() || !!pendingApproval" class="shrink-0 flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40"><span class="material-symbols-outlined text-base">send</span> 发送</button>
    </div>

    <!-- 写文件审批 Modal -->
    <Modal :modelValue="!!pendingApproval" title="写文件审批" width="max-w-2xl">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md flex flex-col gap-xs">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-status-warning">{{ pendingApproval.name === 'apply_project_manifests' ? 'rocket_launch' : 'edit_document' }}</span>
            <span class="font-mono font-semibold">{{ pendingApproval.name }}</span>
          </div>
          <p v-if="pendingApproval.name === 'apply_project_manifests'" class="text-body-sm">把项目 <span class="font-mono">manifests/</span> 下所有 yaml server-side apply 到绑定集群(逐资源,部分失败会上报)。apply 走平台 apply 路径(审计),不走 API key。</p>
          <template v-else-if="pendingApproval.args.path">
            <p class="text-body-sm">路径:<span class="font-mono">{{ pendingApproval.args.path }}</span></p>
            <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest rounded p-sm">{{ pendingApproval.args.content }}</pre>
          </template>
          <pre v-else class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest rounded p-sm">{{ pendingApproval.args.content }}</pre>
        </div>
      </div>
      <template #actions>
        <button @click="decideApproval(false)" :disabled="sending" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">拒绝</button>
        <button @click="decideApproval(true)" :disabled="sending" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">批准</button>
      </template>
    </Modal>
  </section>
</template>
