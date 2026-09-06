<script setup>
// 浮动终端窗口:FloatingWindow 壳 + InteractiveTerminal。改名(双击标题)/新标签页在插槽注入。
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { useTerminalStore } from '@/stores/terminals'

const { t } = useI18n()
const props = defineProps({ terminal: { type: Object, required: true } })
const termStore = useTerminalStore()
const termRef = ref(null)

const editing = ref(false)
const nameInput = ref(props.terminal.name)

// minimized → open:xterm 重新 fit(display:none→block 时 ResizeObserver 可能漏触发)
// + 按需建连(2026-09-05 P1:镜像 SshTerminalWindow 配方——minimized 挂载不自动连,恢复时
// connectIfIdle 补连。此前硬编码 auto-connect=true,刷新后全部历史窗口(含用户没点的)各自
// 静默开一条 exec/tmux,死 sid 还会被同 sid 新建 shell=「chip 在内容全新」)
const connectAtMount = props.terminal.status === 'open'
let refitTimer = null
watch(() => props.terminal.status, (s) => {
  if (s === 'open') {
    if (refitTimer) clearTimeout(refitTimer)
    nextTick(() => {
      refitTimer = setTimeout(() => {
        try { termRef.value?.refit() } catch { /* noop */ }
        try { termRef.value?.connectIfIdle?.() } catch { /* noop */ }
        refitTimer = null
      }, 50)
    })
  }
})

function saveName() {
  const v = nameInput.value.trim()
  if (v && v !== props.terminal.name) termStore.renameTerminal(props.terminal.id, v)
  editing.value = false
}
</script>

<template>
  <FloatingWindow
    :z-index="terminal.zIndex" icon="terminal" width="720px" height="460px"
    :cascade-index="termStore.terminals.indexOf(terminal)"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')" :close-title="t('terminal.closeTerminalTitle')"
    @focus="termStore.focusTerminal(terminal.id)"
    @minimize="termStore.minimizeTerminal(terminal.id)"
    @close="termStore.closeTerminal(terminal.id)"
  >
    <template #title>
      <input v-if="editing" v-model="nameInput" @blur="saveName" @keydown.enter="saveName" @keydown.esc="editing = false"
             class="flex-1 bg-surface-container-lowest border border-primary rounded px-sm py-0.5 text-body-sm font-mono focus:outline-none" />
      <span v-else @dblclick="editing = true; nameInput = terminal.name" class="flex-1 text-body-sm font-medium text-on-surface truncate" :title="t('terminal.dblClickRename', { name: terminal.name })">
        {{ terminal.name.length > 30 ? terminal.name.slice(0, 28) + '…' : terminal.name }}
        <span class="text-on-surface-variant/50 text-body-xs ml-xs">{{ terminal.namespace }}</span>
      </span>
    </template>
    <template #title-actions>
      <button @click="termStore.openExternal(terminal.id)" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-primary" :title="t('terminal.openInNewTabTitle')">
        <span class="material-symbols-outlined text-base">open_in_new</span>
      </button>
    </template>
    <InteractiveTerminal ref="termRef" :pod-name="terminal.podName" :namespace="terminal.namespace" :container="terminal.container" :session-id="terminal.id" :auto-connect="connectAtMount" />
  </FloatingWindow>
</template>
