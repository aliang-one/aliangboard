<script setup>
// 浮动终端窗口:FloatingWindow 无头壳 + InteractiveTerminal 单行头部。
// 2026-09-08 单行头部收编:壳层标题栏整体退役(headerless),窗口控制权全在终端头部
// ●●● 圆点(红=杀会话+摘记录,黄=最小化到任务栏,绿=最大化/还原)+ open_in_new +
// 双击改名(显示名=terminal.name);拖拽把手=终端头部(data-window-drag 委托)。
import { ref, watch, nextTick } from 'vue'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { useTerminalStore } from '@/stores/terminals'

const props = defineProps({ terminal: { type: Object, required: true } })
const termStore = useTerminalStore()
const termRef = ref(null)
const floatRef = ref(null)     // FloatingWindow 实例:绿点 → toggleMaximize 程序化入口
const isMax = ref(false)       // 壳层 maximize-change 回灌,驱动绿点字形

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
</script>

<template>
  <FloatingWindow
    ref="floatRef"
    :z-index="terminal.zIndex" width="720px" height="460px"
    :cascade-index="termStore.terminals.indexOf(terminal)"
    :headerless="true"
    @focus="termStore.focusTerminal(terminal.id)"
    @minimize="termStore.minimizeTerminal(terminal.id)"
    @maximize-change="isMax = $event"
  >
    <InteractiveTerminal ref="termRef" :pod-name="terminal.podName" :namespace="terminal.namespace"
      :container="terminal.container" :session-id="terminal.id" :auto-connect="connectAtMount"
      chrome="window" :title="terminal.name" :maximized="isMax"
      @win-close="termStore.closeTerminal(terminal.id)"
      @win-minimize="termStore.minimizeTerminal(terminal.id)"
      @win-maximize="floatRef?.toggleMaximize()"
      @open-external="termStore.openExternal(terminal.id)"
      @rename="v => termStore.renameTerminal(terminal.id, v)" />
  </FloatingWindow>
</template>
