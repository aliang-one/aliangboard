<script setup>
// 文件浏览（弹窗壳）：复用 FileBrowserBody，仅在概览/Pod 操作的「文件」按钮以弹窗形式打开。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Modal from './Modal.vue'
import FileBrowserBody from './FileBrowserBody.vue'

const { t } = useI18n()

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  namespace: { type: String, default: '' },
  pod: { type: String, default: '' },
  container: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const open = computed({ get: () => props.modelValue, set: v => emit('update:modelValue', v) })
const title = computed(() => t('component.fileBrowser.title', { pod: props.pod, separator: props.container ? ' / ' : '', container: props.container }))
</script>

<template>
  <Modal v-model="open" :title="title" width="max-w-4xl">
    <FileBrowserBody :namespace="namespace" :pod="pod" :container="container" style="height: 62vh" />
  </Modal>
</template>
