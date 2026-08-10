<script setup>
// Pod 文件浏览核心（列表/查看/下载/上传/编辑保存）——无 Modal 外壳，由调用方决定内嵌或套弹窗。
// 复用于 Deployment 概览（FileBrowser 弹窗内）与 Pod 详情（Files 标签内嵌）。
// 远端基于一次性 exec（ls/head/cat/写入）。
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { podFileApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()

const props = defineProps({
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})

const cwd = ref('/')
const entries = ref([])
const loading = ref(false)
const error = ref('')
const file = ref(null)       // { name, path, content, truncated, binary }
const editing = ref(false)
const editContent = ref('')
const saving = ref(false)
const fileInput = ref(null)

function joinPath(dir, name) { return dir.endsWith('/') ? dir + name : dir + '/' + name }
const crumbs = computed(() => {
  const parts = cwd.value.split('/').filter(Boolean)
  return [{ n: '/', p: '/' }, ...parts.map((part, i) => ({ n: part, p: '/' + parts.slice(0, i + 1).join('/') }))]
})

// —— 目录 ——
async function loadDir(path) {
  cwd.value = path; file.value = null; error.value = ''
  if (!props.namespace || !props.pod) return
  loading.value = true
  try {
    const res = await podFileApi.list({ namespace: props.namespace, pod: props.pod, container: props.container, path })
    entries.value = (res.entries || []).slice().sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  } catch (e) { error.value = e.message || t('component.fileBrowser.readDirFailed'); entries.value = [] }
  finally { loading.value = false }
}
function goUp() {
  if (cwd.value === '/') return
  const parts = cwd.value.split('/').filter(Boolean); parts.pop()
  loadDir(parts.length ? '/' + parts.join('/') : '/')
}
async function openEntry(e) {
  const fp = joinPath(cwd.value, e.name)
  if (e.type === 'dir') return loadDir(fp)
  loading.value = true; error.value = ''
  try {
    const res = await podFileApi.read({ namespace: props.namespace, pod: props.pod, container: props.container, path: fp })
    file.value = { name: e.name, path: res.path, content: res.content, truncated: res.truncated, binary: res.binary }
    editing.value = false
  } catch (err) { error.value = err.message || t('component.fileBrowser.readFailed') }
  finally { loading.value = false }
}

// —— 下载 ——
async function download() {
  if (!file.value) return
  try {
    const blob = await podFileApi.download({ namespace: props.namespace, pod: props.pod, container: props.container, path: file.value.path })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = file.value.name; a.click(); URL.revokeObjectURL(url)
  } catch (e) { notify('error', e.message || t('component.fileBrowser.downloadFailed')) }
}

// —— 上传 ——
function pickUpload() { fileInput.value?.click() }
async function onUpload(e) {
  const f = e.target.files?.[0]
  if (!f) return
  const targetPath = joinPath(cwd.value, f.name)
  try {
    await writeBytes(targetPath, new Uint8Array(await f.arrayBuffer()))
    notify('success', t('component.fileBrowser.uploaded', { name: f.name, size: f.size }))
    loadDir(cwd.value)
  } catch (err) { notify('error', err.message || t('component.fileBrowser.uploadFailed')) }
  finally { e.target.value = '' }
}

// —— 编辑保存（仅文本、未截断）——
const editable = computed(() => !!file.value && !file.value.binary && !file.value.truncated)
function startEdit() { if (!editable.value) return; editContent.value = file.value.content; editing.value = true }
function cancelEdit() { editing.value = false }
async function saveEdit() {
  if (!file.value) return
  saving.value = true
  try {
    await writeBytes(file.value.path, new TextEncoder().encode(editContent.value))
    notify('success', t('component.fileBrowser.saved'))
    file.value.content = editContent.value
    editing.value = false
  } catch (e) { notify('error', e.message || t('component.fileBrowser.saveFailed')) }
  finally { saving.value = false }
}

// 把字节数组 base64 后写入（复用 /api/podfile/write，支持二进制）
async function writeBytes(path, bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  await podFileApi.write({ namespace: props.namespace, pod: props.pod, container: props.container, path, data: btoa(binary) })
}

// 挂载即加载根目录（弹窗场景：Modal v-if 打开时才挂载 → 打开时加载；内嵌场景：标签渲染即加载）
onMounted(() => { if (props.namespace && props.pod) loadDir('/') })
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 工具条 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0">
      <button @click="goUp" :disabled="cwd === '/' || !!file" class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container disabled:opacity-30" :title="t('component.fileBrowser.goUp')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
      <button @click="loadDir(cwd)" :disabled="!!file" class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container disabled:opacity-30" :title="t('common.sync')"><span class="material-symbols-outlined text-base" :class="loading ? 'animate-spin' : ''">refresh</span></button>
      <div class="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto">
        <template v-for="c in crumbs" :key="c.p">
          <button @click="loadDir(c.p)" class="font-mono text-xs text-on-surface-variant hover:text-primary px-0.5 shrink-0">{{ c.n === '/' ? '🏠 /' : c.n }}</button>
          <span v-if="c.n !== '/'" class="text-on-surface-variant/30 text-xs shrink-0">/</span>
        </template>
      </div>
      <button v-if="!file" @click="pickUpload" class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors shrink-0" :title="t('component.fileBrowser.uploadToDir')">
        <span class="material-symbols-outlined text-sm">upload</span>{{ t('component.fileBrowser.upload') }}
      </button>
    </div>

    <!-- 主体 -->
    <div class="flex-1 overflow-auto mt-sm min-h-0">
      <p v-if="error" class="text-body-sm text-error py-sm flex items-center gap-xs"><span class="material-symbols-outlined text-base">error</span>{{ error }}</p>
      <div v-else-if="loading" class="py-md text-center text-body-sm text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block">progress_activity</span> {{ t('common.loading') }}</div>

      <!-- 文件查看/编辑 -->
      <template v-else-if="file">
        <div class="flex items-center gap-xs mb-sm sticky top-0 bg-surface-container-lowest pb-sm">
          <button @click="file = null; editing = false" class="flex items-center gap-0.5 text-xs text-primary hover:underline"><span class="material-symbols-outlined text-sm">arrow_back</span>{{ t('component.fileBrowser.backToList') }}</button>
          <span class="font-mono text-xs text-on-surface truncate flex-1" :title="file.path">{{ file.name }}</span>
          <span v-if="file.binary" class="text-[10px] px-1 rounded bg-surface-container text-on-surface-variant">{{ t('component.fileBrowser.binary') }}</span>
          <span v-else-if="file.truncated" class="text-[10px] px-1 rounded bg-tertiary-container/20 text-tertiary-container">{{ t('component.fileBrowser.truncated') }}</span>
          <button @click="download" class="p-1 rounded-md text-on-surface-variant hover:text-primary hover:bg-primary/10" :title="t('component.fileBrowser.download')"><span class="material-symbols-outlined text-base">download</span></button>
          <template v-if="editable">
            <button v-if="!editing" @click="startEdit" class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20" :title="t('common.edit')"><span class="material-symbols-outlined text-sm">edit</span>{{ t('common.edit') }}</button>
            <template v-else>
              <button @click="cancelEdit" class="px-sm py-1 rounded-md border border-outline-variant text-xs text-on-surface hover:bg-surface-container">{{ t('common.cancel') }}</button>
              <button @click="saveEdit" :disabled="saving" class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary text-on-primary text-xs font-semibold hover:opacity-90 disabled:opacity-50"><span class="material-symbols-outlined text-sm">{{ saving ? 'progress_activity' : 'save' }}</span>{{ t('common.save') }}</button>
            </template>
          </template>
        </div>
        <pre v-if="!editing" class="bg-code-surface text-on-code-surface p-md rounded-lg font-mono text-code-sm overflow-auto whitespace-pre flex-1">{{ file.content }}<span v-if="file.truncated" class="text-on-code-surface/50">

…{{ t('component.fileBrowser.contentTruncated') }}</span></pre>
        <textarea v-else v-model="editContent" class="w-full bg-code-surface text-on-code-surface p-md rounded-lg font-mono text-code-sm outline-none border border-primary/40 flex-1" style="resize: none"></textarea>
      </template>

      <!-- 目录列表 -->
      <template v-else>
        <p v-if="!entries.length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ t('component.fileBrowser.emptyDir') }}</p>
        <button v-for="e in entries" :key="e.name" @click="openEntry(e)"
          class="w-full flex items-center gap-sm px-sm py-1.5 rounded-lg hover:bg-surface-container-low text-left transition-colors">
          <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'dir' ? 'text-primary' : 'text-on-surface-variant'">{{ e.type === 'dir' ? 'folder' : 'description' }}</span>
          <span class="font-mono text-xs text-on-surface truncate flex-1">{{ e.name }}</span>
          <span v-if="e.type === 'dir'" class="text-on-surface-variant/40 text-xs">›</span>
        </button>
      </template>
    </div>
    <input ref="fileInput" type="file" class="hidden" @change="onUpload">
  </div>
</template>
