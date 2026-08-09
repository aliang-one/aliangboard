<script setup>
// 独立终端弹窗页面（新浏览器标签页打开）：全屏 xterm，无侧栏/顶栏。
// URL: /terminal-popup?ns=xxx&pod=xxx&container=xxx&name=xxx
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import InteractiveTerminal from '@/components/common/InteractiveTerminal.vue'
import { useClusterStore } from '@/stores/cluster'

const { t } = useI18n()
const route = useRoute()
const store = useClusterStore()
// 从 URL query 读取终端上下文
const ns = computed(() => route.query.ns || '')
const pod = computed(() => route.query.pod || '')
const container = computed(() => route.query.container || '')
const name = computed(() => route.query.name || 'terminal')

// 设置页面标题
document.title = t('terminal.title', { name: name.value })
// session token 已由 main.js 从 URL 写入 sessionStorage；验证存在
const hasToken = sessionStorage.getItem('aliangboard.session')
if (!hasToken) {
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0b1c30;color:#cfe3ff;font-family:monospace;font-size:14px">${t('terminal.expired')}</div>`
} else {
  if (ns.value) store.setNamespace(ns.value)
}
</script>

<template>
  <div class="h-screen w-screen flex flex-col bg-[#0b1c30]">
    <!-- 顶部条（终端名 + 关闭） -->
    <div class="flex items-center gap-sm px-md shrink-0 bg-surface-container-high border-b border-outline-variant" style="height: 36px">
      <span class="material-symbols-outlined text-base text-primary">terminal</span>
      <span class="text-body-sm font-medium text-on-surface truncate flex-1">{{ name }}</span>
      <span class="text-body-xs text-on-surface-variant/60 font-mono">{{ ns }}/{{ pod }}{{ container ? ':' + container : '' }}</span>
      <button @click="window.close()" class="flex items-center gap-xs px-sm py-0.5 rounded-md bg-error/10 text-error hover:bg-error/20 text-body-xs font-medium transition-colors shrink-0">
        <span class="material-symbols-outlined text-sm">close</span>{{ t('terminal.closeWindow') }}
      </button>
    </div>
    <!-- 全屏终端 -->
    <div class="flex-1 min-h-0">
      <InteractiveTerminal class="h-full" :pod-name="pod" :namespace="ns" :container="container || 'main'" :auto-connect="true" />
    </div>
  </div>
</template>
