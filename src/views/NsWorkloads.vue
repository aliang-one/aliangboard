<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { exportYaml } from '@/api/client'
import { readMeta } from '@/composables/useBusinessMeta'
import StatusChip from '@/components/common/StatusChip.vue'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const typeFilter = ref('All')
const statusFilter = ref('All')
const searchQuery = ref('')

const typeOptions = ['All', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']
const statusOptions = ['All', 'Running', 'Pending', 'Failed', 'Succeeded']

const filtered = computed(() => {
  let list = store.nsWorkloads
  if (typeFilter.value !== 'All') list = list.filter(w => w.type === typeFilter.value)
  if (statusFilter.value !== 'All') list = list.filter(w => w.status === statusFilter.value)
  const q = searchQuery.value.trim().toLowerCase()
  if (q) list = list.filter(w => w.name.toLowerCase().includes(q) || (w.image || '').toLowerCase().includes(q))
  return list
})

const deployCount = computed(() => store.nsWorkloads.filter(w => w.type === 'Deployment').length)
const stsCount = computed(() => store.nsWorkloads.filter(w => w.type === 'StatefulSet').length)
const dsCount = computed(() => store.nsWorkloads.filter(w => w.type === 'DaemonSet').length)
const jobCount = computed(() => store.nsWorkloads.filter(w => ['Job', 'CronJob'].includes(w.type)).length)

// 分页
const currentPage = ref(1)
const pageSize = ref(10)
const paginated = computed(() => filtered.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
watch([typeFilter, statusFilter, searchQuery], () => { currentPage.value = 1 })

function replicaPercent(replicas) {
  const parts = replicas.split('/')
  if (parts.length !== 2) return 0
  return Math.round((parseInt(parts[0]) / parseInt(parts[1])) * 100)
}

function goDetail(row) {
  router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: row.type.toLowerCase(), name: row.name } })
}

// 行内导出 YAML（kubectl get -o yaml 语义）：按类型取 apps/batch 的复数路径
const WL_PLURAL = { Deployment: ['apps', 'deployments'], StatefulSet: ['apps', 'statefulsets'], DaemonSet: ['apps', 'daemonsets'], Job: ['batch', 'jobs'], CronJob: ['batch', 'cronjobs'] }
function exportWorkload(row) {
  const g = WL_PLURAL[row.type]
  if (!g) return
  exportYaml(`/apis/${g[0]}/v1/namespaces/${route.params.namespace}/${g[1]}/${encodeURIComponent(row.name)}`, `${row.name}.yaml`)
}

// 行操作菜单
function menuItems(row) {
  return [
    { label: '查看详情', icon: 'open_in_new', action: () => goDetail(row) },
    { label: '导出 YAML', icon: 'download', action: () => exportWorkload(row) },
    { label: '重启', icon: 'refresh', action: () => store.restartWorkload(row.name, route.params.namespace) },
    { label: '删除', icon: 'delete', danger: true, action: () => confirmDelete(row) },
  ]
}

// 删除
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(row) {
  deleteTarget.value = row
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteWorkload(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Workloads' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">Workloads</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.nsWorkloads.length }} workloads in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <router-link :to="{ name: 'NsDeploy', params: { namespace: route.params.namespace } }" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">rocket_launch</span> New Workload
      </router-link>
    </div>

    <!-- Type Summary -->
    <div class="grid grid-cols-4 gap-sm mb-lg">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'Deployment' ? 'All' : 'Deployment'">
        <span class="material-symbols-outlined text-primary text-lg">view_carousel</span>
        <span class="text-body-sm text-on-surface-variant">Deployments</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ deployCount }}</span>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'StatefulSet' ? 'All' : 'StatefulSet'">
        <span class="material-symbols-outlined text-secondary text-lg">database</span>
        <span class="text-body-sm text-on-surface-variant">StatefulSets</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ stsCount }}</span>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'DaemonSet' ? 'All' : 'DaemonSet'">
        <span class="material-symbols-outlined text-tertiary text-lg">settings_slow_motion</span>
        <span class="text-body-sm text-on-surface-variant">DaemonSets</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ dsCount }}</span>
      </div>
      <div class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm flex items-center gap-sm cursor-pointer hover:border-primary transition-colors" @click="typeFilter = typeFilter === 'Job' ? 'All' : 'Job'">
        <span class="material-symbols-outlined text-on-surface-variant text-lg">schedule</span>
        <span class="text-body-sm text-on-surface-variant">Jobs</span>
        <span class="text-body-md font-bold text-on-surface ml-auto">{{ jobCount }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-sm mb-lg">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-10 pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="搜索名称或镜像..." />
      </div>
      <select v-model="typeFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="t in typeOptions" :key="t" :value="t">{{ t === 'All' ? 'All Types' : t }}</option>
      </select>
      <select v-model="statusFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="s in statusOptions" :key="s" :value="s">{{ s === 'All' ? 'All Statuses' : s }}</option>
      </select>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} result{{ filtered.length !== 1 ? 's' : '' }}</span>
    </div>

    <!-- Table -->
    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Type</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Status</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Replicas</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Image</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-12"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/50 cursor-pointer transition-colors" @click="goDetail(row)">
            <td class="px-lg py-md">
              <div class="flex flex-col">
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                <span v-if="readMeta(row).title" class="text-body-xs text-primary">{{ readMeta(row).title }}</span>
                <span class="font-mono text-code-xs text-on-surface-variant">{{ row.sha }}</span>
              </div>
            </td>
            <td class="px-lg py-md">
              <span class="px-2 py-0.5 bg-surface-container rounded text-label-caps text-on-surface-variant border border-outline-variant">{{ row.type }}</span>
            </td>
            <td class="px-lg py-md"><StatusChip :status="row.status" size="sm" /></td>
            <td class="px-lg py-md">
              <div class="flex items-center gap-sm">
                <div class="w-14 bg-outline-variant/20 h-1.5 rounded-full overflow-hidden">
                  <div class="h-full rounded-full" :class="replicaPercent(row.replicas) === 100 ? 'bg-primary' : replicaPercent(row.replicas) === 0 ? 'bg-error' : 'bg-tertiary-container'" :style="{ width: replicaPercent(row.replicas) + '%' }"></div>
                </div>
                <span class="font-mono text-code-sm font-bold" :class="replicaPercent(row.replicas) === 100 ? 'text-primary' : 'text-tertiary-container'">{{ row.replicas }}</span>
              </div>
            </td>
            <td class="px-lg py-md"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.image }}</span></td>
            <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-lg py-md">
              <DropdownMenu :items="menuItems(row)" />
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="7" class="px-lg py-xl text-center">
              <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">search_off</span>
              <p class="text-on-surface-variant">No workloads found matching your filters</p>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- 分页 -->
      <div v-if="filtered.length" class="flex items-center justify-between px-lg py-md border-t border-outline-variant bg-surface-container-low">
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
  <Modal v-model="showDeleteModal" title="删除工作负载" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">确定要删除工作负载 <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span> 吗？</p>
    <p class="text-body-sm text-error mt-sm">此操作不可撤销，其管理的所有 Pod 将被终止。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">删除</button>
    </template>
  </Modal>
</template>
