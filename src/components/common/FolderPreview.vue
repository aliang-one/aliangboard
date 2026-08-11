<script setup>
// 右栏·文件夹：展示该目录条目（v1 无 size），点条目交给编排器选中。
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = defineProps({ path: { type: String, default: '/' } })
const x = inject('fileExplorer')
const joinPath = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n)
const entries = computed(() => x.childrenOf(props.path) || [])
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
      <p v-if="!entries.length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ t('component.fileBrowser.emptyDir') }}</p>
      <button v-for="e in entries" :key="e.name" class="fb-item w-full flex items-center gap-sm px-sm py-1.5 rounded-lg hover:bg-surface-container-low text-left transition-colors" @click="open(e)">
        <span class="material-symbols-outlined text-base shrink-0" :class="e.type === 'dir' ? 'text-primary' : 'text-on-surface-variant'">{{ e.type === 'dir' ? 'folder' : 'description' }}</span>
        <span class="font-mono text-xs truncate flex-1">{{ e.name }}</span>
      </button>
    </div>
  </div>
</template>
