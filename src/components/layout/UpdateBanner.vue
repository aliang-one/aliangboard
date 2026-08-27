<script setup>
// 更新横幅:检测到新版本时显示(TopNavBar 下方,集群健康横幅同款样式、primary 色非 error 色)。
// 「横幅一次」= 每版本一次:关闭记 localStorage(ab.updateBannerDismissed=去 v 规范形),出现更新版本再弹。
// props 驱动(不自带 query),AppLayout 负责 useAppVersion 接线——便于独立测试。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({ latest: { type: String, default: null } })
const { t } = useI18n()

const DISMISS_KEY = 'ab.updateBannerDismissed'
// localStorage 非响应式,初始读一次,关闭后走 ref 更新
const dismissedNow = ref((() => { try { return localStorage.getItem(DISMISS_KEY) } catch { return null } })())
const visible = computed(() => !!props.latest && dismissedNow.value !== props.latest)

function dismiss() {
  dismissedNow.value = props.latest || ''
  try { localStorage.setItem(DISMISS_KEY, props.latest || '') } catch { /* 私隐模式:仅本次不显示 */ }
}
</script>

<template>
  <div v-if="visible"
    class="px-lg py-sm flex items-center gap-sm text-on-primary bg-primary/10 border-b border-primary/30 text-body-sm">
    <span class="material-symbols-outlined text-base">system_update_alt</span>
    <span>{{ t('layout.updateBanner.found') }} <span class="font-mono font-semibold">v{{ latest }}</span></span>
    <a href="https://github.com/aliang-one/aliangboard/tags" target="_blank" rel="noopener"
      class="underline underline-offset-2 hover:opacity-80">{{ t('layout.updateBanner.view') }}</a>
    <button :aria-label="t('layout.updateBanner.dismiss')" @click="dismiss"
      class="ml-auto material-symbols-outlined text-base hover:text-on-surface cursor-pointer">close</button>
  </div>
</template>
