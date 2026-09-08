<script setup>
// 右栏·文件夹：展示该目录条目（v1 无 size），点条目交给编排器选中。
// 选中文件夹时若其内容未缓存（未在树里展开过），自行 listDir 加载——与 FilePreview 自加载文件内容对齐。
import { computed, watch, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps({ path: { type: String, default: '/' } })
const x = inject('fileExplorer')
const joinPath = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n)
const entries = computed(() => x.childrenOf(props.path) || [])
const loading = computed(() => x.isLoading(props.path))
// 选中即确保加载：已缓存则 listDir 立即命中返回（无额外请求），未缓存则拉取
watch(() => props.path, () => { x.listDir(props.path).catch(() => {}) }, { immediate: true })
function open(e) { x.selectNode(joinPath(props.path, e.name), e.type === 'dir') }
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-xs pb-sm border-b border-outline-variant/40 shrink-0 pr-10">
      <span class="material-symbols-outlined text-primary text-base">folder_open</span>
      <span class="font-mono text-xs text-on-surface truncate flex-1" :title="path">{{ path }}</span>
      <span class="text-[10px] text-on-surface-variant shrink-0">{{ t('component.fileBrowser.folderItems', { count: entries.length }) }}</span>
    </div>
    <div class="flex-1 overflow-auto mt-sm min-h-0">
      <div v-if="loading" class="py-md text-center text-body-sm text-on-surface-variant">
        <span class="material-symbols-outlined animate-spin inline-block">progress_activity</span>
      </div>
      <p v-else-if="!entries.length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ t('component.fileBrowser.emptyDir') }}</p>
      <button v-for="e in entries" :key="e.name" class="fb-item group w-full flex items-center gap-sm px-sm py-1.5 rounded-lg hover:bg-surface-container-low text-left transition-colors" @click="open(e)">
        <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'dir' ? 'text-primary' : 'text-on-surface-variant'">{{ e.type === 'dir' ? 'folder' : 'description' }}</span>
        <span class="font-mono text-xs truncate flex-1 min-w-0">{{ e.name }}</span>
        <!-- 三件套(2026-09-08):行内 hover 钮(手机常显);@click.stop 防冒泡触发行选中 -->
        <span class="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100" @click.stop>
          <button :data-test="'entry-rename-' + e.name" class="p-0.5 rounded text-on-surface-variant/60 hover:text-primary relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('component.fileBrowser.renameTitle')" @click="x.askRename(joinPath(props.path, e.name))">
            <span class="material-symbols-outlined text-sm">edit</span>
          </button>
          <button :data-test="'entry-delete-' + e.name" class="p-0.5 rounded text-on-surface-variant/60 hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('component.fileBrowser.deleteTitle')" @click="x.askDelete(joinPath(props.path, e.name), e.type === 'dir')">
            <span class="material-symbols-outlined text-sm">delete</span>
          </button>
        </span>
      </button>
    </div>
  </div>
</template>
