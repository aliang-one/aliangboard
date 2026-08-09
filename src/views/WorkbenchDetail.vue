<script setup>
// 工作台项目详情:三栏 IDE 布局(文件树 | YamlEditor | AI chat),可折叠。
// repo 在服务端(git),前端只读写文件 + 触发 commit。AI authoring 是 W4。
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
const showFileTree = ref(true)
const showChat = ref(true)
const conversations = ref([])

const convStatusStyle = {
  running: 'bg-status-running/10 text-status-running',
  paused: 'bg-status-warning/10 text-status-warning',
  done: 'bg-surface-container-high text-on-surface-variant',
  failed: 'bg-error/10 text-error',
}

const fmt = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-'

async function load() {
  loading.value = true
  try {
    const res = await workbenchApi.getProject(id)
    project.value = res.project
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
  } catch { /* best-effort: history panel non-critical */ }
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
    if (r.committed) {
      notify('success', t('workbench.detail.commitSuccess', { subject: r.subject }))
      commitMsg.value = ''
    } else {
      notify('error', t('workbench.detail.noChangesToCommit'))
    }
    const res = await workbenchApi.getProject(id)
    commits.value = res.commits || []
  } catch (e) { notify('error', e.message || t('workbench.detail.commitFailed')) }
}

function addFile() {
  const p = newFile.value.trim()
  if (!p) return
  currentPath.value = p
  currentContent.value = ''
  dirty.value = true
  newFile.value = ''
  notify('success', t('workbench.detail.newFileCreated', { path: p }))
}
</script>

<template>
  <div v-if="loading" class="p-md text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

  <section v-else-if="project" class="animate-fade-in h-full flex flex-col gap-md min-h-0">
    <div class="shrink-0 flex items-center gap-sm">
      <button @click="router.push('/workbench')" class="p-1 rounded hover:bg-surface-container text-on-surface-variant"><span class="material-symbols-outlined">arrow_back</span></button>
      <h2 class="text-headline-lg font-bold text-on-surface flex items-center gap-xs"><span class="material-symbols-outlined">workspaces</span>{{ project.name }}</h2>
      <span class="text-body-sm text-on-surface-variant">· {{ project.clusterName }}</span>
      <button @click="reconcile" :disabled="reconciling" class="ml-auto flex items-center gap-xs px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container disabled:opacity-40" :title="t('workbench.detail.reconcileTitle')">
        <span class="material-symbols-outlined text-sm">{{ reconciling ? 'progress_activity' : 'sync' }}</span> {{ reconciling ? t('workbench.detail.reconciling') : t('workbench.detail.reconcile') }}
      </button>
      <!-- collapse / expand toggles -->
      <button v-if="showFileTree" @click="showFileTree = false" class="flex items-center gap-xs px-sm py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container" :title="t('workbench.ide.collapseFiles')">
        <span class="material-symbols-outlined text-sm">left_panel_close</span>
      </button>
      <button v-else @click="showFileTree = true" class="flex items-center gap-xs px-sm py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container" :title="t('workbench.ide.expandFiles')">
        <span class="material-symbols-outlined text-sm">left_panel_open</span>
      </button>
      <button v-if="showChat" @click="showChat = false" class="flex items-center gap-xs px-sm py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container" :title="t('workbench.ide.collapseChat')">
        <span class="material-symbols-outlined text-sm">right_panel_close</span>
      </button>
      <button v-else @click="showChat = true" class="flex items-center gap-xs px-sm py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container" :title="t('workbench.ide.expandChat')">
        <span class="material-symbols-outlined text-sm">right_panel_open</span>
      </button>
    </div>

    <div v-if="lastReconcile" class="shrink-0 text-body-xs text-on-surface-variant flex items-center gap-sm px-sm">
      <span class="material-symbols-outlined text-sm">sync</span>
      {{ t('workbench.detail.lastReconcile', { ts: fmt(lastReconcile.ts) }) }}:
      <template v-if="lastReconcile.result?.skipped">{{ t('workbench.detail.reconcileSkipped', { reason: lastReconcile.result.reason }) }}</template>
      <template v-else>{{ lastReconcile.result?.applied?.length || 0 }} applied, {{ lastReconcile.result?.failed?.length || 0 }} failed</template>
      <span v-if="lastReconcile.result?.failed?.length" class="text-error">⚠ {{ t('workbench.detail.hasFailures') }}</span>
    </div>

    <div class="flex-1 min-h-0 flex gap-md">
      <!-- 文件树(左栏,可折叠) -->
      <div v-if="showFileTree" class="w-64 shrink-0 flex flex-col bg-surface-container-lowest border border-outline-variant rounded-lg overflow-hidden">
        <div class="px-md py-sm border-b border-outline-variant text-label-caps text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-base">folder</span>{{ t('workbench.detail.files') }}</div>
        <div class="flex-1 overflow-y-auto p-sm flex flex-col gap-0.5">
          <button v-for="f in files" :key="f" @click="openFile(f)" class="text-left text-body-sm font-mono px-sm py-xs rounded truncate" :class="f === currentPath ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container'">
            <span class="material-symbols-outlined text-sm align-middle mr-xs">description</span>{{ f }}
          </button>
          <p v-if="!files.length" class="text-body-xs text-on-surface-variant px-sm py-sm">{{ t('workbench.detail.noFiles') }}</p>
        </div>
        <div class="p-sm border-t border-outline-variant flex gap-xs">
          <input v-model="newFile" @keydown.enter="addFile" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-xs text-body-xs font-mono" :placeholder="t('workbench.detail.newFilePlaceholder')" />
          <button @click="addFile" class="p-xs rounded bg-surface-container hover:bg-surface-container-high" :title="t('workbench.detail.newFileButton')"><span class="material-symbols-outlined text-sm">add</span></button>
        </div>
      </div>

      <!-- 编辑器 + 提交(中栏) -->
      <div class="flex-1 min-w-0 flex flex-col gap-sm">
        <div class="flex items-center justify-between gap-sm">
          <span class="text-body-sm font-mono text-on-surface-variant truncate">{{ currentPath || t('workbench.detail.noFileSelected') }}</span>
          <span v-if="dirty" class="text-body-xs text-status-warning">{{ t('workbench.detail.unsaved') }}</span>
        </div>
        <YamlEditor :model-value="currentContent" :readonly="false" height="60vh" @save="save" />
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

        <details class="bg-surface-container-low border border-outline-variant rounded-lg">
          <summary class="cursor-pointer px-md py-sm text-body-sm text-on-surface-variant select-none flex items-center gap-xs">
            <span class="material-symbols-outlined text-sm">forum</span>
            {{ t('workbench.detail.conversationHistory') }} ({{ conversations.length }})
          </summary>
          <div class="px-md pb-md flex flex-col gap-xs">
            <div v-for="c in conversations" :key="c.id" class="flex items-center gap-sm py-xs border-b border-outline-variant/30 last:border-0">
              <span class="px-1.5 py-0.5 rounded text-body-xs font-semibold" :class="convStatusStyle[c.status] || convStatusStyle.done">{{ c.status }}</span>
              <span class="text-body-sm text-on-surface truncate flex-1">{{ c.userMessage }}</span>
              <span class="text-body-xs text-on-surface-variant shrink-0">{{ c.steps }} steps</span>
              <span class="text-body-xs text-on-surface-variant shrink-0">{{ fmt(c.updatedAt) }}</span>
            </div>
            <p v-if="!conversations.length" class="text-body-xs text-on-surface-variant">{{ t('workbench.detail.noConversations') }}</p>
          </div>
        </details>
      </div>

      <!-- AI 聊天(右栏,可折叠) -->
      <div v-if="showChat" class="w-96 shrink-0 flex flex-col bg-surface-container-lowest border border-outline-variant rounded-lg overflow-hidden">
        <WorkbenchChat :project-id="id" :project-name="project?.name" />
      </div>
    </div>
  </section>

  <div v-else class="p-md text-center text-on-surface-variant">{{ t('workbench.detail.projectNotFound') }}</div>
</template>
