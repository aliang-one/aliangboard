<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { exportYaml } from '@/api/client'
import StatusChip from '@/components/common/StatusChip.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const searchQuery = ref('')
const statusFilter = ref('All')
const nodeFilter = ref('All Nodes')

const statusOptions = ['All', 'Running', 'Pending', 'Failed', 'Succeeded']
const nodeOptions = computed(() => {
  const nodes = [...new Set(store.nsPods.map(p => p.node).filter(Boolean))]
  return ['All Nodes', ...nodes.sort()]
})

const filtered = computed(() => {
  let list = store.nsPods
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(p => p.name.toLowerCase().includes(q) || p.ip.includes(q))
  }
  if (statusFilter.value !== 'All') list = list.filter(p => p.status === statusFilter.value)
  if (nodeFilter.value !== 'All Nodes') list = list.filter(p => p.node === nodeFilter.value)
  return list
})

const runningCount = computed(() => store.nsPods.filter(p => p.status === 'Running').length)
const pendingCount = computed(() => store.nsPods.filter(p => p.status === 'Pending').length)
const failedCount = computed(() => store.nsPods.filter(p => p.status === 'Failed').length)

// 分页
const currentPage = ref(1)
const pageSize = ref(10)
const paginated = computed(() => filtered.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
// 筛选条件变化时回到第 1 页
watch([searchQuery, statusFilter, nodeFilter], () => { currentPage.value = 1 })

// Pod 实时监听（watch）：远端模式可开关；离开页面停止，避免长连接泄漏
function toggleLive() { store.podWatchLive ? store.stopPodWatch() : store.startPodWatch() }
onUnmounted(() => { if (store.podWatchLive) store.stopPodWatch() })

function cpuPercent(cpu) {
  if (!cpu || cpu === '0/0') return 0
  const parts = cpu.split('/')
  if (parts.length !== 2) return 0
  const used = parseInt(parts[0]) || 0
  const total = parseInt(parts[1]) || 1
  return Math.round((used / total) * 100)
}

function memPercent(mem) {
  if (!mem || mem === '0/0') return 0
  const parts = mem.split('/')
  if (parts.length !== 2) return 0
  const usedNum = parseFloat(parts[0]) || 0
  const totalNum = parseFloat(parts[1]) || 1
  return Math.round((usedNum / totalNum) * 100)
}

// 行操作菜单
function menuItems(row) {
  return [
    { label: '查看详情', icon: 'open_in_new', action: () => router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: row.name } }) },
    { label: '导出 YAML', icon: 'download', action: () => exportYaml(`/api/v1/namespaces/${route.params.namespace}/pods/${encodeURIComponent(row.name)}`, `${row.name}.yaml`) },
    { label: '删除', icon: 'delete', danger: true, action: () => confirmDelete(row) },
  ]
}

// 删除 Pod
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(row) {
  deleteTarget.value = row
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deletePod(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

// 创建 Pod
const showCreateModal = ref(false)
const createForm = ref({ name: '', image: '', container: '' })
function resetCreate() {
  createForm.value = { name: '', image: '', container: '' }
}
function handleCreate() {
  const f = createForm.value
  if (!f.name || !f.image) return
  store.addPod({
    name: f.name,
    namespace: route.params.namespace,
    image: f.image,
    containers: [f.container || f.name],
    labels: { app: f.name },
  })
  showCreateModal.value = false
  resetCreate()
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Pods' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-lg font-bold text-on-surface">Pods</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ store.nsPods.length }} pods in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <div class="flex items-center gap-sm">
        <button v-if="store.remoteMode" @click="toggleLive"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border transition-colors"
          :class="store.podWatchLive ? 'bg-primary-container/20 text-primary border-primary' : 'bg-surface-container-highest text-on-surface border-outline-variant hover:bg-surface-container'"
          :title="store.podWatchLive ? '正在实时监听 Pod 变化（watch），点击停止' : '开启实时监听 Pod 变化（watch=true）'">
          <span class="material-symbols-outlined">{{ store.podWatchLive ? 'pause' : 'play_arrow' }}</span>
          <span class="flex items-center gap-xs">Live
            <span v-if="store.podWatchLive" class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>
          </span>
        </button>
        <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> Create Pod
        </button>
      </div>
    </div>

    <!-- Status Summary Bar -->
    <div class="grid grid-cols-4 gap-sm mb-md">
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm">
        <span class="w-2.5 h-2.5 rounded-full bg-on-surface-variant"></span>
        <span class="text-body-sm text-on-surface-variant">Total</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ store.nsPods.length }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="statusFilter = statusFilter === 'Running' ? 'All' : 'Running'">
        <span class="w-2.5 h-2.5 rounded-full bg-primary"></span>
        <span class="text-body-sm text-on-surface-variant">Running</span>
        <span class="text-body-md font-bold text-primary ml-auto">{{ runningCount }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-tertiary transition-colors" @click="statusFilter = statusFilter === 'Pending' ? 'All' : 'Pending'">
        <span class="w-2.5 h-2.5 rounded-full bg-tertiary-container"></span>
        <span class="text-body-sm text-on-surface-variant">Pending</span>
        <span class="text-body-md font-bold text-tertiary-container ml-auto">{{ pendingCount }}</span>
      </div>
      <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant px-sm py-1.5 flex items-center gap-sm cursor-pointer hover:border-error transition-colors" @click="statusFilter = statusFilter === 'Failed' ? 'All' : 'Failed'">
        <span class="w-2.5 h-2.5 rounded-full bg-error"></span>
        <span class="text-body-sm text-on-surface-variant">Failed</span>
        <span class="text-body-md font-bold text-error ml-auto">{{ failedCount }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="Search pods by name or IP..." />
      </div>
      <select v-model="statusFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s === 'All' ? 'All Statuses' : s }}</option>
      </select>
      <select v-model="nodeFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="n in nodeOptions" :key="n" :value="n">{{ n }}</option>
      </select>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} result{{ filtered.length !== 1 ? 's' : '' }}</span>
    </div>

    <!-- Pods Table -->
    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">IP</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Status</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Restarts</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Node</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">CPU</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Memory</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant w-12"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="p in paginated" :key="p.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })">
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="w-2 h-2 rounded-full shrink-0" :class="{
                  'bg-primary animate-pulse-status': p.status === 'Running',
                  'bg-tertiary-container': p.status === 'Pending',
                  'bg-error': p.status === 'Failed',
                  'bg-on-surface-variant': p.status === 'Succeeded',
                }"></span>
                <span class="font-mono text-code-sm font-semibold text-on-surface">{{ p.name }}</span>
              </div>
            </td>
            <td class="px-md py-2"><span class="font-mono text-code-xs text-on-surface-variant">{{ p.ip || '-' }}</span></td>
            <td class="px-md py-2"><StatusChip :status="p.status" size="sm" /></td>
            <td class="px-md py-2">
              <span class="text-body-sm" :class="p.restarts > 3 ? 'text-error font-semibold' : p.restarts > 0 ? 'text-tertiary-container' : 'text-on-surface-variant'">{{ p.restarts }}</span>
            </td>
            <td class="px-md py-2">
              <span class="font-mono text-code-sm text-on-surface-variant">{{ p.node || '-' }}</span>
            </td>
            <td class="px-md py-2">
              <div v-if="p.cpu && p.cpu !== '0/0'" class="flex items-center gap-sm">
                <div class="w-16 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all" :class="cpuPercent(p.cpu) > 80 ? 'bg-error' : cpuPercent(p.cpu) > 60 ? 'bg-tertiary-container' : 'bg-primary'" :style="{ width: cpuPercent(p.cpu) + '%' }"></div>
                </div>
                <span class="font-mono text-code-xs text-on-surface-variant whitespace-nowrap">{{ p.cpu }}</span>
              </div>
              <span v-else class="text-on-surface-variant text-body-sm">-</span>
            </td>
            <td class="px-md py-2">
              <div v-if="p.memory && p.memory !== '0/0'" class="flex items-center gap-sm">
                <div class="w-16 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
                  <div class="h-full rounded-full transition-all" :class="memPercent(p.memory) > 80 ? 'bg-error' : memPercent(p.memory) > 60 ? 'bg-tertiary-container' : 'bg-secondary'" :style="{ width: memPercent(p.memory) + '%' }"></div>
                </div>
                <span class="font-mono text-code-xs text-on-surface-variant whitespace-nowrap">{{ p.memory }}</span>
              </div>
              <span v-else class="text-on-surface-variant text-body-sm">-</span>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ p.age }}</td>
            <td class="px-md py-2">
              <DropdownMenu :items="menuItems(p)" />
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="9" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">search_off</span>
              <p class="text-body-sm text-on-surface-variant">No pods found matching your filters</p>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- 分页 -->
      <div v-if="filtered.length" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination
          :total="filtered.length"
          :page-size="pageSize"
          :current-page="currentPage"
          show-size-selector
          @page-change="(p) => currentPage = p"
          @size-change="(s) => { pageSize = s; currentPage = 1 }"
        />
      </div>
    </div>
  </section>

  <!-- 删除确认 -->
  <Modal v-model="showDeleteModal" title="删除 Pod" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">确定要删除 Pod <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span> 吗？</p>
    <p class="text-body-sm text-error mt-sm">此操作不可撤销。若 Pod 由工作负载管理，控制器可能会重新创建它。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
    </template>
  </Modal>

  <!-- 创建 Pod -->
  <Modal v-model="showCreateModal" title="创建 Pod" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Pod 名称 *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-pod" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">容器镜像 *</label>
        <input v-model="createForm.image" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="nginx:latest" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">容器名称（可选）</label>
        <input v-model="createForm.container" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="默认使用 Pod 名称" />
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.image" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">创建</button>
    </template>
  </Modal>
</template>
