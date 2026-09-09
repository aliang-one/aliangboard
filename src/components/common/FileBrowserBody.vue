<script setup>
// Pod 文件浏览（VSCode 式）：左懒加载树 + 右上下文区（文件夹/文件）。
// 编排器：持有 selected/expanded，provide('fileExplorer') 给子树，复用 usePodFiles。
// props 契约不变（namespace/pod/container），根 h-full min-h-0 供 SplitPane 取尺寸。
// 文件三件套(2026-09-08):新建文件夹/重命名/删除在编排器统一弹窗+执行,FolderPreview/
// FilePreview 经 inject 的 askRename/askDelete 发起;pod 容器删坏重启即恢复,删除走普通确认。
import { ref, computed, provide, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { notify } from '@/composables/useToast'
import { usePodFiles } from '@/composables/usePodFiles'
import { useTransferStore, fmtBytes } from '@/stores/transfers'
import { useIsPhone } from '@/composables/useBreakpoint'
import SplitPane from './SplitPane.vue'
import FileTree from './FileTree.vue'
import FolderPreview from './FolderPreview.vue'
import FilePreview from './FilePreview.vue'
import PromptDialog from './PromptDialog.vue'
import ConfirmDialog from './ConfirmDialog.vue'

const { t } = useI18n()
// 手机档 SplitPane 默认竖切(Wave5 B5,审计 #175):326px 下横切左树只分得 ~104px,
// 文件名几乎只剩图标;只改默认值——用户手动切换的方向仍走 localStorage 持久。
const { isPhone } = useIsPhone()
const props = defineProps({
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})

const files = usePodFiles()
const transferStore = useTransferStore()
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
  askRename, askDelete,
  ctx,
  dirCache: files.dirCache,
})

// —— 文件三件套:弹窗状态机 + 执行(成功后强刷父目录,并修复选中/展开态) ——
const op = ref(null)        // { kind:'mkdir'|'rename'|'delete', dir?, path?, name?, isDir? }
const opName = ref('')      // mkdir/rename 的输入值(PromptDialog v-model)
const opBusy = ref(false)

function targetDir() { return selectedIsDir.value ? selected.value : (selected.value ? parentDir(selected.value) : '/') }
function askMkdir() { op.value = { kind: 'mkdir', dir: targetDir() } }
function askRename(path) { op.value = { kind: 'rename', path } }
function askDelete(path, isDir) { op.value = { kind: 'delete', path, isDir: !!isDir } }

// 删除的目录若正被选中/展开(含其后代) → 清理,避免右栏指向已删路径
function pruneAfterDelete(path) {
  if (selected.value === path || selected.value?.startsWith(path + '/')) { selected.value = null; selectedIsDir.value = false }
  const s = new Set([...expanded.value].filter(p => p !== path && !p.startsWith(path + '/')))
  expanded.value = s
}
// 重命名路径变化 → 选中/展开键随迁(右栏 FilePreview 以 selected 为 key 自动重读)
function migrateAfterRename(path, target) {
  if (selected.value === path) selected.value = target
  else if (selected.value?.startsWith(path + '/')) selected.value = target + selected.value.slice(path.length)
  if (expanded.value.has(path)) { const s = new Set(expanded.value); s.delete(path); s.add(target); expanded.value = s }
}

async function runOp() {
  if (!op.value || opBusy.value) return
  opBusy.value = true
  const o = op.value
  try {
    if (o.kind === 'mkdir') {
      await files.mkdirDir(ctx.value, o.dir, opName.value)
      notify('success', t('component.fileBrowser.created', { name: opName.value }))
      await files.listDir(ctx.value, o.dir, { force: true }).catch(() => {})
      op.value = null
    } else if (o.kind === 'rename') {
      const target = joinPath(parentDir(o.path), opName.value)
      await files.renamePath(ctx.value, o.path, opName.value)
      notify('success', t('component.fileBrowser.renamed', { name: opName.value }))
      migrateAfterRename(o.path, target)
      await files.listDir(ctx.value, parentDir(o.path), { force: true }).catch(() => {})
      op.value = null
    } else {
      await files.deletePath(ctx.value, o.path)
      notify('success', t('component.fileBrowser.deleted', { path: o.path }))
      pruneAfterDelete(o.path)
      await files.listDir(ctx.value, parentDir(o.path), { force: true }).catch(() => {})
      op.value = null
    }
  } catch (e) {
    notify('error', e?.message || t('component.fileBrowser.opFailed'))
    // 窗留着可重试(与 ConfirmDialog 惯例一致);delete 失败也可直接取消
  } finally { opBusy.value = false }
}

// 上传：写入到「当前选中文件夹」或其父目录
function joinPath(d, n) { return d.endsWith('/') ? d + n : d + '/' + n }
function parentDir(path) { if (path === '/' || !path) return '/'; const p = path.split('/').filter(Boolean); p.pop(); return p.length ? '/' + p.join('/') : '/' }
function pickUpload() { fileInput.value?.click() }
async function onUpload(e) {
  const f = e.target.files?.[0]; if (!f) return
  const dir = selectedIsDir.value ? selected.value : (selected.value ? parentDir(selected.value) : '/')
  const target = joinPath(dir, f.name)
  transferStore.startUpload(ctx.value, { dir, path: target, file: f })   // 进度走任务栏;完成经下方 watcher 刷目录+toast
  e.target.value = ''
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

// 传输完成联动:本窗口(ns/pod/container 匹配)的上传任务完成 → 强制重拉目录 + 成功/失败 toast。
// usePodFiles 是每个 FileBrowserBody 各自实例化,store 无法直达缓存,故由各窗口自行监听刷新。
const seenFinished = new Set()
watch(() => transferStore.tasks, (ts) => {
  for (const tk of ts) {
    if (tk.kind !== 'upload' || (tk.status !== 'done' && tk.status !== 'error') || seenFinished.has(tk.id)) continue
    if (tk.namespace !== props.namespace || tk.pod !== props.pod || (tk.container || '') !== (props.container || '')) continue
    seenFinished.add(tk.id)
    if (tk.status === 'done') {
      notify('success', t('component.fileBrowser.uploaded', { name: tk.name, size: fmtBytes(tk.total) }))
      files.listDir(ctx.value, tk.dir || '/', { force: true }).catch(() => {})
    } else if (tk.status === 'error') {
      notify('error', tk.error || t('component.fileBrowser.uploadFailed'))
    }
  }
}, { deep: true })
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <!-- 工具条 -->
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0">
      <button class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('common.sync')" @click="refresh">
        <span class="material-symbols-outlined text-base" :class="files.inflight.value.size ? 'animate-spin' : ''">refresh</span>
      </button>
      <button data-test="btn-mkdir" class="p-1 rounded-md text-on-surface-variant hover:bg-surface-container relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('component.fileBrowser.newFolderIn', { path: targetDir() })" @click="askMkdir">
        <span class="material-symbols-outlined text-base">create_new_folder</span>
      </button>
      <span class="font-mono text-xs text-on-surface-variant truncate flex-1">{{ selected || '/' }}</span>
      <button class="flex items-center gap-0.5 px-sm py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 shrink-0" :title="t('component.fileBrowser.uploadToDir')" @click="pickUpload">
        <span class="material-symbols-outlined text-sm">upload</span>{{ t('component.fileBrowser.upload') }}
      </button>
    </div>

    <!-- 主体：左树 | 右上下文 -->
    <div class="flex-1 min-h-0 mt-sm">
      <SplitPane storage-key="pod-file-explorer-split" :default-split="0.32" :default-direction="isPhone ? 'vertical' : 'horizontal'">
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

    <!-- 三件套弹窗:mkdir/rename=PromptDialog(重命名全选初始值);delete=ConfirmDialog(普通确认,容器可恢复) -->
    <PromptDialog
      v-if="op && (op.kind === 'mkdir' || op.kind === 'rename')"
      :model-value="true"
      :title="op.kind === 'mkdir' ? t('component.fileBrowser.newFolder') : t('component.fileBrowser.renameTitle')"
      :message="op.kind === 'mkdir' ? t('component.fileBrowser.newFolderIn', { path: op.dir }) : op.path"
      :label="op.kind === 'mkdir' ? t('component.fileBrowser.nameLabel') : t('component.fileBrowser.newNameLabel')"
      :initial-value="op.kind === 'rename' ? (op.path.split('/').pop() || op.path) : ''"
      :select-all="op.kind === 'rename'"
      :loading="opBusy"
      @confirm="v => { opName = v; runOp() }"
      @cancel="op = null"
    />
    <ConfirmDialog
      v-else-if="op && op.kind === 'delete'"
      :model-value="true"
      :title="t('component.fileBrowser.deleteTitle')"
      :message="op.isDir ? t('component.fileBrowser.deleteConfirmDir', { path: op.path }) : t('component.fileBrowser.deleteConfirmFile', { path: op.path })"
      danger
      :loading="opBusy"
      @confirm="runOp"
      @cancel="op = null"
    />
  </div>
</template>
