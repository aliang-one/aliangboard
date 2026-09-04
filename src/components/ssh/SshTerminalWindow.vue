<script setup>
// SSH 浮动终端窗口:FloatingWindow 壳 + SshTerminal。壳层标题栏不再重复终端头部已有的
// 服务器名与关闭钮(2026-09-04 关闭钮迁移):壳层关闭钮隐藏(closable=false),关闭入口
// 收敛到终端头部(Live/刷新旁,杀会话 = 显式关闭按钮专属语义);「新标签页」入口保留壳层。
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import FloatingWindow from '@/components/common/FloatingWindow.vue'
import SshTerminal from './SshTerminal.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'

const { t } = useI18n()
const props = defineProps({ window: { type: Object, required: true } })
const sshStore = useSshTerminalStore()
const termRef = ref(null)

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
    :z-index="window.zIndex" icon="terminal" width="720px" height="460px"
    :cascade-index="sshStore.openWindows.indexOf(window)"
    :maximize-title="t('terminal.maximizeTitle')" :minimize-title="t('terminal.minimizeTitle')"
    :closable="false"
    @focus="sshStore.focusWindow(window.id)"
    @minimize="sshStore.minimizeWindow(window.id)"
  >
    <template #title-actions>
      <button @click="sshStore.openExternal(window.id)" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant hover:text-secondary relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" data-test="btnOpenExternal" :title="t('terminal.openInNewTabTitle')">
        <span class="material-symbols-outlined text-base">open_in_new</span>
      </button>
    </template>
    <SshTerminal ref="termRef" :server-id="window.serverId" :server-name="window.name" :sid="window.id" :auto-connect="connectAtMount" closable @close="sshStore.closeWindow(window.id)" />
  </FloatingWindow>
</template>
