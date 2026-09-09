<script setup>
// 用户中心壳(2026-09-04 Wave1 §3.1):五 tab(资料/安全/活动/访问令牌/偏好),tab 状态走 ?tab= 可直达。
// 平台层页面(requiresCluster:false,无集群也能进);仅头像菜单进入,侧边栏不加入口。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ProfileSection from '@/components/userCenter/ProfileSection.vue'
import SecuritySection from '@/components/userCenter/SecuritySection.vue'
import ActivitySection from '@/components/userCenter/ActivitySection.vue'
import PreferencesSection from '@/components/userCenter/PreferencesSection.vue'
import TokensSection from '@/components/userCenter/TokensSection.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const TABS = [
  { key: 'profile', icon: 'person', labelKey: 'userCenter.tabProfile' },
  { key: 'security', icon: 'shield', labelKey: 'userCenter.tabSecurity' },
  { key: 'activity', icon: 'history', labelKey: 'userCenter.tabActivity' },
  { key: 'tokens', icon: 'key', labelKey: 'userCenter.tabTokens' },
  { key: 'preferences', icon: 'tune', labelKey: 'userCenter.tabPreferences' },
]
const activeTab = computed(() => (TABS.some(x => x.key === route.query.tab) ? route.query.tab : 'profile'))
function switchTab(key) { router.replace({ query: { ...route.query, tab: key } }) }
</script>

<template>
  <section class="animate-fade-in p-md max-w-3xl mx-auto flex flex-col gap-md">
    <div><h2 class="text-headline-lg font-bold text-on-surface">{{ $t('userCenter.title') }}</h2>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ $t('userCenter.subtitle') }}</p></div>

    <div class="flex gap-xs overflow-x-auto border-b border-outline-variant" data-testid="profile-tabs">
      <button v-for="tab in TABS" :key="tab.key" :data-testid="`profile-tab-${tab.key}`"
        class="flex items-center gap-xs px-md py-sm text-body-sm border-b-2 transition-colors shrink-0 whitespace-nowrap"
        :class="activeTab === tab.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-on-surface-variant hover:text-on-surface'"
        @click="switchTab(tab.key)">
        <span class="material-symbols-outlined text-base">{{ tab.icon }}</span>{{ $t(tab.labelKey) }}
      </button>
    </div>

    <ProfileSection v-if="activeTab === 'profile'" />
    <SecuritySection v-else-if="activeTab === 'security'" />
    <ActivitySection v-else-if="activeTab === 'activity'" />
    <TokensSection v-else-if="activeTab === 'tokens'" />
    <PreferencesSection v-else-if="activeTab === 'preferences'" />
  </section>
</template>
