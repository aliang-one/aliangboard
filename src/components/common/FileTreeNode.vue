<script setup>
// 递归树节点：通过 inject('fileExplorer') 拿上下文，避免深层 prop 透传。
// 文件夹：点 twisty 展开/折叠（懒加载由 toggleNode 负责）；点行选中。
import { computed, inject } from 'vue'

const props = defineProps({
  entry: { type: Object, required: true },
  parentPath: { type: String, default: '/' },
  depth: { type: Number, default: 0 },
})

const x = inject('fileExplorer')
const joinPath = (d, n) => (d.endsWith('/') ? d + n : d + '/' + n)
const path = computed(() => joinPath(props.parentPath, props.entry.name))
const isDir = computed(() => props.entry.type === 'dir')
const expanded = computed(() => isDir.value && x.isExpanded(path.value))
const loading = computed(() => isDir.value && x.isLoading(path.value))
const selected = computed(() => x.selected.value === path.value)
const children = computed(() => expanded.value ? (x.childrenOf(path.value) || []) : [])

function onRow() { x.selectNode(path.value, isDir.value) }
async function onTwisty(e) { e.stopPropagation(); await x.toggleNode(path.value) }
</script>

<template>
  <div>
    <div class="fb-row flex items-center gap-xs rounded-md cursor-pointer hover:bg-surface-container-low transition-colors"
         :class="{ 'fb-selected bg-primary/10 text-primary': selected }"
         :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
         @click="onRow">
      <button v-if="isDir" class="fb-twisty p-0 w-4 flex items-center justify-center text-on-surface-variant hover:text-primary" @click="onTwisty" :aria-label="expanded ? $t('component.fileBrowser.collapse') : $t('component.fileBrowser.expand')">
        <span class="material-symbols-outlined text-base">{{ expanded ? 'expand_more' : 'chevron_right' }}</span>
      </button>
      <span v-else class="inline-block w-4 shrink-0" />
      <span class="material-symbols-outlined text-base shrink-0" :class="isDir ? 'text-primary' : 'text-on-surface-variant'">{{ isDir ? (expanded ? 'folder_open' : 'folder') : 'description' }}</span>
      <span class="font-mono text-xs truncate flex-1" :title="entry.name">{{ entry.name }}</span>
      <span v-if="loading" class="material-symbols-outlined animate-spin text-xs text-on-surface-variant">progress_activity</span>
    </div>
    <FileTreeNode v-if="expanded" v-for="c in children" :key="c.name" :entry="c" :parent-path="path" :depth="depth + 1" />
  </div>
</template>
