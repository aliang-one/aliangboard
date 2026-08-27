<script setup>
// Settings「关于」面板:平台自身版本信息 + 更新检测(常驻,与顶栏横幅互补)。
// 数据经 useAppVersion(['app-version'] 共享缓存);检测失败=latest:null 灰字降级,不是错误。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppVersion } from '@/composables/useAppVersion'

const { t } = useI18n()
const { query, checkNow } = useAppVersion()

const checking = ref(false)
const copied = ref(false)

const current = computed(() => query.data.value?.current || 'dev')
const latest = computed(() => query.data.value?.latest || null)
const loaded = computed(() => !!query.data.value)
const isDev = computed(() => current.value === 'dev')

async function onCheck() {
  checking.value = true
  try { await checkNow() } finally { checking.value = false }
}

// 升级指引:镜像 tag = 规范形(与 CI semver 产物一致,无 v 前缀);deployment.yaml 现状单副本 latest
const cmd = computed(() => latest.value
  ? `kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:${latest.value} -n aliangboard`
  : '')

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(cmd.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* 剪贴板不可用:忽略,用户可手动选择 */ }
}
</script>

<template>
  <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
    <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
      <span class="material-symbols-outlined text-primary text-lg">update</span>
      <span class="text-body-sm font-semibold">{{ t('settings.about.title') }}</span>
    </div>
    <div class="p-md space-y-md">
      <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.currentVersion') }}</span>
        <span class="flex items-center gap-sm">
          <span class="font-mono text-code-sm">{{ isDev ? 'dev' : `v${current}` }}</span>
          <span v-if="isDev" class="px-sm py-xs rounded-md bg-surface-container text-on-surface-variant text-xs">{{ t('settings.about.devBuild') }}</span>
        </span>
      </div>
      <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.latestVersion') }}</span>
        <span v-if="latest" class="font-mono text-code-sm">{{ `v${latest}` }}</span>
        <span v-else-if="loaded" class="text-on-surface-variant text-body-sm">{{ t('settings.about.checkFailed') }}</span>
        <span v-else class="text-on-surface-variant text-body-sm">{{ t('settings.about.checking') }}</span>
      </div>
      <div class="flex justify-between items-center py-sm">
        <span class="text-body-sm text-on-surface-variant">{{ t('settings.about.upgradeGuide') }}</span>
        <button data-test="check-now" @click="onCheck" :disabled="checking"
          class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50">
          <span class="material-symbols-outlined text-sm" :class="checking ? 'animate-spin' : ''">refresh</span>
          {{ checking ? t('settings.about.checking') : t('settings.about.checkNow') }}
        </button>
      </div>
      <div v-if="cmd" class="rounded-lg bg-surface-container-low p-sm flex items-center gap-sm">
        <code class="flex-1 font-mono text-code-sm break-all">{{ cmd }}</code>
        <button @click="copyCmd" class="material-symbols-outlined text-base hover:text-primary cursor-pointer"
          :aria-label="t('settings.about.copyCommand')">{{ copied ? 'check' : 'content_copy' }}</button>
      </div>
    </div>
  </div>
</template>
