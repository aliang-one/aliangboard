<script setup>
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { useTableColumns } from '@/composables/useTableColumns'
import { i18n, setLocale } from '@/i18n'

const { t } = useI18n()

const store = useClusterStore()
const activeTab = ref('general')

const tabs = computed(() => [
  { key: 'general', label: t('settings.tabs.general'), icon: 'info' },
  { key: 'components', label: t('settings.tabs.components'), icon: 'extension' },
  { key: 'api', label: t('settings.tabs.api'), icon: 'api' },
  { key: 'customcols', label: t('settings.tabs.customcols'), icon: 'view_column' },
])

// Static components for demo data mode (shown when no backend connection, to avoid blank display)
const demoComponents = [
  { name: 'etcd', status: 'Healthy', message: '' },
  { name: 'kube-apiserver', status: 'Healthy', message: '' },
  { name: 'kube-controller-manager', status: 'Healthy', message: '' },
  { name: 'kube-scheduler', status: 'Healthy', message: '' },
]

// === Components: real cluster component health ===
const components = ref([])
const apiReady = ref(null)        // null=unknown, true=ready, false=not ready
const csState = ref('idle')       // 'idle' | 'loading' | 'loaded' | 'error'
const csError = ref('')

async function loadComponents() {
  if (!store.remoteMode) { csState.value = 'loaded'; return }   // demo mode: use demoComponents
  csState.value = 'loading'
  csError.value = ''
  // API Server readiness probe (/readyz returns 200 'ok' means healthy; componentstatuses deprecated since K8s 1.19)
  try { await api.k8s('/readyz'); apiReady.value = true } catch { apiReady.value = false }
  // Control plane component health (componentstatuses; most modern clusters return empty or Unhealthy, so readyz is the primary signal)
  try {
    const data = await api.k8s('/api/v1/componentstatuses')
    components.value = (data.items || []).map(it => {
      const cond = (it.conditions || []).find(c => c.type === 'Healthy') || (it.conditions || [])[0]
      return {
        name: it.metadata?.name,
        status: cond?.status === 'True' ? 'Healthy' : 'Unhealthy',
        message: cond?.message || '',
      }
    })
    csState.value = 'loaded'
  } catch (e) {
    csState.value = 'error'
    csError.value = e.message || 'Failed to read component status'
  }
}

watch(activeTab, tab => { if (tab === 'components' && csState.value === 'idle') loadComponents() })
onMounted(() => { if (activeTab.value === 'components') loadComponents() })

// === Custom Columns: toggleable columns + localStorage persistence (instant effect) ===
const { catalog, isHidden, toggle, resetTable, resetAll } = useTableColumns()
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">{{ t('settings.title') }}</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ t('settings.subtitle') }}</p>
      </div>
    </div>

    <div class="grid grid-cols-12 gap-md">
      <!-- Sidebar Tabs -->
      <div class="col-span-12 lg:col-span-3">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-sm">
          <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
            class="w-full flex items-center gap-sm px-sm py-1.5 rounded-lg text-body-sm transition-all"
            :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'"
          >
            <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="col-span-12 lg:col-span-9">
        <!-- General -->
        <div v-if="activeTab === 'general'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">info</span>
            <span class="text-body-sm font-semibold">{{ t('settings.clusterInfo') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- Language -->
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.language') }}</span>
              <div class="flex items-center gap-xs">
                <button @click="setLocale('zh')" :class="i18n.global.locale.value === 'zh' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'" class="text-xs px-sm py-xs rounded-md transition-colors">中文</button>
                <button @click="setLocale('en')" :class="i18n.global.locale.value === 'en' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'" class="text-xs px-sm py-xs rounded-md transition-colors">EN</button>
              </div>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.clusterName') }}</span>
              <span class="text-body-sm font-medium">{{ store.cluster.name }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.kubernetesVersion') }}</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.apiServer') }}</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.status') }}</span>
              <span class="flex items-center gap-sm text-primary font-medium">
                <span class="w-2 h-2 bg-primary rounded-full animate-pulse-status"></span> {{ store.cluster.status }}
              </span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.nodes') }}</span>
              <span class="font-medium">{{ store.cluster.nodeCount }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.pods') }}</span>
              <span class="font-medium">{{ store.cluster.podCount }}</span>
            </div>
          </div>
        </div>

        <!-- Components -->
        <div v-if="activeTab === 'components'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">extension</span>
              <span class="text-body-sm font-semibold">{{ t('settings.componentStatus') }}</span>
            </div>
            <button v-if="store.remoteMode" @click="loadComponents" :disabled="csState === 'loading'"
              class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50">
              <span class="material-symbols-outlined text-sm" :class="csState === 'loading' ? 'animate-spin' : ''">refresh</span>
              {{ t('settings.refresh') }}
            </button>
          </div>

          <!-- 演示模式提示 -->
          <div v-if="!store.remoteMode" class="mx-md mt-md mb-sm flex items-center gap-sm bg-tertiary-container/10 border border-tertiary/30 rounded-lg px-md py-sm">
            <span class="material-symbols-outlined text-tertiary-container text-base">info</span>
            <span class="text-xs text-on-surface-variant">{{ t('settings.demoModeHint') }}</span>
          </div>

          <!-- API Server 就绪探针 -->
          <div v-if="store.remoteMode" class="mx-md mb-sm flex items-center justify-between bg-surface-container-low rounded-lg px-md py-sm border border-outline-variant/50">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-on-surface-variant text-sm">api</span>
              <span class="text-body-sm font-medium">{{ t('settings.apiServerProbe') }}</span>
            </div>
            <span v-if="apiReady === null" class="text-xs text-on-surface-variant">{{ t('settings.detecting') }}</span>
            <span v-else-if="apiReady" class="flex items-center gap-sm text-primary font-medium text-xs">
              <span class="w-2 h-2 bg-primary rounded-full"></span> {{ t('settings.ready') }}
            </span>
            <span v-else class="flex items-center gap-sm text-error font-medium text-xs">
              <span class="w-2 h-2 bg-error rounded-full"></span> {{ t('settings.notReady') }}
            </span>
          </div>

          <!-- 加载 / 错误 / 表格 -->
          <div v-if="csState === 'loading'" class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined animate-spin">progress_activity</span>
            <p class="text-body-sm mt-xs">{{ t('settings.loadingComponent') }}</p>
          </div>
          <div v-else-if="csState === 'error'" class="p-md text-center">
            <span class="material-symbols-outlined text-error">error</span>
            <p class="text-body-sm text-error mt-xs">{{ csError }}</p>
            <button @click="loadComponents" class="mt-md px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">{{ t('settings.retry') }}</button>
          </div>
          <table v-else class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low/50 border-b border-outline-variant">
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('settings.component') }}</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('settings.componentStatus') }}</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">{{ t('settings.message') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              <tr v-for="c in (store.remoteMode ? components : demoComponents)" :key="c.name" class="hover:bg-surface-container-low/40">
                <td class="px-md py-2 text-body-sm font-medium">{{ c.name }}</td>
                <td class="px-md py-2">
                  <span class="flex items-center gap-sm">
                    <span class="w-2 h-2 rounded-full" :class="c.status === 'Healthy' ? 'bg-primary' : 'bg-error'"></span>
                    <span class="text-xs font-medium" :class="c.status === 'Healthy' ? 'text-primary' : 'text-error'">{{ c.status }}</span>
                  </span>
                </td>
                <td class="px-md py-2 font-mono text-code-sm text-on-surface-variant">{{ c.message || '—' }}</td>
              </tr>
              <tr v-if="store.remoteMode && !components.length">
                <td colspan="3" class="px-md py-md text-center text-on-surface-variant text-body-sm">
                  {{ t('settings.noComponents') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- API Server -->
        <div v-if="activeTab === 'api'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">api</span>
            <span class="text-body-sm font-semibold">{{ t('settings.apiConfig') }}</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.endpoint') }}</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.authentication') }}</span>
              <span class="text-body-sm">{{ t('settings.authMethod') }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">{{ t('settings.apiVersion') }}</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version || 'v1' }}</span>
            </div>
          </div>
        </div>

        <!-- Custom Columns -->
        <div v-if="activeTab === 'customcols'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">view_column</span>
              <span class="text-body-sm font-semibold">{{ t('settings.customDisplay') }}</span>
            </div>
            <button @click="resetAll" class="px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium text-on-surface-variant hover:bg-surface-container">{{ t('settings.resetAll') }}</button>
          </div>
          <div class="p-md space-y-sm">
            <p class="text-xs text-on-surface-variant">{{ t('settings.customDisplayDesc') }}</p>
            <div v-for="t in catalog" :key="t.key" class="border border-outline-variant/60 rounded-lg p-md">
              <div class="flex items-center justify-between mb-sm">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-sm">{{ t.icon }}</span>
                  <span class="text-body-sm font-semibold">{{ t.label }}</span>
                </div>
                <button @click="resetTable(t.key)" class="text-xs text-on-surface-variant hover:text-primary">{{ t('settings.reset') }}</button>
              </div>
              <div class="flex flex-wrap gap-xs">
                <label v-for="col in t.columns" :key="col.key"
                  class="flex items-center gap-xs px-md py-xs rounded-lg border cursor-pointer transition-colors"
                  :class="isHidden(t.key, col.key) ? 'border-outline-variant text-on-surface-variant bg-surface-container-low' : 'border-primary/40 text-primary bg-primary-container/10'">
                  <input type="checkbox" :checked="!isHidden(t.key, col.key)" @change="toggle(t.key, col.key)" class="accent-[var(--md-sys-color-primary)]" />
                  <span class="text-xs">{{ col.label }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
