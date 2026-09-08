<script setup>
// 独立页(登录/选集群)右上角语言切换(2026-09-08 round-2):这两页无应用壳,
// 用户菜单里的语言入口不可达——看不懂中文的用户在登录页就需要换语言。
// 语义与 UserMenu 分段按钮一致:preferences.setLanguage(本地 setLocale 即时生效 +
// 服务端同步;登录前 savePreferences 401 被 catch,本地已生效)。壳内页仍走 UserMenu。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferencesStore } from '@/stores/preferences'

const { t } = useI18n()
const prefs = usePreferencesStore()
const options = [
  { v: 'zh', key: 'userCenter.langZh' },
  { v: 'en', key: 'userCenter.langEn' },
]
const activeLang = computed(() => prefs.language || 'zh')
</script>

<template>
  <div data-testid="locale-toggle"
    class="flex items-center gap-xs rounded-full border border-outline-variant bg-surface-container-lowest p-xs">
    <button v-for="o in options" :key="o.v" :data-testid="`locale-toggle-${o.v}`"
      class="px-sm py-xs rounded-full text-body-xs font-medium whitespace-nowrap transition-colors cursor-pointer"
      :class="activeLang === o.v ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'"
      @click="prefs.setLanguage(o.v)">{{ t(o.key) }}</button>
  </div>
</template>
