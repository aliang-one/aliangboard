<script setup>
// SSH 终端独立弹窗页(新浏览器标签页打开):全屏 xterm,无侧栏/顶栏。
// URL: /ssh-terminal-popup?serverId=xxx&sid=xxx&name=xxx
// 平台 token 走 localStorage(同源新标签页自动可用),SshTerminal→sshTerminalStream 自取。
// 同 sid + 网关保活 → 打开即回放续跑(比 pod 的 per-connection exec 更顺)。
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import SshTerminal from '@/components/ssh/SshTerminal.vue'

const { t } = useI18n()
const route = useRoute()
const serverId = computed(() => route.query.serverId || '')
const sid = computed(() => route.query.sid || '')
const name = computed(() => route.query.name || serverId.value || 'SSH')

document.title = t('ssh.popupTitle', { name: name.value })
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-code-surface">
    <div class="flex items-center gap-sm px-md shrink-0 bg-surface-container-high border-b border-outline-variant" style="height: 36px">
      <span class="material-symbols-outlined text-base text-secondary">dns</span>
      <span class="text-body-sm font-medium text-on-surface truncate flex-1 font-mono">ssh://{{ name }}</span>
      <button @click="window.close()" class="flex items-center gap-xs px-sm py-0.5 rounded-md bg-error/10 text-error hover:bg-error/20 text-body-xs font-medium transition-colors shrink-0">
        <span class="material-symbols-outlined text-sm">close</span>{{ t('terminal.closeWindow') }}
      </button>
    </div>
    <div class="flex-1 min-h-0">
      <SshTerminal :server-id="serverId" :server-name="name" :sid="sid" :auto-connect="true" />
    </div>
  </div>
</template>
