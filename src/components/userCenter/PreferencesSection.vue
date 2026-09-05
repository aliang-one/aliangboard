<script setup>
// 偏好卡(2026-09-04 Wave1 §3.1,自 UserProfile.vue 原样迁入):语言/主题选择联动 preferences store。
import { usePreferencesStore } from '@/stores/preferences'

const prefs = usePreferencesStore()

const langOptions = [{ v: 'zh', key: 'userCenter.langZh' }, { v: 'en', key: 'userCenter.langEn' }]
const themeOptions = [{ v: 'light', icon: 'light_mode', key: 'userCenter.themeLight' }, { v: 'dark', icon: 'dark_mode', key: 'userCenter.themeDark' }, { v: 'auto', icon: 'schedule', key: 'userCenter.themeAuto' }]
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <h3 class="text-headline-sm font-bold mb-md">{{ $t('userCenter.preferencesTitle') }}</h3>
    <div class="grid gap-md sm:grid-cols-2">
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.language') }}</p>
        <div class="flex gap-xs">
          <button v-for="o in langOptions" :key="o.v" :data-testid="`pref-lang-${o.v}`"
            class="px-md py-sm rounded-lg border text-body-sm"
            :class="prefs.language === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
            @click="prefs.setLanguage(o.v)">{{ $t(o.key) }}</button>
        </div>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.theme') }}</p>
        <div class="flex gap-xs">
          <button v-for="o in themeOptions" :key="o.v" :data-testid="`pref-theme-${o.v}`"
            class="flex items-center gap-xs px-md py-sm rounded-lg border text-body-sm"
            :class="prefs.theme === o.v ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'"
            @click="prefs.setTheme(o.v)">
            <span class="material-symbols-outlined text-base">{{ o.icon }}</span>{{ $t(o.key) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
