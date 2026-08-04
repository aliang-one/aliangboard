<script setup>
import { ref, watch, onMounted } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { useTableColumns } from '@/composables/useTableColumns'

const store = useClusterStore()
const activeTab = ref('general')

const tabs = [
  { key: 'general', label: 'General', icon: 'info' },
  { key: 'components', label: 'Components', icon: 'extension' },
  { key: 'api', label: 'API Server', icon: 'api' },
  { key: 'customcols', label: 'Custom Columns', icon: 'view_column' },
]

// 演示数据模式下的静态组件（无后端连接时展示，避免空白）
const demoComponents = [
  { name: 'etcd', status: 'Healthy', message: '' },
  { name: 'kube-apiserver', status: 'Healthy', message: '' },
  { name: 'kube-controller-manager', status: 'Healthy', message: '' },
  { name: 'kube-scheduler', status: 'Healthy', message: '' },
]

// === Components：真实集群组件健康 ===
const components = ref([])
const apiReady = ref(null)        // null=未知, true=就绪, false=未就绪
const csState = ref('idle')       // 'idle' | 'loading' | 'loaded' | 'error'
const csError = ref('')

async function loadComponents() {
  if (!store.remoteMode) { csState.value = 'loaded'; return }   // 演示模式：用 demoComponents
  csState.value = 'loading'
  csError.value = ''
  // API Server 就绪探针（/readyz 返回 200 'ok' 即健康；componentstatuses 自 K8s 1.19 起已弃用）
  try { await api.k8s('/readyz'); apiReady.value = true } catch { apiReady.value = false }
  // 控制面组件健康（componentstatuses；多数现代集群返回空或 Unhealthy，故 readyz 才是主信号）
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
    csError.value = e.message || '读取组件状态失败'
  }
}

watch(activeTab, tab => { if (tab === 'components' && csState.value === 'idle') loadComponents() })
onMounted(() => { if (activeTab.value === 'components') loadComponents() })

// === Custom Columns：可勾选列 + localStorage 持久化（即时生效）===
const { catalog, isHidden, toggle, resetTable, resetAll } = useTableColumns()
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex justify-between items-end mb-md">
      <div>
        <h2 class="text-headline-md text-on-surface font-bold">Settings</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">Cluster configuration, component health, and display preferences.</p>
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
            <span class="text-body-sm font-semibold">Cluster Information</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Cluster Name</span>
              <span class="text-body-sm font-medium">{{ store.cluster.name }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Kubernetes Version</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">API Server</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Status</span>
              <span class="flex items-center gap-sm text-primary font-medium">
                <span class="w-2 h-2 bg-primary rounded-full animate-pulse-status"></span> {{ store.cluster.status }}
              </span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Nodes</span>
              <span class="font-medium">{{ store.cluster.nodeCount }}</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">Pods</span>
              <span class="font-medium">{{ store.cluster.podCount }}</span>
            </div>
          </div>
        </div>

        <!-- Components -->
        <div v-if="activeTab === 'components'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">extension</span>
              <span class="text-body-sm font-semibold">Component Status</span>
            </div>
            <button v-if="store.remoteMode" @click="loadComponents" :disabled="csState === 'loading'"
              class="flex items-center gap-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container disabled:opacity-50">
              <span class="material-symbols-outlined text-sm" :class="csState === 'loading' ? 'animate-spin' : ''">refresh</span>
              Refresh
            </button>
          </div>

          <!-- 演示模式提示 -->
          <div v-if="!store.remoteMode" class="mx-md mt-md mb-sm flex items-center gap-sm bg-tertiary-container/10 border border-tertiary/30 rounded-lg px-md py-sm">
            <span class="material-symbols-outlined text-tertiary-container text-base">info</span>
            <span class="text-xs text-on-surface-variant">演示数据模式：以下为静态示例，连接真实集群后将显示实际组件健康。</span>
          </div>

          <!-- API Server 就绪探针 -->
          <div v-if="store.remoteMode" class="mx-md mb-sm flex items-center justify-between bg-surface-container-low rounded-lg px-md py-sm border border-outline-variant/50">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-on-surface-variant text-sm">api</span>
              <span class="text-body-sm font-medium">API Server (/readyz)</span>
            </div>
            <span v-if="apiReady === null" class="text-xs text-on-surface-variant">检测中…</span>
            <span v-else-if="apiReady" class="flex items-center gap-sm text-primary font-medium text-xs">
              <span class="w-2 h-2 bg-primary rounded-full"></span> Ready
            </span>
            <span v-else class="flex items-center gap-sm text-error font-medium text-xs">
              <span class="w-2 h-2 bg-error rounded-full"></span> Not Ready
            </span>
          </div>

          <!-- 加载 / 错误 / 表格 -->
          <div v-if="csState === 'loading'" class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined animate-spin">progress_activity</span>
            <p class="text-body-sm mt-xs">读取组件状态…</p>
          </div>
          <div v-else-if="csState === 'error'" class="p-md text-center">
            <span class="material-symbols-outlined text-error">error</span>
            <p class="text-body-sm text-error mt-xs">{{ csError }}</p>
            <button @click="loadComponents" class="mt-md px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container">重试</button>
          </div>
          <table v-else class="w-full text-left">
            <thead>
              <tr class="bg-surface-container-low/50 border-b border-outline-variant">
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Component</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Status</th>
                <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Message</th>
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
                  本集群未暴露 componentstatuses（K8s 1.19+ 已弃用该 API，常返回空）。请以右上方 <span class="font-medium">API Server (/readyz)</span> 作为控制面就绪判据。
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- API Server -->
        <div v-if="activeTab === 'api'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">api</span>
            <span class="text-body-sm font-semibold">API Server Configuration</span>
          </div>
          <div class="p-md space-y-md">
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Endpoint</span>
              <span class="font-mono text-code-sm text-primary">{{ store.cluster.apiServer }}</span>
            </div>
            <div class="flex justify-between py-sm border-b border-outline-variant/50">
              <span class="text-body-sm text-on-surface-variant">Authentication</span>
              <span class="text-body-sm">Bearer Token / Basic Auth</span>
            </div>
            <div class="flex justify-between py-sm">
              <span class="text-body-sm text-on-surface-variant">API Version</span>
              <span class="font-mono text-code-sm">{{ store.cluster.version || 'v1' }}</span>
            </div>
          </div>
        </div>

        <!-- Custom Columns -->
        <div v-if="activeTab === 'customcols'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">view_column</span>
              <span class="text-body-sm font-semibold">Custom Display Columns</span>
            </div>
            <button @click="resetAll" class="px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium text-on-surface-variant hover:bg-surface-container">Reset All</button>
          </div>
          <div class="p-md space-y-sm">
            <p class="text-xs text-on-surface-variant">勾选要在各列表视图中显示的列，配置保存在浏览器本地并即时生效。</p>
            <div v-for="t in catalog" :key="t.key" class="border border-outline-variant/60 rounded-lg p-md">
              <div class="flex items-center justify-between mb-sm">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-primary text-sm">{{ t.icon }}</span>
                  <span class="text-body-sm font-semibold">{{ t.label }}</span>
                </div>
                <button @click="resetTable(t.key)" class="text-xs text-on-surface-variant hover:text-primary">Reset</button>
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
