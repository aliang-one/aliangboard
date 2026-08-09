<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { exportYaml } from '@/api/client'
import { extractContainerPorts } from '@/composables/usePorts'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import Pagination from '@/components/common/Pagination.vue'
import PortSelect from '@/components/common/PortSelect.vue'
import { usePagination } from '@/composables/usePagination'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// Services 走 Vue Query（cluster-wide fetch + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
// hydrate 仍为其他页供数（过渡双源，后续收敛）。
const cid = computed(() => (store.currentCluster || 'cluster'))
const servicesKey = ['cluster', cid.value, 'services']
const servicesQuery = useResourceList({
  key: servicesKey,
  fetcher: () => store.fetchServices(),
  options: { refetchInterval: 30000 },
})
const nsServices = computed(() => (servicesQuery.data.value || []).filter(s => s.namespace === route.params.namespace))
// 容器端口（从 workloads 派生，替代 nsContainerPorts）
const _wlsQ = useResourceList({ key: ['cluster', cid.value, 'workloads'], fetcher: () => store.fetchWorkloads(), options: { refetchInterval: 30000 } })
const nsContainerPorts = computed(() => extractContainerPorts((_wlsQ.data.value || []).filter(w => w.namespace === route.params.namespace)))

const typeFilter = ref('All')
const typeOptions = ['All', 'ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']
const searchQuery = ref('')

const filtered = computed(() => {
  let list = nsServices.value
  if (typeFilter.value !== 'All') list = list.filter(s => s.type === typeFilter.value)
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s => s.name.toLowerCase().includes(q) || s.clusterIP.includes(q))
  }
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [typeFilter, searchQuery] })

const clusterIPCount = computed(() => nsServices.value.filter(s => s.type === 'ClusterIP').length)
const nodePortCount = computed(() => nsServices.value.filter(s => s.type === 'NodePort').length)
const lbCount = computed(() => nsServices.value.filter(s => s.type === 'LoadBalancer').length)

// 类型 → 图标 / 配色（行图标 + 徽章 + 汇总卡）
const TYPE_META = {
  ClusterIP:    { icon: 'hub',    iconColor: 'text-primary',           badge: 'bg-primary/10 text-primary border-primary/20',            dot: 'bg-primary' },
  NodePort:     { icon: 'lan',    iconColor: 'text-secondary',          badge: 'bg-secondary/10 text-secondary border-secondary/25',      dot: 'bg-secondary' },
  LoadBalancer: { icon: 'public', iconColor: 'text-tertiary',           badge: 'bg-tertiary-container/15 text-tertiary-container border-tertiary-container/30', dot: 'bg-tertiary-container' },
  ExternalName: { icon: 'link',   iconColor: 'text-on-surface-variant', badge: 'bg-surface-container text-on-surface-variant border-outline-variant',          dot: 'bg-on-surface-variant' },
}
const typeMeta = t => TYPE_META[t] || { icon: 'hub', iconColor: 'text-primary', badge: 'bg-surface-container text-on-surface-variant border-outline-variant', dot: 'bg-on-surface-variant' }

// 汇总卡（Total + 三类）
const typeCards = computed(() => [
  { key: 'ClusterIP', label: 'ClusterIP', count: clusterIPCount.value, ...TYPE_META.ClusterIP },
  { key: 'NodePort', label: 'NodePort', count: nodePortCount.value, ...TYPE_META.NodePort },
  { key: 'LoadBalancer', label: 'LoadBalancer', count: lbCount.value, ...TYPE_META.LoadBalancer },
])
function toggleType(key) {
  typeFilter.value = typeFilter.value === key ? 'All' : key
}

// 端口：远端用结构化 portList（含 nodePort），mock 回退解析扁平字符串
function parsePorts(row) {
  let list
  if (row.portList?.length) {
    list = row.portList.map(p => ({ port: p.port, target: p.targetPort, proto: p.protocol, nodePort: p.nodePort }))
  } else {
    list = String(row.ports || '').split(',').filter(Boolean).map(s => {
      const m = String(s).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/)
      if (!m) return { port: s, target: '', proto: '', nodePort: null }
      const tgt = m[2]
      return { port: Number(m[1]), target: isNaN(tgt) ? tgt : Number(tgt), proto: m[3] || 'TCP', nodePort: null }
    })
  }
  // 预生成悬浮提示，避免模板内拼复杂表达式
  return list.map(p => {
    const parts = [String(p.port)]
    if (p.target && String(p.target) !== String(p.port)) parts.push('→ ' + p.target)
    if (p.proto) parts.push('/ ' + p.proto)
    if (p.nodePort) parts.push('(node ' + p.nodePort + ')')
    return { ...p, tip: parts.join(' ') }
  })
}

// 后端端点健康：从 Endpoints 对象取 ready / notReady
function epState(row) {
  if (row.type === 'ExternalName') return { dot: 'bg-on-surface-variant', title: t('ns.services.extNameHint') }
  const ep = store.getEndpointsByName(row.name, row.namespace)
  if (!ep) return { dot: 'bg-outline-variant', title: t('ns.services.noEndpointsObj') }
  const ready = (ep.addresses || []).length, notReady = (ep.notReadyAddresses || []).length
  if (ready > 0) return { dot: 'bg-primary', title: t('ns.services.readyCount', { ready, notReady }) }
  if (notReady > 0) return { dot: 'bg-tertiary-container', title: t('ns.services.notReadyOnly', { n: notReady }) }
  return { dot: 'bg-error', title: t('ns.services.noEndpoints') }
}

// 装饰当前页行：预计算端口 / 端点 / 类型，避免模板内重复调用
const decorated = computed(() => paginated.value.map(row => ({
  row,
  ports: parsePorts(row),
  ep: epState(row),
  meta: typeMeta(row.type),
})))

// 行操作菜单
function menuItems(row) {
  const items = [{ label: t('ns.services.menuDetail'), icon: 'open_in_new', action: () => router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: row.name } }) }]
  if (store.remoteMode) items.push({ label: t('ns.services.menuExport'), icon: 'download', action: () => exportYaml(`/api/v1/namespaces/${encodeURIComponent(row.namespace || route.params.namespace)}/services/${encodeURIComponent(row.name)}`, `${row.name}.yaml`) })
  items.push({ label: t('ns.services.menuDelete'), icon: 'delete', danger: true, action: () => confirmDelete(row) })
  return items
}

// Create Service Dialog（字段集与详情页统一 Edit 对齐：多端口 / ExternalName / 多选择器）
const showCreateModal = ref(false)
const createForm = ref({ name: '', type: 'ClusterIP', ports: [{ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }], externalName: '', selector: [{ key: 'app', value: '' }], sessionAffinity: 'None', sessionAffinityTimeout: 10800, externalTrafficPolicy: '', internalTrafficPolicy: 'Cluster' })
function resetCreate() {
  createForm.value = { name: '', type: 'ClusterIP', ports: [{ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }], externalName: '', selector: [{ key: 'app', value: '' }], sessionAffinity: 'None', sessionAffinityTimeout: 10800, externalTrafficPolicy: '', internalTrafficPolicy: 'Cluster' }
}
function addCreatePort() { createForm.value.ports.push({ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }) }
function removeCreatePort(idx) { createForm.value.ports.splice(idx, 1) }
function addCreateSelector() { createForm.value.selector.push({ key: '', value: '' }) }
function removeCreateSelector(idx) { createForm.value.selector.splice(idx, 1) }
const canCreate = computed(() => {
  const f = createForm.value
  if (!f.name.trim()) return false
  if (f.type === 'ExternalName') return !!f.externalName.trim()
  return f.ports.some(p => p.port !== '' && p.port != null)
})
async function handleCreate() {
  const f = createForm.value
  const rows = f.ports.filter(p => p.port !== '' && p.port != null)
  const portList = rows.map(p => {
    const tgt = p.targetPort === '' ? p.port : p.targetPort
    return { name: '', port: Number(p.port), targetPort: isNaN(tgt) ? tgt : Number(tgt), protocol: p.protocol || 'TCP', nodePort: p.nodePort ? Number(p.nodePort) : null, appProtocol: '' }
  })
  const portsStr = portList.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')
  const selector = {}
  f.selector.forEach(r => { if (r.key.trim()) selector[r.key.trim()] = r.value })
  const payload = {
    name: f.name.trim(),
    namespace: route.params.namespace,
    type: f.type,
    clusterIP: '10.96.' + Math.floor(Math.random() * 255) + '.' + Math.floor(Math.random() * 255),
    externalIP: '-',
    selector,
    portList,
    ports: portsStr,
  }
  if (f.type === 'ExternalName' && f.externalName.trim()) payload.externalName = f.externalName.trim()
  if (f.type !== 'ExternalName') {
    if (f.sessionAffinity === 'ClientIP') {
      payload.sessionAffinity = 'ClientIP'
      if (f.sessionAffinityTimeout !== '' && f.sessionAffinityTimeout != null) payload.sessionAffinityTimeout = Number(f.sessionAffinityTimeout)
    }
    if (f.externalTrafficPolicy) payload.externalTrafficPolicy = f.externalTrafficPolicy
    payload.internalTrafficPolicy = f.internalTrafficPolicy
  }
  const r = await store.addService(payload)
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  queryClient.invalidateQueries({ queryKey: servicesKey })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(svc) {
  deleteTarget.value = svc
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteService(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: servicesKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Services' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.services.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.services.subtitle', { count: nsServices.length, ns: route.params.namespace }) }}</p>
      </div>
      <div class="flex items-center gap-sm">
        <button @click="router.push({ name: 'NsEndpoints', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface-variant rounded-lg hover:border-primary hover:text-primary transition-colors" :title="t('ns.services.endpointsTitle')">
          <span class="material-symbols-outlined text-base">cable</span> {{ t('ns.services.endpoints') }}
        </button>
        <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined">add</span> {{ t('common.create') }} {{ t('ns.services.title') }}
        </button>
      </div>
    </div>

    <!-- Type Summary -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-xs mb-sm">
      <button @click="toggleType('All')"
        class="rounded-lg px-sm py-1.5 flex items-center gap-xs text-left border transition-colors"
        :class="typeFilter === 'All' ? 'border-primary bg-primary/5' : 'border-outline-variant bg-surface-container-lowest hover:border-primary'">
        <span class="material-symbols-outlined text-on-surface-variant text-base">share</span>
        <span class="text-xs text-on-surface-variant">{{ t('ns.services.total') }}</span>
        <span class="text-body-sm font-bold text-on-surface ml-auto">{{ nsServices.length }}</span>
      </button>
      <button v-for="t in typeCards" :key="t.key" @click="toggleType(t.key)"
        class="rounded-lg px-sm py-1.5 flex items-center gap-xs text-left border transition-colors"
        :class="typeFilter === t.key ? 'border-primary bg-primary/5' : 'border-outline-variant bg-surface-container-lowest hover:border-primary'">
        <span class="material-symbols-outlined text-base" :class="t.iconColor">{{ t.icon }}</span>
        <span class="text-xs text-on-surface-variant">{{ t.label }}</span>
        <span class="text-body-sm font-bold ml-auto" :class="t.iconColor">{{ t.count }}</span>
      </button>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-xs mb-sm">
      <div class="relative flex-1 min-w-[200px] max-w-md">
        <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-9 pr-sm py-1.5 text-body-sm focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.services.searchPlaceholder')" />
      </div>
      <select v-model="typeFilter" class="bg-surface-container-lowest border border-outline-variant rounded-lg px-sm py-1.5 text-body-sm focus:ring-primary focus:border-primary cursor-pointer">
        <option v-for="tOpt in typeOptions" :key="tOpt" :value="tOpt">{{ tOpt === 'All' ? t('ns.services.allTypes') : tOpt }}</option>
      </select>
      <span class="text-xs text-on-surface-variant ml-auto">{{ t('ns.pods.results', { n: filtered.length }) }}</span>
    </div>

    <!-- Table -->
    <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[900px] text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thName') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thType') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thClusterIp') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thExternalIp') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thPorts') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('ns.services.thSelector') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap">{{ t('common.age') }}</th>
            <th class="px-md py-1.5 text-label-caps text-on-surface-variant whitespace-nowrap w-12"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="{ row, ports, ep, meta } in decorated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <!-- Name + health dot + type icon -->
            <td class="px-md py-1.5">
              <div class="flex items-center gap-xs">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="ep.dot" :title="ep.title"></span>
                <span class="material-symbols-outlined text-base shrink-0" :class="meta.iconColor">{{ meta.icon }}</span>
                <span class="font-mono text-xs font-semibold text-on-surface">{{ row.name }}</span>
              </div>
            </td>
            <!-- Type badge -->
            <td class="px-md py-1.5">
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border whitespace-nowrap" :class="meta.badge">{{ row.type }}</span>
            </td>
            <!-- Cluster IP -->
            <td class="px-md py-1.5"><span class="font-mono text-xs whitespace-nowrap text-on-surface-variant">{{ row.clusterIP }}</span></td>
            <!-- External IP -->
            <td class="px-md py-1.5">
              <span v-if="row.externalIP !== '-'" class="inline-flex items-center gap-0.5 font-mono text-xs text-primary font-semibold whitespace-nowrap">
                <span class="material-symbols-outlined text-xs">cloud_done</span>{{ row.externalIP }}
              </span>
              <span v-else class="text-on-surface-variant/40">—</span>
            </td>
            <!-- Ports (port → target chips) -->
            <td class="px-md py-1.5">
              <div class="flex flex-wrap items-center gap-1 max-w-[220px]">
                <span v-for="(p, i) in ports.slice(0, 2)" :key="i"
                  class="inline-flex items-center gap-0.5 font-mono text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/15 whitespace-nowrap"
                  :title="p.tip">
                  {{ p.port }}<template v-if="p.target && String(p.target) !== String(p.port)"><span class="text-primary/50">→</span>{{ p.target }}</template>
                </span>
                <span v-if="ports.length > 2" class="text-xs text-on-surface-variant whitespace-nowrap" :title="ports.slice(2).map(p => p.port).join(', ')">+{{ ports.length - 2 }}</span>
              </div>
            </td>
            <!-- Selector -->
            <td class="px-md py-1.5">
              <div v-if="row.selector && Object.keys(row.selector).length" class="flex flex-wrap gap-0.5 max-w-[200px]">
                <span v-for="(v, k) in row.selector" :key="k" class="font-mono text-xs px-1 py-0.5 rounded bg-surface-container text-on-surface-variant border border-outline-variant/50 whitespace-nowrap">{{ k }}=<span class="text-on-surface font-medium">{{ v }}</span></span>
              </div>
              <span v-else class="text-on-surface-variant/40 text-xs">—</span>
            </td>
            <!-- Age -->
            <td class="px-md py-1.5 text-xs text-on-surface-variant whitespace-nowrap">{{ row.age }}</td>
            <!-- Actions -->
            <td class="px-md py-1.5" @click.stop>
              <DropdownMenu :items="menuItems(row)" />
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="8" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">search_off</span>
              <p class="text-body-sm text-on-surface-variant">{{ t('ns.services.noMatch') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
  </section>

  <!-- Create Service Modal（与详情页 Edit 字段集对齐）-->
  <Modal v-model="showCreateModal" :title="t('ns.services.createTitle')" width="max-w-xl">
    <div class="flex flex-col gap-md">
      <!-- Name -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.nameLabel') }}</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-service" />
      </div>
      <!-- Type -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.typeLabel') }}</label>
        <div class="flex flex-wrap gap-xs">
          <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']" :key="st" type="button" @click="createForm.type = st"
            class="px-md py-sm rounded-lg border font-medium text-body-sm transition-all"
            :class="createForm.type === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
            {{ st }}
          </button>
        </div>
      </div>
      <!-- ExternalName -->
      <div v-if="createForm.type === 'ExternalName'">
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.extNameReq') }}</label>
        <input v-model="createForm.externalName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="my-service.example.com" />
        <p class="text-xs text-on-surface-variant/60 mt-xs">{{ t('ns.services.extNameRouteHint') }}</p>
      </div>
      <!-- Ports（结构化多端口）-->
      <div v-else>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">{{ t('ns.services.portsLabel') }}</label>
          <button @click="addCreatePort" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.services.addPort') }}
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(p, idx) in createForm.ports" :key="idx" class="flex gap-xs items-center flex-wrap">
            <input v-model="p.port" type="number" class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="port" />
            <span class="text-on-surface-variant text-body-sm">→</span>
            <PortSelect v-model="p.targetPort" :options="nsContainerPorts" placeholder="target" :empty-hint="t('ns.services.targetPortHint')" input-class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
            <select v-model="p.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
              <option>TCP</option><option>UDP</option><option>SCTP</option>
            </select>
            <input v-if="createForm.type === 'NodePort' || createForm.type === 'LoadBalancer'" v-model="p.nodePort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="nodePort" />
            <button @click="removeCreatePort(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
        </div>
      </div>
      <!-- Selector（多行）-->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">{{ t('ns.services.selectorLabel') }}</label>
          <button @click="addCreateSelector" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(row, idx) in createForm.selector" :key="idx" class="flex gap-xs items-center">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="app" />
            <span class="text-on-surface-variant text-body-sm">=</span>
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
            <button @click="removeCreateSelector(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Session Affinity -->
      <div v-if="createForm.type !== 'ExternalName'" class="grid grid-cols-2 gap-md items-end">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.sessionLabel') }}</label>
          <select v-model="createForm.sessionAffinity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="None">{{ t('ns.services.sessionNone') }}</option>
            <option value="ClientIP">{{ t('ns.services.sessionClientIp') }}</option>
          </select>
        </div>
        <div v-if="createForm.sessionAffinity === 'ClientIP'">
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.timeoutLabel') }}</label>
          <input v-model.number="createForm.sessionAffinityTimeout" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>

      <!-- Traffic Policy -->
      <div v-if="createForm.type !== 'ExternalName'" class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.extTrafficLabel') }}</label>
          <select v-model="createForm.externalTrafficPolicy" :disabled="createForm.type !== 'NodePort' && createForm.type !== 'LoadBalancer'" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary disabled:opacity-50">
            <option value="">{{ t('ns.services.extTrafficDefault') }}</option>
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.services.intTrafficLabel') }}</label>
          <select v-model="createForm.internalTrafficPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleCreate" :disabled="!canCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.services.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.services.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.services.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
