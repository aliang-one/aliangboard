<script setup>
// 左栏目录树：渲染根目录条目；展开/选中态由 inject 上下文驱动。
import { inject } from 'vue'
import FileTreeNode from './FileTreeNode.vue'

const x = inject('fileExplorer')
const root = () => x.childrenOf('/') || []
const rootLoading = () => x.isLoading('/')
</script>

<template>
  <div class="h-full overflow-auto min-h-0 py-xs">
    <div v-if="rootLoading()" class="py-md text-center text-body-sm text-on-surface-variant">
      <span class="material-symbols-outlined animate-spin inline-block">progress_activity</span>
    </div>
    <template v-else>
      <FileTreeNode v-for="e in root()" :key="e.name" :entry="e" parent-path="/" :depth="0" />
      <p v-if="!root().length" class="py-md text-center text-body-sm text-on-surface-variant/60">{{ $t('component.fileBrowser.emptyDir') }}</p>
    </template>
  </div>
</template>
