<script setup>
// 工作台 V2 shell(P1):右上角入口 → 全屏 tab(项目/配置/全局)。
// 项目 tab 内嵌 WorkbenchProjects(卡片网格);配置 tab 内嵌 WorkbenchConfig(只读);
// 全局 tab 内嵌 WorkbenchLedger(台账)。
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import WorkbenchProjects from './WorkbenchProjects.vue'
import WorkbenchConfig from './WorkbenchConfig.vue'
import WorkbenchLedger from './WorkbenchLedger.vue'
import WorkbenchRecords from './WorkbenchRecords.vue'
import WorkbenchServers from './WorkbenchServers.vue'

const router = useRouter()
const { t } = useI18n()
const activeTab = ref('projects')
const tabs = [
  { key: 'projects', label: t('workbench.shell.tabProjects'), icon: 'folder' },
  { key: 'config', label: t('workbench.shell.tabConfig'), icon: 'settings' },
  { key: 'global', label: t('workbench.shell.tabGlobal'), icon: 'public' },
  { key: 'records', label: t('workbench.shell.tabRecords'), icon: 'history' },
  { key: 'servers', label: t('workbench.shell.tabServers'), icon: 'dns' },
]
</script>

<template>
  <section class="animate-fade-in h-full min-h-0 flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between px-md py-sm border-b border-outline-variant bg-surface-container-lowest">
      <div class="flex items-center gap-md">
        <button @click="router.push('/cluster')" class="flex items-center gap-xs text-on-surface-variant hover:text-primary transition-colors">
          <span class="material-symbols-outlined text-lg">arrow_back</span>
          <span class="text-body-sm">{{ t('workbench.shell.backToCluster') }}</span>
        </button>
        <span class="text-on-surface-variant/30">|</span>
        <h2 class="text-headline-sm font-bold text-on-surface">{{ t('workbench.shell.title') }}</h2>
      </div>
    </div>
    <!-- Tabs -->
    <div class="flex gap-xs px-md py-sm bg-surface-container-lowest border-b border-outline-variant">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
        :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
        {{ tab.label }}
      </button>
    </div>
    <!-- Content -->
    <div class="flex-1 p-md overflow-y-auto">
      <WorkbenchProjects v-if="activeTab === 'projects'" />
      <WorkbenchConfig v-else-if="activeTab === 'config'" />
      <WorkbenchLedger v-else-if="activeTab === 'global'" />
      <WorkbenchRecords v-else-if="activeTab === 'records'" />
      <WorkbenchServers v-else-if="activeTab === 'servers'" @open-files="s => {}" />
    </div>
  </section>
</template>
