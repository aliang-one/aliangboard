<script setup>
// 工作台项目详情:Agent / Edit 双模式。
// Agent: 左对话列表 + 右全宽 chat(Cursor 风格)。Edit: 文件树 + 编辑器 + commit。
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { workbenchApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useI18n } from 'vue-i18n'
import YamlEditor from '@/components/common/YamlEditor.vue'
import WorkbenchChat from '@/components/workbench/WorkbenchChat.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const id = route.params.id
const project = ref(null)
const files = ref([])
const commits = ref([])
const loading = ref(true)
const currentPath = ref('')
const currentContent = ref('')
const dirty = ref(false)
const commitMsg = ref('')
const newFile = ref('')
const saving = ref(false)
const lastReconcile = ref(null)
const reconciling = ref(false)

// Mode: agent | edit (persisted)
const mode = ref(localStorage.getItem('aliangboard.workbench.mode') || 'agent')
function setMode(m) { mode.value = m; localStorage.setItem('aliangboard.workbench.mode', m) }

// Agent mode: conversation list
const conversations = ref([])
const activeConversationId = ref(null)
const convStatusStyle = {
  running: 'bg-status-running/10 text-status-running',
  paused: 'bg-status-warning/10 text-status-warning',
  done: 'bg-surface-container-high text-on-surface-variant',
  failed: 'bg-error/10 text-error',
}
const relTime = ts => {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s/60)}m`
  if (s < 86400) return `${Math.floor(s/3600)}h`
  return `${Math.floor(s/86400)}d`
}

function selectConversation(convId) { activeConversationId.value = convId }
function newConversation() { activeConversationId.value = null }

const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'

async function load() {
  loading.value = true
  try {
    const res = await workbenchApi.getProject(id)
    project.value = res.project
    // 后端权威:项目的活跃对话(无则 null → 下条消息走新建分支)
    activeConversationId.value = res.project?.activeConversationId || null
    files.value = res.files || []
    commits.value = res.commits || []
    lastReconcile.value = res.lastReconcile || null
  } catch (e) { notify('error', e.message || t('workbench.detail.loadFailed')) }
  finally { loading.value = false }
}
async function loadConversations() {
  try {
    const r = await workbenchApi.conversations.list(id)
    conversations.value = r.conversations || []
  } catch {}
}
async function reconcile() {
  reconciling.value = true
  try {
    const r = await workbenchApi.reconcile(id)
    lastReconcile.value = { result: r, ts: r.ts }
    if (r.skipped) notify('error', r.reason)
    else notify('success', t('workbench.detail.reconcileSummary', { applied: r.applied.length, failed: r.failed.length }))
  } catch (e) { notify('error', e.message || t('workbench.detail.reconcileFailed')) }
  finally { reconciling.value = false }
}
onMounted(async () => { await load(); loadConversations() })

async function openFile(path) {
  if (dirty.value && !confirm(t('workbench.detail.unsavedChangesWarning'))) return
  try {
    const res = await workbenchApi.readFile(id, path)
    currentPath.value = res.path
    currentContent.value = res.content
    dirty.value = false
  } catch (e) { notify('error', e.message || t('workbench.detail.readFailed')) }
}
async function save(content) {
  if (!currentPath.value) return
  saving.value = true
  try {
    if (typeof content === 'string') currentContent.value = content
    await workbenchApi.writeFile(id, currentPath.value, currentContent.value)
    dirty.value = false
    notify('success', t('workbench.detail.saveSuccess'))
    if (!files.value.includes(currentPath.value)) { files.value.push(currentPath.value); files.value.sort() }
  } catch (e) { notify('error', e.message || t('workbench.detail.saveFailed')) }
  finally { saving.value = false }
}
async function doCommit() {
  try {
    const r = await workbenchApi.commit(id, commitMsg.value.trim() || 'update')
    if (r.committed) { notify('success', t('workbench.detail.commitSuccess', { subject: r.subject })); commitMsg.value = '' }
    else { notify('error', t('workbench.detail.noChangesToCommit')) }
    const res = await workbenchApi.getProject(id)
    commits.value = res.commits || []
  } catch (e) { notify('error', e.message || t('workbench.detail.commitFailed')) }
}
function addFile() {
  const p = newFile.value.trim()
  if (!p) return
  currentPath.value = p; currentContent.value = ''; dirty.value = true; newFile.value = ''
  notify('success', t('workbench.detail.newFileCreated', { path: p }))
}
</script>

<template>
  <div v-if="loading" class="p-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

  <section v-else-if="project" class="animate-fade-in h-full flex flex-col min-h-0">
    <!-- Header -->
    <div class="shrink-0 flex items-center gap-sm px-md py-sm border-b border-outline-variant bg-surface-container-lowest">
      <button @click="router.push('/workbench')" class="p-1 rounded hover:bg-surface-container text-on-surface-variant"><span class="material-symbols-outlined">arrow_back</span></button>
      <h2 class="text-body-md font-bold text-on-surface flex items-center gap-xs">
        <span class="material-symbols-outlined text-lg">workspaces</span>{{ project.name }}
      </h2>
      <span class="text-body-xs text-on-surface-variant">{{ project.clusterName }}</span>

      <!-- Mode switcher (segmented control) -->
      <div class="ml-auto flex items-center gap-xs bg-surface-container-low rounded-lg p-0.5">
        <button @click="setMode('agent')" class="flex items-center gap-xs px-md py-xs rounded-md text-body-sm font-medium transition-all"
          :class="mode === 'agent' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'">
          <span class="material-symbols-outlined text-sm">smart_toy</span> Agent
        </button>
        <button @click="setMode('edit')" class="flex items-center gap-xs px-md py-xs rounded-md text-body-sm font-medium transition-all"
          :class="mode === 'edit' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface'">
          <span class="material-symbols-outlined text-sm">code</span> Edit
        </button>
      </div>

      <button @click="reconcile" :disabled="reconciling" class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container disabled:opacity-40" :title="t('workbench.detail.reconcileTitle')">
        <span class="material-symbols-outlined text-sm" :class="reconciling ? 'animate-spin' : ''">{{ reconciling ? 'progress_activity' : 'sync' }}</span>
      </button>
    </div>

    <!-- Reconcile status -->
    <div v-if="lastReconcile" class="shrink-0 text-body-xs text-on-surface-variant flex items-center gap-sm px-md py-xs bg-surface-container-low/50">
      <span class="material-symbols-outlined text-sm">sync</span>
      {{ t('workbench.detail.lastReconcile', { ts: fmt(lastReconcile.ts) }) }}:
      <template v-if="lastReconcile.result?.skipped">{{ t('workbench.detail.reconcileSkipped', { reason: lastReconcile.result.reason }) }}</template>
      <template v-else>{{ lastReconcile.result?.applied?.length || 0 }} applied, {{ lastReconcile.result?.failed?.length || 0 }} failed</template>
    </div>

    <!-- ═══════════════ Agent Mode ═══════════════ -->
    <div v-if="mode === 'agent'" class="flex-1 min-h-0 flex">
      <!-- Conversation list sidebar -->
      <div class="w-56 shrink-0 flex flex-col border-r border-outline-variant bg-surface-container-lowest">
        <div class="p-sm border-b border-outline-variant">
          <button @click="newConversation" class="w-full flex items-center justify-center gap-xs px-sm py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-sm">add</span> New
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-xs flex flex-col gap-0.5">
          <button v-for="c in conversations" :key="c.id" @click="selectConversation(c.id)"
            class="text-left px-sm py-sm rounded-lg transition-colors"
            :class="activeConversationId === c.id ? 'bg-primary-container text-on-primary-container' : 'hover:bg-surface-container'">
            <div class="flex items-center gap-xs mb-xs">
              <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="{
                'bg-status-running': c.status === 'running',
                'bg-status-warning': c.status === 'paused',
                'bg-on-surface-variant/30': c.status === 'done',
                'bg-error': c.status === 'failed',
              }"></span>
              <span class="text-body-xs text-on-surface-variant shrink-0">{{ relTime(c.updatedAt) }}</span>
              <span v-if="c.steps" class="text-body-xs text-on-surface-variant/50 ml-auto">{{ c.steps }}↻</span>
            </div>
            <p class="text-body-xs truncate">{{ c.userMessage || '(empty)' }}</p>
          </button>
          <p v-if="!conversations.length" class="text-body-xs text-on-surface-variant/50 px-sm py-md text-center">No conversations yet</p>
        </div>
      </div>
      <!-- Chat area (full width) -->
      <div class="flex-1 min-w-0">
        <WorkbenchChat
          :key="activeConversationId || 'new'"
          :project-id="id"
          :project-name="project?.name"
          :conversation-id="activeConversationId"
          :active-conversation-id="activeConversationId"
          @conversation-created="loadConversations"
        />
      </div>
    </div>

    <!-- ═══════════════ Edit Mode ═══════════════ -->
    <div v-else class="flex-1 min-h-0 flex gap-md p-md">
      <!-- File tree -->
      <div class="w-56 shrink-0 flex flex-col bg-surface-container-lowest border border-outline-variant rounded-lg overflow-hidden">
        <div class="px-md py-sm border-b border-outline-variant text-label-caps text-on-surface-variant flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">folder</span>{{ t('workbench.detail.files') }}
        </div>
        <div class="flex-1 overflow-y-auto p-sm flex flex-col gap-0.5">
          <button v-for="f in files" :key="f" @click="openFile(f)"
            class="text-left text-body-sm font-mono px-sm py-xs rounded truncate"
            :class="f === currentPath ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container'">
            <span class="material-symbols-outlined text-sm align-middle mr-xs">description</span>{{ f }}
          </button>
          <p v-if="!files.length" class="text-body-xs text-on-surface-variant px-sm py-sm">{{ t('workbench.detail.noFiles') }}</p>
        </div>
        <div class="p-sm border-t border-outline-variant flex gap-xs">
          <input v-model="newFile" @keydown.enter="addFile" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-xs font-mono" :placeholder="t('workbench.detail.newFilePlaceholder')" />
          <button @click="addFile" class="p-xs rounded bg-surface-container hover:bg-surface-container-high"><span class="material-symbols-outlined text-sm">add</span></button>
        </div>
      </div>

      <!-- Editor + commit + history -->
      <div class="flex-1 min-w-0 flex flex-col gap-sm overflow-y-auto">
        <div class="flex items-center justify-between gap-sm">
          <span class="text-body-sm font-mono text-on-surface-variant truncate">{{ currentPath || t('workbench.detail.noFileSelected') }}</span>
          <span v-if="dirty" class="text-body-xs text-status-warning">{{ t('workbench.detail.unsaved') }}</span>
        </div>
        <YamlEditor :model-value="currentContent" :readonly="false" height="50vh" @save="save" />
        <div class="flex items-center gap-xs">
          <input v-model="commitMsg" @keydown.enter="doCommit" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" :placeholder="t('workbench.detail.commitPlaceholder')" />
          <button @click="doCommit" class="flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container"><span class="material-symbols-outlined text-sm">commit</span>{{ t('workbench.detail.commit') }}</button>
        </div>
        <details class="bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant select-none">{{ t('workbench.detail.recentCommits', { n: commits.length }) }}</summary>
          <div class="px-md pb-md flex flex-col gap-xs">
            <div v-for="c in commits" :key="c.hash" class="text-body-xs flex items-center gap-sm">
              <span class="font-mono text-on-surface-variant">{{ (c.hash || '').slice(0, 7) }}</span>
              <span class="text-on-surface truncate">{{ c.subject }}</span>
              <span class="text-on-surface-variant ml-auto shrink-0">{{ fmt(c.ts) }}</span>
            </div>
            <p v-if="!commits.length" class="text-body-xs text-on-surface-variant">{{ t('workbench.detail.noCommits') }}</p>
          </div>
        </details>
      </div>
    </div>
  </section>

  <div v-else class="p-md text-center text-on-surface-variant">{{ t('workbench.detail.projectNotFound') }}</div>
</template>
