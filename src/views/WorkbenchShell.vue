<script setup>
// 工作台 shell(2026-08-29 双域化;2026-09-12 spec §10 导航重排):常驻 tab——项目(集群域工作单元)/
// 服务器(服务器域,admin)/凭据(凭据域,admin);低频 知识/记录 收进「更多」▾(全员可见)。tab 为组件内状态,无路由影响。
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import WbStage from '@/components/workbench/WbStage.vue'
import WorkbenchProjects from './WorkbenchProjects.vue'
import WorkbenchLedger from './WorkbenchLedger.vue'
import WorkbenchRecords from './WorkbenchRecords.vue'
import WorkbenchServers from './WorkbenchServers.vue'
import WorkbenchCredentials from './WorkbenchCredentials.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()
const activeTab = ref('projects')
onMounted(() => {
  // 顶栏胶囊快捷区落点(2026-08-30 spec §4.3):一次性读 query;tab 仍是组件内状态,不做双向路由同步
  const tab = route.query.tab
  const all = [...tabs.value, ...moreTabs]
  if (typeof tab === 'string' && all.some(x => x.key === tab)) activeTab.value = tab
})
// 2026-09-12 导航改版(spec §10):高频 项目/服务器/凭据 常驻;低频 知识/记录 收进「更多」▾(全员可见)。
const tabs = computed(() => [
  { key: 'projects', label: t('workbench.shell.tabProjects'), icon: 'folder' },
  ...(auth.isAdmin ? [{ key: 'servers', label: t('workbench.shell.tabServers'), icon: 'dns' }] : []),
  ...(auth.isAdmin ? [{ key: 'credentials', label: t('workbench.shell.tabCredentials'), icon: 'key' }] : []),
])
const moreTabs = [
  { key: 'knowledge', label: t('workbench.shell.tabKnowledge'), icon: 'menu_book' },
  { key: 'records', label: t('workbench.shell.tabRecords'), icon: 'history' },
]
const moreActive = computed(() => moreTabs.find(x => x.key === activeTab.value) || null)
</script>

<template>
  <!-- 入场动效(2026-09-05 转场批次)延续:标题栏 wb-rise 立即 / tabs 40ms / pane 随切换重播。
       2026-09-05 模块身份(spec §3-4):根 section 降级为画布上的呼吸留白,内容坐进 WbStage;
       标题栏升级为模块门面——32px 品牌瓷砖(与顶栏 pill 瓷砖同配方,双绿渐变+内高光)挂载即播
       一次 sheen(工作台每次进入重挂,天然一次性),「入口瓷砖 → 模块 logo」的概念握手。 -->
  <section class="h-full min-h-0 p-md">
    <WbStage>
      <template #titleBar>
        <div class="animate-wb-rise motion-reduce:animate-none flex items-center justify-between gap-md pl-md pr-md py-sm border-b border-outline-variant/40">
          <div class="flex items-center gap-sm min-w-0">
            <span data-test="wb-facade-tile"
              class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-primary to-primary-container shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.35)]">
              <span class="material-symbols-outlined text-xl text-on-primary">workspaces</span>
              <span data-test="wb-facade-sheen" aria-hidden="true"
                class="absolute inset-0 bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
            </span>
            <h2 class="text-headline-sm font-bold text-on-surface">{{ t('workbench.shell.title') }}</h2>
          </div>
          <button @click="router.push('/cluster')" class="flex items-center gap-xs text-on-surface-variant hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-lg">arrow_back</span>
            <span class="text-body-sm">{{ t('workbench.shell.backToCluster') }}</span>
          </button>
        </div>
      </template>
      <!-- tab 条 R3 横滚(2026-09-09 Wave5 B7):手机四 tab 超宽时横向滚动可达,不再靠
           CJK 逐字换行硬挤;whitespace-nowrap 保 tab 名整词不断 -->
      <div class="animate-wb-rise motion-reduce:animate-none [animation-delay:40ms] flex gap-xs px-md py-sm border-b border-outline-variant/40 overflow-x-auto">
        <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
          class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all shrink-0 whitespace-nowrap"
          :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
          <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
          {{ tab.label }}
        </button>
        <!-- 更多▾(2026-09-12):低频 tab 收进共享 DropdownMenu(Teleport body+fixed 防裁配方);
             moreTabs 中的 tab 激活时触发器显示当前 tab 名,替代平铺高亮 -->
        <div class="ml-auto flex items-center shrink-0">
          <DropdownMenu trigger-icon="more_horiz" :trigger-label="moreActive ? moreActive.label : t('workbench.shell.more')"
            :items="moreTabs.map(x => ({ label: x.label, icon: x.icon, action: () => { activeTab = x.key } }))" />
        </div>
      </div>
      <div class="flex-1 min-h-0 p-md overflow-y-auto">
        <div :key="activeTab" class="animate-wb-rise motion-reduce:animate-none">
          <WorkbenchProjects v-if="activeTab === 'projects'" :open-create="route.query.create === '1'" />
          <WorkbenchLedger v-else-if="activeTab === 'knowledge'" />
          <WorkbenchRecords v-else-if="activeTab === 'records'" />
          <WorkbenchServers v-else-if="activeTab === 'servers'" @open-files="s => {}" />
          <WorkbenchCredentials v-else-if="activeTab === 'credentials'" />
        </div>
      </div>
    </WbStage>
  </section>
</template>
