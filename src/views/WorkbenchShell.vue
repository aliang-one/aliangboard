<script setup>
// 工作台 shell(2026-08-29 双域化):四 tab——项目(集群域工作单元)/服务器(服务器域,admin)/
// 知识(跨域知识:集群台账+服务器台账)/记录(跨域记录)。tab 为组件内状态,无路由影响。
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import WorkbenchProjects from './WorkbenchProjects.vue'
import WorkbenchLedger from './WorkbenchLedger.vue'
import WorkbenchRecords from './WorkbenchRecords.vue'
import WorkbenchServers from './WorkbenchServers.vue'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()
const activeTab = ref('projects')
onMounted(() => {
  // 顶栏胶囊快捷区落点(2026-08-30 spec §4.3):一次性读 query;tab 仍是组件内状态,不做双向路由同步
  const tab = route.query.tab
  if (typeof tab === 'string' && tabs.value.some(x => x.key === tab)) activeTab.value = tab
})
const tabs = computed(() => [
  { key: 'projects', label: t('workbench.shell.tabProjects'), icon: 'folder' },
  ...(auth.isAdmin ? [{ key: 'servers', label: t('workbench.shell.tabServers'), icon: 'dns' }] : []),
  { key: 'knowledge', label: t('workbench.shell.tabKnowledge'), icon: 'menu_book' },
  { key: 'records', label: t('workbench.shell.tabRecords'), icon: 'history' },
])
</script>

<template>
  <!-- 入场动效(2026-09-05 转场批次):根节点不再挂 animate-fade-in(与 AppLayout 路由转场
       叠加是双重淡入),分层入场交给 header/tabs 的 wb-rise stagger;pane 以 :key=activeTab
       挂 wb-rise——tab 切换即重挂重播(纯 class 动画,不用 Transition:happy-dom 无
       transitionend,零测试竞态)。animate-none 兜底安全:静止态=自然态,无 fill 依赖 -->
  <section class="h-full min-h-0 flex flex-col">
    <!-- Header -->
    <div class="animate-wb-rise motion-reduce:animate-none flex items-center justify-between px-md py-sm border-b border-outline-variant bg-surface-container-lowest">
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
    <div class="animate-wb-rise motion-reduce:animate-none [animation-delay:40ms] flex gap-xs px-md py-sm bg-surface-container-lowest border-b border-outline-variant">
      <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
        class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
        :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
        <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
        {{ tab.label }}
      </button>
    </div>
    <!-- Content:pane 包装层 keyed by activeTab——切 tab 即重播入场 -->
    <div class="flex-1 p-md overflow-y-auto">
      <div :key="activeTab" class="animate-wb-rise motion-reduce:animate-none">
        <WorkbenchProjects v-if="activeTab === 'projects'" :open-create="route.query.create === '1'" />
        <WorkbenchLedger v-else-if="activeTab === 'knowledge'" />
        <WorkbenchRecords v-else-if="activeTab === 'records'" />
        <WorkbenchServers v-else-if="activeTab === 'servers'" @open-files="s => {}" />
      </div>
    </div>
  </section>
</template>
