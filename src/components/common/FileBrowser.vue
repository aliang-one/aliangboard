<script setup>
// 文件浏览（弹窗壳）：复用 FileBrowserBody，仅在概览/Pod 操作的「文件」按钮以弹窗形式打开。
import { computed } from 'vue'
import Modal from './Modal.vue'
import FileBrowserBody from './FileBrowserBody.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const open = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })
</script>

<template>
  <Modal v-model="open" :title="`文件管理 · ${pod}${container ? ' / ' + container : ''}`" width="max-w-4xl">
    <FileBrowserBody :namespace="namespace" :pod="pod" :container="container" style="height: 62vh" />
  </Modal>
</template>
