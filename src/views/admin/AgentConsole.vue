<script setup>
// AI 控制台(第二阶段切片 4):让 agent 用户可见。
// 聊天框 → POST /api/agent/chat { message, apiKeyId, history } → 展示终答 + 工具调用 trace。
// MVP 只读:agent 用调用者选的 API key(绑 SA + tier),写操作(scale/restart)恒拒(切片 3b 接人审)。
// admin only:复用 adminApi.apikeys.list 选 key(key 列表是 admin 操作)。
import { ref, computed, onMounted, nextTick } from 'vue'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const keys = ref([])
const clusters = ref([])
const loadingKeys = ref(true)
const selectedKeyId = ref('')
const turns = ref([])        // [{ _id, role, content, trace?, steps?, denied?, truncated?, error? }]
const input = ref('')
const sending = ref(false)
const errorBanner = ref('')  // 持久错误(如 LLM 未配置)
const scrollEl = ref(null)
let turnSeq = 0

const HINTS = [
  'default 命名空间有哪些 pod?挑出非 Running 的',
  'kube-system 最近有什么 Warning 事件?',
  '看一下 nginx deployment 的配置和最近日志',
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
    notify('error', e.message || '加载 API keys 失败')
  } finally {
    loadingKeys.value = false
  }
}
onMounted(loadKeys)

// trace 里算"执行/被拒"的工具步数(忽略纯 assistant 决策帧)
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

async function scrollToBottom() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}

async function send() {
  const msg = input.value.trim()
  errorBanner.value = ''
  if (!msg || sending.value) return
  if (!selectedKey.value) { errorBanner.value = '请先选择一个 API key'; return }
  // history 不含本轮 user(端点内部拼)
  const history = turns.value.map(t => ({ role: t.role, content: t.content }))
  turns.value.push({ _id: ++turnSeq, role: 'user', content: msg })
  input.value = ''
  sending.value = true
  await scrollToBottom()
  try {
    const res = await adminApi.agent.chat({ message: msg, apiKeyId: selectedKey.value.id, history })
    turns.value.push({
      _id: ++turnSeq,
      role: 'assistant',
      content: res.content || '(无回答)',
      trace: Array.isArray(res.trace) ? res.trace : [],
      steps: res.steps,
      denied: res.denied || [],
      truncated: !!res.truncated,
    })
  } catch (e) {
    turns.value.push({ _id: ++turnSeq, role: 'assistant', content: '', error: e.message || 'agent 调用失败' })
    if (e.status === 503) errorBanner.value = e.message // LLM 未配置 → 持久提示
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}
function useHint(h) { input.value = h }
function clearChat() { turns.value = []; errorBanner.value = '' }
</script>

<template>
  <section class="animate-fade-in h-full flex flex-col gap-md min-h-0">
    <!-- Header + 控制条 -->
    <div class="shrink-0 flex flex-col gap-sm">
      <div class="flex items-start justify-between gap-md">
        <div>
          <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-sm">
            <span class="material-symbols-outlined">smart_toy</span> AI 控制台
            <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold bg-status-running/10 text-status-running">只读</span>
          </h2>
          <p class="text-body-sm text-on-surface-variant mt-xs">集群 debug 助手:选 API key,描述问题,agent 调只读工具诊断。写操作(scale/restart)需人审(切片 3b 待接)。</p>
        </div>
        <button v-if="turns.length" @click="clearChat" class="shrink-0 flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">
          <span class="material-symbols-outlined text-base">delete_sweep</span> 清空
        </button>
      </div>

      <!-- Key 选择条 -->
      <div class="flex flex-wrap items-center gap-md bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm">
        <span class="material-symbols-outlined text-on-surface-variant">vpn_key</span>
        <select v-model="selectedKeyId" :disabled="loadingKeys" class="bg-transparent text-body-sm font-medium outline-none min-w-[220px]">
          <option value="" disabled>{{ loadingKeys ? '加载中…' : '选择 API key' }}</option>
          <option v-for="k in activeKeys" :key="k.id" :value="k.id">{{ k.prefix }}… · {{ k.tier }} · {{ clusterName(k.clusterId) }}</option>
        </select>
        <template v-if="selectedKey">
          <span class="text-body-xs text-on-surface-variant">SA:</span>
          <span class="font-mono text-body-xs text-on-surface-variant">{{ selectedKey.boundSA_namespace }}/{{ selectedKey.boundSA_name }}</span>
          <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="TIER_STYLE[selectedKey.tier]">{{ selectedKey.tier }}</span>
        </template>
        <span v-if="!activeKeys.length && !loadingKeys" class="text-body-xs text-status-warning">没有可用 API key,请先到「API Keys」签发一把(绑 SA、定 tier)。</span>
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
          <p class="text-body-md text-on-surface-variant mt-md">描述要排查的问题,或试试:</p>
          <div class="flex flex-col gap-xs mt-sm text-left">
            <button v-for="h in HINTS" :key="h" @click="useHint(h)" class="text-body-sm text-on-surface-variant bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm hover:border-primary/50 hover:text-primary transition-colors">{{ h }}</button>
          </div>
        </div>
      </div>

      <!-- 每轮 -->
      <div v-for="t in turns" :key="t._id" class="flex" :class="t.role === 'user' ? 'justify-end' : 'justify-start'">
        <div :class="t.role === 'user' ? 'max-w-[80%] bg-primary-container text-on-primary-container rounded-2xl rounded-br-sm px-md py-sm' : 'w-full max-w-[92%]'">
          <!-- user -->
          <p v-if="t.role === 'user'" class="text-body-sm whitespace-pre-wrap break-words">{{ t.content }}</p>

          <!-- assistant -->
          <div v-else class="flex flex-col gap-sm">
            <!-- 工具调用 trace(折叠;静态 open 避免与浏览器 toggle 打架) -->
            <details v-if="t.trace && t.trace.length" open class="bg-surface-container-low border border-outline-variant rounded-lg">
              <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant select-none flex items-center gap-xs">
                <span class="material-symbols-outlined text-base">account_tree</span> 工具调用 trace · {{ toolCount(t.trace) }} 步
              </summary>
              <div class="px-md pb-md flex flex-col gap-sm">
                <div v-for="(ev, j) in t.trace" :key="j" class="text-body-xs">
                  <!-- LLM 决策 -->
                  <div v-if="ev.type === 'assistant' && ev.message?.tool_calls?.length" class="flex items-center gap-xs text-on-surface-variant py-xs">
                    <span class="material-symbols-outlined text-sm">psychology</span>
                    <span>决定调用:{{ ev.message.tool_calls.map(c => c.function?.name).filter(Boolean).join(', ') }}</span>
                  </div>
                  <!-- 工具执行 -->
                  <div v-else-if="ev.type === 'tool'" class="border border-outline-variant rounded-lg overflow-hidden">
                    <div class="flex items-center gap-xs px-sm py-xs bg-surface-container">
                      <span class="material-symbols-outlined text-sm text-status-running">play_circle</span>
                      <span class="font-mono font-semibold">{{ ev.name }}</span>
                      <span v-if="fmtArgs(ev.args)" class="font-mono text-on-surface-variant truncate">{{ fmtArgs(ev.args) }}</span>
                    </div>
                    <pre v-if="fmtResult(ev.result)" class="px-sm py-xs max-h-48 overflow-y-auto font-mono text-code-sm bg-surface-container-lowest whitespace-pre-wrap break-all">{{ fmtResult(ev.result) }}</pre>
                  </div>
                  <!-- 写操作被拒 -->
                  <div v-else-if="ev.type === 'denied'" class="flex items-center gap-xs px-sm py-xs bg-status-warning/10 text-status-warning rounded-lg">
                    <span class="material-symbols-outlined text-sm">block</span>
                    <span class="font-mono font-semibold">{{ ev.name }}</span>
                    <span>需人审 · 已拒绝(MVP 不可执行写操作)</span>
                  </div>
                </div>
              </div>
            </details>

            <!-- 终答 / 错误 -->
            <div v-if="t.error" class="flex items-start gap-xs text-body-sm text-error bg-error/5 border border-error/20 rounded-2xl rounded-tl-sm px-md py-sm">
              <span class="material-symbols-outlined text-base mt-0.5">error</span>
              <span class="whitespace-pre-wrap break-words">{{ t.error }}</span>
            </div>
            <div v-else class="text-body-md text-on-surface whitespace-pre-wrap break-words bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">{{ t.content }}</div>

            <!-- meta -->
            <div v-if="!t.error" class="flex flex-wrap items-center gap-md text-body-xs text-on-surface-variant px-xs">
              <span v-if="t.steps">耗时 {{ t.steps }} 步</span>
              <span v-if="t.truncated" class="text-status-warning">⚠ 达到最大步数,未给出完整答案</span>
              <span v-if="t.denied && t.denied.length" class="text-status-warning">⛔ {{ t.denied.length }} 个写操作被拒</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 思考中占位 -->
      <div v-if="sending" class="flex justify-start">
        <div class="flex items-center gap-sm text-body-sm text-on-surface-variant bg-surface-container-lowest border border-outline-variant rounded-2xl rounded-tl-sm px-md py-sm">
          <span class="material-symbols-outlined animate-spin text-base">progress_activity</span> 思考中…
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="shrink-0 flex items-end gap-sm bg-surface-container-lowest border border-outline-variant rounded-xl p-sm">
      <textarea
        v-model="input"
        @keydown="onKeydown"
        :disabled="sending || !selectedKey"
        rows="2"
        :placeholder="selectedKey ? '描述要排查的问题…(Enter 发送,Shift+Enter 换行)' : '请先选择 API key'"
        class="flex-1 bg-transparent resize-none outline-none text-body-sm px-sm py-sm max-h-40"
      ></textarea>
      <button @click="send" :disabled="sending || !input.trim() || !selectedKey" class="shrink-0 flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
        <span class="material-symbols-outlined text-base">send</span> 发送
      </button>
    </div>
  </section>
</template>
