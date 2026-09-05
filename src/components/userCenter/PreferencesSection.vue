<script setup>
// 偏好卡(2026-09-04 Wave1 §3.1,自 UserProfile.vue 原样迁入):语言/主题选择联动 preferences store。
// Wave1 §3.4 偏好丰富化:落地页/每页行数/默认集群/默认 Namespace。
import { ref, onMounted } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import { authApi } from '@/api/client'

const prefs = usePreferencesStore()

const landingModel = ref(prefs.landingView || 'cluster')
const rowsModel = ref(prefs.rowsPerPage || 10)
const clusterModel = ref(prefs.defaultClusterId || '')
const nsModel = ref(prefs.defaultNamespace || '')
const clusters = ref([])
onMounted(() => {
  // 选项=已分配集群(与 tryAutoConnect 的 defaultClusterId 消费闭环,语义与服务端交集一致)
  authApi.myClusters().then(r => { clusters.value = r.clusters || [] }).catch(() => {})
})

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
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefLanding') }}</p>
        <select v-model="landingModel" data-testid="pref-landing" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setLandingView(landingModel)">
          <option value="cluster">{{ $t('userCenter.landingCluster') }}</option>
          <option value="workbench">{{ $t('userCenter.landingWorkbench') }}</option>
          <option value="last">{{ $t('userCenter.landingLast') }}</option>
        </select>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefRows') }}</p>
        <select v-model="rowsModel" data-testid="pref-rows" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setRowsPerPage(Number(rowsModel))">
          <option v-for="n in [10, 20, 50, 100]" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div>
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefDefaultCluster') }}</p>
        <select v-model="clusterModel" data-testid="pref-default-cluster" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setDefaultClusterId(clusterModel || null)">
          <option value="">{{ $t('userCenter.prefNone') }}</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="sm:col-span-2">
        <p class="text-body-xs text-on-surface-variant mb-xs">{{ $t('userCenter.prefDefaultNs') }}</p>
        <input v-model="nsModel" data-testid="pref-default-ns" placeholder="default" maxlength="63"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" @change="prefs.setDefaultNamespace(nsModel || null)" />
        <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('userCenter.prefDefaultNsHint') }}</p>
      </div>
    </div>
  </div>
</template>
