<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { api, adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'
import { i18n, setLocale } from '@/i18n'

const { t } = useI18n()

const store = useClusterStore()
const auth = useAuthStore()
const activeTab = ref('general')

const tabs = computed(() => [
  { key: 'general', label: t('settings.tabs.general'), icon: 'info' },
  { key: 'components', label: t('settings.tabs.components'), icon: 'extension' },
  { key: 'api', label: t('settings.tabs.api'), icon: 'api' },
  { key: 'customcols', label: t('settings.tabs.customcols'), icon: 'view_column' },
  ...(auth.isAdmin ? [{ key: 'mcp', label: t('settings.tabs.mcp'), icon: 'hub' }] : []),
])

// === Components: real cluster component health ===
const components = ref([])
const apiReady = ref(null)        // null=unknown, true=ready, false=not ready
const csState = ref('idle')       // 'idle' | 'loading' | 'loaded' | 'error'
const csError = ref('')

async function loadComponents() {
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
onMounted(() => {
  if (activeTab.value === 'components') loadComponents()
  if (auth.isAdmin) loadMcpConfig()
})

// === MCP Service toggle (admin only) ===
const mcpEnabled = ref(true)
const mcpLoading = ref(false)
const mcpUrl = computed(() => window.location.origin + '/mcp')
// 可直接复制执行的客户端命令；<YOUR_API_KEY> 由用户替换为在「API Keys」签发的 key
const mcpAddCmd = computed(() =>
  `claude mcp add --transport http aliangboard ${mcpUrl.value} --header "Authorization: Bearer <YOUR_API_KEY>"`
)
const mcpRemoveCmd = 'claude mcp remove aliangboard'
const mcpInstallCliCmd = 'npm install -g @anthropic-ai/claude-code'
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notify('success', t('common.copySuccess')) }
  catch { notify('error', t('common.copyFailed')) }
}
async function loadMcpConfig() {
  try { const r = await adminApi.mcpConfig.get(); mcpEnabled.value = r.enabled } catch { /* 非 admin 或无权限→静默 */ }
}
async function toggleMcp() {
  mcpLoading.value = true
  try { const r = await adminApi.mcpConfig.update(!mcpEnabled.value); mcpEnabled.value = r.enabled } catch { /* notify or silent */ } finally { mcpLoading.value = false }
}

// === Custom Columns: toggleable columns + localStorage persistence (instant effect) ===
const { catalog, resetAll } = useTableColumns()
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
                <button @click="setLocale('zh')" :class="i18n.global.locale.value === 'zh' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'" class="text-xs px-sm py-xs rounded-md transition-colors">{{ t('settings.zhName') }}</button>
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
            <button @click="loadComponents" :disabled="csState === 'loading'"
              class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50">
              <span class="material-symbols-outlined text-sm" :class="csState === 'loading' ? 'animate-spin' : ''">refresh</span>
              {{ t('settings.refresh') }}
            </button>
          </div>

          <!-- API Server 就绪探针 -->
          <div class="mx-md mb-sm flex items-center justify-between bg-surface-container-low rounded-lg px-md py-sm border border-outline-variant/50">
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
              <tr v-for="c in components" :key="c.name" class="hover:bg-surface-container-low/40">
                <td class="px-md py-2 text-body-sm font-medium">{{ c.name }}</td>
                <td class="px-md py-2">
                  <span class="flex items-center gap-sm">
                    <span class="w-2 h-2 rounded-full" :class="c.status === 'Healthy' ? 'bg-primary' : 'bg-error'"></span>
                    <span class="text-xs font-medium" :class="c.status === 'Healthy' ? 'text-primary' : 'text-error'">{{ c.status }}</span>
                  </span>
                </td>
                <td class="px-md py-2 font-mono text-code-sm text-on-surface-variant">{{ c.message || '—' }}</td>
              </tr>
              <tr v-if="!components.length">
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
          <div class="p-md space-y-md">
            <p class="text-xs text-on-surface-variant">{{ t('settings.customDisplayDesc') }}</p>
            <div v-for="tbl in catalog" :key="tbl.key" class="border border-outline-variant/60 rounded-lg p-md">
              <div class="flex items-center gap-sm mb-sm">
                <span class="material-symbols-outlined text-primary text-sm">{{ tbl.icon }}</span>
                <span class="text-body-sm font-semibold">{{ t(tbl.labelKey) || tbl.label }}</span>
              </div>
              <ColumnManager :table-key="tbl.key" />
            </div>
          </div>
        </div>

        <!-- MCP Service tab (admin only) -->
        <div v-if="activeTab === 'mcp'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">hub</span>
            <span class="text-body-sm font-semibold">{{ t('settings.mcpTitle') }}</span>
          </div>
          <div class="p-md space-y-md">
            <!-- Toggle + Status card -->
            <div class="flex items-center justify-between p-md rounded-lg border transition-colors"
              :class="mcpEnabled ? 'border-status-running/30 bg-status-running/5' : 'border-outline-variant bg-surface-container-low'">
              <div class="flex items-center gap-md">
                <span class="w-3 h-3 rounded-full transition-colors" :class="mcpEnabled ? 'bg-status-running' : 'bg-on-surface-variant/30'"></span>
                <div>
                  <p class="text-body-sm font-semibold transition-colors" :class="mcpEnabled ? 'text-status-running' : 'text-on-surface-variant'">
                    {{ mcpEnabled ? t('settings.mcpEnabled') : t('settings.mcpDisabled') }}
                  </p>
                  <p class="text-body-xs text-on-surface-variant">{{ mcpEnabled ? t('settings.mcpRunningHint') : t('settings.mcpDisabledHint') }}</p>
                </div>
              </div>
              <button @click="toggleMcp" :disabled="mcpLoading"
                class="relative w-12 h-6 rounded-full transition-colors flex-shrink-0"
                :class="mcpEnabled ? 'bg-status-running' : 'bg-outline-variant'">
                <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow-sm"
                  :class="mcpEnabled ? 'translate-x-6' : 'translate-x-0'"></span>
              </button>
            </div>
            <!-- Usage hint (when enabled): copy-paste install / remove / rotate commands -->
            <div v-if="mcpEnabled" class="space-y-md p-md rounded-lg bg-surface-container-low border border-outline-variant/50">
              <p class="text-body-sm font-semibold text-on-surface">{{ t('settings.mcpUsageTitle') }}</p>

              <!-- ① 安装命令 -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpAddCmdLabel') }}</span>
                  <button @click="copyText(mcpAddCmd)" type="button"
                    class="flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpAddCmd }}</pre>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpAddCmdHint') }}</p>
              </div>

              <!-- ② 移除 / 换 Key 命令 -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpRemoveCmdLabel') }}</span>
                  <button @click="copyText(mcpRemoveCmd)" type="button"
                    class="flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpRemoveCmd }}</pre>
                <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpRemoveCmdHint') }}</p>
              </div>

              <!-- ③ 安装 claude CLI(可选) -->
              <div class="space-y-xs">
                <div class="flex items-center justify-between">
                  <span class="text-body-xs font-semibold text-on-surface">{{ t('settings.mcpInstallCliLabel') }}</span>
                  <button @click="copyText(mcpInstallCliCmd)" type="button"
                    class="flex items-center gap-xs px-xs py-0.5 rounded text-body-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors">
                    <span class="material-symbols-outlined text-sm">content_copy</span>{{ t('common.copy') }}
                  </button>
                </div>
                <pre class="text-code-sm font-mono text-on-surface bg-surface-container-high/60 px-md py-sm rounded-lg overflow-x-auto whitespace-pre-wrap break-all">{{ mcpInstallCliCmd }}</pre>
              </div>

              <p class="text-body-xs text-on-surface-variant">{{ t('settings.mcpUsageNote') }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
