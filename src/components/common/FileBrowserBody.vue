<script setup>
// Pod 文件浏览（VSCode 式）：左懒加载树 + 右上下文区（文件夹/文件）。
// 编排器：持有 selected/expanded，provide('fileExplorer') 给子树，复用 usePodFiles。
// props 契约不变（namespace/pod/container），根 h-full min-h-0 供 SplitPane 取尺寸。
import { ref, computed, provide, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { usePodFiles } from '@/composables/usePodFiles'
import SplitPane from './SplitPane.vue'
import FileTree from './FileTree.vue'
import FolderPreview from './FolderPreview.vue'
import FilePreview from './FilePreview.vue'

const { t } = useI18n()
const props = defineProps({
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})

const files = usePodFiles()
const selected = ref(null)            // path | null
const selectedIsDir = ref(false)
const expanded = ref(new Set())
const fileInput = ref(null)

const ctx = computed(() => ({ namespace: props.namespace, pod: props.pod, container: props.container }))
const k = path => `${props.container || ''}::${path}`

function childrenOf(path) { return files.dirCache.value.get(k(path)) || [] }
function isExpanded(path) { return expanded.value.has(path) }
function isLoading(path) { return files.inflight.value.has(k(path)) }
function selectNode(path, isDir) { selected.value = path; selectedIsDir.value = isDir }
async function toggleNode(path) {
  if (expanded.value.has(path)) {
    const s = new Set(expanded.value); s.delete(path); expanded.value = s; return
  }
  if (!files.dirCache.value.has(k(path))) {
    try { await files.listDir(ctx.value, path) }
    catch (e) { notify('error', e.message || t('component.fileBrowser.readDirFailed')); return }  // 失败不展开，让用户可重试
  }
  const s = new Set(expanded.value); s.add(path); expanded.value = s
}

provide('fileExplorer', {
  selected, isExpanded, isLoading, childrenOf, selectNode, toggleNode,
  listDir: (path, opts) => files.listDir(ctx.value, path, opts),
  readFile: (path, opts) => files.readFile(ctx.value, path, opts),
  writeFile: (path, bytes) => files.writeFile(ctx.value, path, bytes),
  download: (path) => files.download(ctx.value, path),
  dirCache: files.dirCache,
})

// 上传：写入到「当前选中文件夹」或其父目录
function joinPath(d, n) { return d.endsWith('/') ? d + n : d + '/' + n }
function parentDir(path) { if (path === '/' || !path) return '/'; const p = path.split('/').filter(Boolean); p.pop(); return p.length ? '/' + p.join('/') : '/' }
function pickUpload() { fileInput.value?.click() }
async function onUpload(e) {
  const f = e.target.files?.[0]; if (!f) return
  const dir = selectedIsDir.value ? selected.value : (selected.value ? parentDir(selected.value) : '/')
  const target = joinPath(dir, f.name)
  try {
    await files.writeFile(ctx.value, target, new Uint8Array(await f.arrayBuffer()))
    notify('success', t('component.fileBrowser.uploaded', { name: f.name, size: f.size }))
    await files.listDir(ctx.value, dir, { force: true })
  } catch (err) { notify('error', err.message || t('component.fileBrowser.uploadFailed')) }
  finally { e.target.value = '' }
}

async function refresh() {
  await files.listDir(ctx.value, '/', { force: true }).catch(() => {})
  for (const p of expanded.value) await files.listDir(ctx.value, p, { force: true }).catch(() => {})
}

onMounted(() => { if (props.namespace && props.pod) files.listDir(ctx.value, '/').catch(() => {}) })
// 换容器：清「离开的」容器缓存 + 重置选中/展开 + 重拉根
watch(() => props.container, (next, prev) => {
  if (prev) files.resetForContainer(prev)   // 清理「离开的」容器缓存（用旧值）
  selected.value = null; selectedIsDir.value = false; expanded.value = new Set()
  if (props.namespace && props.pod) files.listDir(ctx.value, '/').catch(() => {})
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 工具条 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0">
      <button class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container" :title="t('common.sync')" @click="refresh">
        <span class="material-symbols-outlined text-base" :class="files.inflight.value.size ? 'animate-spin' : ''">refresh</span>
      </button>
      <span class="font-mono text-xs text-on-surface-variant truncate flex-1">{{ selected || '/' }}</span>
      <button class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0" :title="t('component.fileBrowser.uploadToDir')" @click="pickUpload">
        <span class="material-symbols-outlined text-sm">upload</span>{{ t('component.fileBrowser.upload') }}
      </button>
    </div>

    <!-- 主体：左树 | 右上下文 -->
    <div class="flex-1 min-h-0 mt-sm">
      <SplitPane storage-key="pod-file-explorer-split" :default-split="0.32">
        <template #first>
          <FileTree />
        </template>
        <template #second>
          <div v-if="!selected" class="h-full flex items-center justify-center text-body-sm text-on-surface-variant/60 px-lg text-center">
            {{ t('component.fileBrowser.emptyHint') }}
          </div>
          <FolderPreview v-else-if="selectedIsDir" :path="selected" />
          <FilePreview v-else :key="selected" :path="selected" />
        </template>
      </SplitPane>
    </div>

    <input ref="fileInput" type="file" class="hidden" @change="onUpload">
  </div>
</template>
