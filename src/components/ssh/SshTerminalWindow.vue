<script setup>
// SSH 浮动终端窗口:FloatingWindow 无头壳 + SshTerminal 单行头部。
// 2026-09-08 单行头部收编:壳层标题栏整体退役(headerless),窗口控制权全在终端头部
// ●●● 圆点(红=杀会话+摘记录,黄=最小化到任务栏,绿=最大化/还原)+ open_in_new;
// 拖拽把手=终端头部(data-window-drag 委托)。此前 2026-09-04 只迁了关闭钮,标题栏仍在。
import { ref, watch, nextTick } from 'vue'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import SshTerminal from './SshTerminal.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'

const props = defineProps({ window: { type: Object, required: true } })
const sshStore = useSshTerminalStore()
const termRef = ref(null)
const floatRef = ref(null)     // FloatingWindow 实例:绿点 → toggleMaximize 程序化入口
const isMax = ref(false)       // 壳层 maximize-change 回灌,驱动绿点字形

// 挂载即连仅限「本页主动开窗」(status==='open')(2026-09-04 事故③):刷新恢复/重登录
// 载入的 minimized 窗口不建连——否则整页一刷新就对全部窗口各开一条 WS,其中已被网关
// 回收的 sid 会被静默同 sid 新建 shell(历史无感归零),且一次吃掉 N 条连接预算。
// 用户点任务栏恢复(minimized→open)时由下方 watcher 按需建连(connectIfIdle)。
const connectAtMount = props.window.status === 'open'

// minimized → open:xterm 重新 fit(display:none→block 时 ResizeObserver 可能漏触发)+ 按需建连
let refitTimer = null
watch(() => props.window.status, (s) => {
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
    :z-index="window.zIndex" width="720px" height="460px"
    :cascade-index="sshStore.openWindows.indexOf(window)"
    :headerless="true"
    @focus="sshStore.focusWindow(window.id)"
    @minimize="sshStore.minimizeWindow(window.id)"
    @maximize-change="isMax = $event"
  >
    <!-- 会话标签(2026-09-08):头部 ssh://label(有 label 时);标签经任务栏会话菜单改名 -->
    <SshTerminal ref="termRef" :server-id="window.serverId" :server-name="window.label || window.name" :sid="window.id"
      :auto-connect="connectAtMount" chrome="window" :maximized="isMax"
      @win-close="sshStore.closeWindow(window.id)"
      @win-minimize="sshStore.minimizeWindow(window.id)"
      @win-maximize="floatRef?.toggleMaximize()"
      @open-external="sshStore.openExternal(window.id)" />
  </FloatingWindow>
</template>
