<script setup>
// SSH 浮动文件浏览窗口:FloatingWindow 壳(860x540,参照 FileBrowserWindow)+ SshFileBrowserBody。
// props { serverId, name }:生命周期由 WorkbenchServers 的 sshBrowsers 数组管理(同机去重)。
import { useI18n } from 'vue-i18n'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import SshFileBrowserBody from './SshFileBrowserBody.vue'

const { t } = useI18n()
const props = defineProps({
  serverId: { type: String, required: true },
  name: { type: String, default: '' },
  zIndex: { type: Number, default: 100 },
  cascadeIndex: { type: Number, default: 0 },
})
const emit = defineEmits(['close'])
</script>

<template>
  <FloatingWindow
    :z-index="props.zIndex" icon="folder_open" width="860px" height="540px"
    :cascade-index="props.cascadeIndex"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('component.fileBrowser.closeTitle')"
    @close="emit('close')"
  >
    <template #title>
      <span class="flex-1 text-body-sm font-medium text-on-surface truncate">
        {{ t('ssh.fileTitle', { name: props.name }) }}
      </span>
    </template>
    <SshFileBrowserBody :server-id="props.serverId" :server-name="props.name" style="height: 100%" />
  </FloatingWindow>
</template>
