<script setup>
// 浮动文件浏览窗口:FloatingWindow 壳 + FileBrowserBody。最小化不销毁(v-show 由 AppLayout 控制),
// 树展开/选中状态保留;容器由打开方固定,窗口内不切换。
import { useI18n } from 'vue-i18n'
import FloatingWindow from './FloatingWindow.vue'
import FileBrowserBody from './FileBrowserBody.vue'
import { useFileBrowserStore } from '@/stores/fileBrowsers'

const { t } = useI18n()
const props = defineProps({ browser: { type: Object, required: true } })
const fbStore = useFileBrowserStore()
</script>

<template>
  <FloatingWindow
    :title="browser.name" :subtitle="browser.namespace" icon="folder_open"
    width="860px" height="540px" :z-index="browser.zIndex"
    :cascade-index="fbStore.browsers.indexOf(browser)"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('component.fileBrowser.closeTitle')"
    @focus="fbStore.focusBrowser(browser.id)"
    @minimize="fbStore.minimizeBrowser(browser.id)"
    @close="fbStore.closeBrowser(browser.id)"
  >
    <FileBrowserBody :namespace="browser.namespace" :pod="browser.podName" :container="browser.container" style="height: 100%" />
  </FloatingWindow>
</template>
