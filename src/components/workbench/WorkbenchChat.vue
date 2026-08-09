<script setup>
// 可复用 AI 聊天组件(从 WorkbenchProjectChat 提取):工作台项目的 agent 聊天。
// props: projectId / projectName。无路由依赖,适合侧栏嵌入。
// → POST /api/agent/chat { projectId, message, resume? } → done(终答+trace)/ pending_approval(write_project_file 人审)。
// 历史走服务端(workbench_history),客户端不传 history。审批 modal 展 path+content。
import { ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { workbenchApi } from '@/api/client'
import Modal from '@/components/common/Modal.vue'

const props = defineProps({
  projectId: String,
  projectName: String,
})

const { t } = useI18n()
const turns = ref([])
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')
const scrollEl = ref(null)
const pendingApproval = ref(null)
let turnSeq = 0

const HINTS = computed(() => [
  t('workbench.chat.hintReadLedger'),
  t('workbench.chat.hintWriteConfig'),
  t('workbench.chat.hintListFiles'),
])

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
    updateTurn(agentId, { status: 'done', content: res.content || t('workbench.chat.noAnswer'), steps: res.steps ?? 0, denied: res.denied || [], truncated: !!res.truncated })
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
    const res = await workbenchApi.chat({ projectId: props.projectId, message: msg })
    applyResponse(agentId, res)
  } catch (e) {
    updateTurn(agentId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') })
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
    const res = await workbenchApi.chat({ projectId: props.projectId, resume: { runContext: pa.runContext, queue: pa.queue, denied: pa.denied, steps: pa.steps, toolCallId: pa.toolCallId, approved } })
    applyResponse(pa.turnId, res)
  } catch (e) { updateTurn(pa.turnId, { status: 'error', error: e.message || t('workbench.chat.agentFailed') }) }
  finally { sending.value = false; await scrollToBottom() }
}

function onKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
function useHint(h) { input.value = h }
function clearChat() { turns.value = []; pendingApproval.value = null; errorBanner.value = '' }
</script>

<template>
  <section class="h-full flex flex-col gap-sm min-h-0">
    <div class="shrink-0 flex items-center gap-xs">
      <span class="material-symbols-outlined text-base text-on-surface-variant">smart_toy</span>
      <span class="text-body-sm font-semibold text-on-surface truncate">{{ props.projectName || t('workbench.chat.title') }}</span>
      <button v-if="turns.length" @click="clearChat" class="ml-auto flex items-center gap-xs px-xs py-xs border border-outline-variant rounded-lg text-body-xs text-on-surface-variant hover:bg-surface-container"><span class="material-symbols-outlined text-sm">delete_sweep</span></button>
    </div>

    <div v-if="errorBanner" class="shrink-0 flex items-center gap-xs text-body-xs text-error bg-error/5 border border-error/20 rounded-lg px-sm py-xs"><span class="material-symbols-outlined text-sm">error</span> {{ errorBanner }}</div>

    <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-sm pr-xs">
      <div v-if="!turns.length" class="flex-1 flex items-center justify-center">
        <div class="text-center w-full px-sm">
          <span class="material-symbols-outlined text-3xl text-on-surface-variant/40">smart_toy</span>
          <p class="text-body-xs text-on-surface-variant mt-sm">{{ t('workbench.chat.hint') }}</p>
          <div class="flex flex-col gap-xs mt-sm text-left">
            <button v-for="h in HINTS" :key="h" @click="useHint(h)" class="text-body-xs text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-lg px-sm py-xs hover:border-primary/50 hover:text-primary transition-colors">{{ h }}</button>
          </div>
        </div>
      </div>

      <div v-for="t in turns" :key="t._id" class="flex" :class="t.role === 'user' ? 'justify-end' : 'justify-start'">
        <div v-if="t.role === 'user'" class="max-w-[85%] bg-primary-container text-on-primary-container rounded-2xl rounded-br-sm px-sm py-xs">
          <p class="text-body-xs whitespace-pre-wrap break-words">{{ t.content }}</p>
        </div>
        <div v-else class="w-full flex flex-col gap-xs">
          <details v-if="t.trace && t.trace.length" class="bg-surface-container-low border border-outline-variant rounded-lg">
            <summary class="cursor-pointer px-sm py-xs text-body-xs text-on-surface-variant select-none flex items-center gap-xs">
              <span class="material-symbols-outlined text-sm">account_tree</span> {{ t('workbench.chat.toolTrace', { n: toolCount(t.trace) }) }}
            </summary>
            <div class="px-sm pb-sm flex flex-col gap-xs">
              <div v-for="(ev, j) in t.trace" :key="j" class="text-body-xs">
                <div v-if="ev.type === 'assistant' && ev.message?.tool_calls?.length" class="flex items-center gap-xs text-on-surface-variant py-xs">
                  <span class="material-symbols-outlined text-sm">psychology</span>
                  <span>{{ t('workbench.chat.decideCalling') }}{{ ev.message.tool_calls.map(c => c.function?.name).filter(Boolean).join(', ') }}</span>
                </div>
                <div v-else-if="ev.type === 'tool'" class="border border-outline-variant rounded-lg overflow-hidden">
                  <div class="flex items-center gap-xs px-xs py-xs bg-surface-container">
                    <span class="material-symbols-outlined text-sm text-status-running">play_circle</span>
                    <span class="font-mono font-semibold">{{ ev.name }}</span>
                  </div>
                  <pre v-if="fmtResult(ev.result)" class="px-xs py-xs max-h-32 overflow-y-auto font-mono text-body-xs bg-surface-container-lowest whitespace-pre-wrap break-all">{{ fmtResult(ev.result) }}</pre>
                </div>
                <div v-else-if="ev.type === 'denied'" class="flex items-center gap-xs px-xs py-xs bg-status-warning/10 text-status-warning rounded-lg">
                  <span class="material-symbols-outlined text-sm">block</span><span class="font-mono font-semibold">{{ ev.name }}</span><span>{{ t('workbench.chat.reject') }}</span>
                </div>
              </div>
            </div>
          </details>

          <div v-if="t.status === 'thinking' && !(t.trace && t.trace.length)" class="flex items-center gap-xs text-body-xs text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-sm py-xs">
            <span class="material-symbols-outlined animate-spin text-sm">progress_activity</span> {{ t('workbench.chat.thinking') }}
          </div>
          <div v-else-if="t.status === 'pending_approval'" class="flex items-center gap-xs text-body-xs text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-2xl rounded-tl-sm px-sm py-xs">
            <span class="material-symbols-outlined text-sm">pending_actions</span> {{ t('workbench.chat.pendingApproval') }}
          </div>
          <div v-else-if="t.status === 'error'" class="flex items-start gap-xs text-body-xs text-error bg-error/5 border border-error/20 rounded-2xl rounded-tl-sm px-sm py-xs">
            <span class="material-symbols-outlined text-sm mt-0.5">error</span><span class="whitespace-pre-wrap break-words">{{ t.error }}</span>
          </div>
          <template v-else-if="t.status === 'done'">
            <div class="text-body-sm text-on-surface whitespace-pre-wrap break-words bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-sm py-xs">{{ t.content || t('workbench.chat.noAnswer') }}</div>
            <div class="flex items-center gap-sm text-body-xs text-on-surface-variant px-xs"><span>{{ t('workbench.chat.stepsTaken', { n: t.steps }) }}</span><span v-if="t.truncated" class="text-status-warning">{{ t('workbench.chat.maxStepsWarning') }}</span></div>
          </template>
        </div>
      </div>
    </div>

    <div class="shrink-0 flex items-end gap-xs bg-surface-container-lowest border border-outline-variant rounded-xl p-xs">
      <textarea v-model="input" @keydown="onKeydown" :disabled="sending || !!pendingApproval" rows="2" :placeholder="t('workbench.chat.userMessage')" class="flex-1 bg-transparent resize-none outline-none text-body-xs px-sm py-xs max-h-32"></textarea>
      <button @click="send" :disabled="sending || !input.trim() || !!pendingApproval" class="shrink-0 flex items-center gap-xs px-sm py-xs bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40"><span class="material-symbols-outlined text-sm">send</span> {{ t('workbench.chat.send') }}</button>
    </div>

    <!-- 写文件审批 Modal -->
    <Modal :modelValue="!!pendingApproval" :title="t('workbench.chat.writeFileApproval')" width="max-w-2xl">
      <div v-if="pendingApproval" class="flex flex-col gap-md">
        <div class="bg-surface-container-low border border-outline-variant rounded-lg p-md flex flex-col gap-xs">
          <div class="flex items-center gap-sm">
            <span class="material-symbols-outlined text-status-warning">{{ pendingApproval.name === 'apply_project_manifests' ? 'rocket_launch' : 'edit_document' }}</span>
            <span class="font-mono font-semibold">{{ pendingApproval.name }}</span>
          </div>
          <p v-if="pendingApproval.name === 'apply_project_manifests'" class="text-body-sm" v-html="t('workbench.chat.applyManifestsDesc')"></p>
          <p v-else-if="pendingApproval.name === 'bootstrap_ledger'" class="text-body-sm" v-html="t('workbench.chat.bootstrapLedgerDesc')"></p>
          <template v-else-if="pendingApproval.args.path">
            <p class="text-body-sm">{{ t('workbench.chat.path') }}<span class="font-mono">{{ pendingApproval.args.path }}</span></p>
            <pre class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest rounded p-sm">{{ pendingApproval.args.content }}</pre>
          </template>
          <pre v-else class="font-mono text-body-xs whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-surface-container-lowest rounded p-sm">{{ pendingApproval.args.content }}</pre>
        </div>
      </div>
      <template #actions>
        <button @click="decideApproval(false)" :disabled="sending" class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ t('workbench.chat.reject') }}</button>
        <button @click="decideApproval(true)" :disabled="sending" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40">{{ t('workbench.chat.approve') }}</button>
      </template>
    </Modal>
  </section>
</template>
