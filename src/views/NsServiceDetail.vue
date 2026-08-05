<script setup>
// Service 详情页（单页概览 + 统一 Edit 抽屉）：
// - 页面为单一可滚动只读视图，无内容 Tab；头部仅 Edit + ⋮ 操作菜单。
// - 所有 spec 编辑统一进一个 Edit 弹窗（Type · Ports · Selector · Affinity · Traffic Policy · ExternalName）。
// - Port Forward / Export YAML / 查看 YAML / Delete 收进头部 ⋮ 菜单；YAML 用独立弹窗。
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { dump as yamlDump } from 'js-yaml'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import { api, exportYaml } from '@/api/client'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import PodCard from '@/components/common/PodCard.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import DropdownMenu from '@/components/common/DropdownMenu.vue'
import PortSelect from '@/components/common/PortSelect.vue'
import PortForwardPanel from '@/components/common/PortForwardPanel.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

const svc = computed(() => store.getServiceByName(route.params.name, route.params.namespace))

const showEditModal = ref(false)
const showYamlModal = ref(false)
const showDeleteModal = ref(false)
const showPortForward = ref(false)

// === 端口：远端用结构化 portList（含 nodePort/名称），mock 回退解析扁平字符串 ===
function parsePortString(str) {
  return String(str || '').split(',').filter(Boolean).map(s => {
    const m = String(s).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/)
    if (!m) return { name: '', port: s, targetPort: '', protocol: 'TCP', nodePort: null, appProtocol: '' }
    const tgt = m[2]
    return { name: '', port: Number(m[1]), targetPort: isNaN(tgt) ? tgt : Number(tgt), protocol: m[3] || 'TCP', nodePort: null, appProtocol: '' }
  })
}
const portRows = computed(() => svc.value?.portList?.length ? svc.value.portList : parsePortString(svc.value?.ports))
const hasNodePort = computed(() => svc.value?.type === 'NodePort' || svc.value?.type === 'LoadBalancer')
const forwardPorts = computed(() => portRows.value.map(p => Number(p.port)).filter(n => !isNaN(n)))

// === Endpoints：优先用真实 Endpoints 对象（ready / notReady），无则回退 selector 命中的 Pod ===
const ep = computed(() => store.getEndpointsByName(route.params.name, route.params.namespace))
const podByIp = computed(() => {
  const m = {}
  for (const p of store.nsPods) if (p.ip) m[p.ip] = p
  return m
})
const readyAddrs = computed(() => ep.value?.addresses || [])
const notReadyAddrs = computed(() => ep.value?.notReadyAddresses || [])
const epPorts = computed(() => ep.value?.ports || [])
const hasEndpoints = computed(() => !!ep.value)
const selectorPods = computed(() => {
  if (!svc.value?.selector) return []
  const sel = svc.value.selector
  return store.nsPods.filter(p => Object.entries(sel).every(([k, v]) => p.labels?.[k] === v))
})
const readyCount = computed(() => hasEndpoints.value ? readyAddrs.value.length : selectorPods.value.filter(p => p.status === 'Running').length)
const totalCount = computed(() => hasEndpoints.value ? (readyAddrs.value.length + notReadyAddrs.value.length) : selectorPods.value.length)
const endpointsHealthy = computed(() => readyCount.value > 0)
const isExternalName = computed(() => svc.value?.type === 'ExternalName')

// === 后端 Pod 统一列表：真实 Endpoints 时按地址取 backing pod，否则回退 selector 命中 ===
const backendPods = computed(() => {
  if (isExternalName.value) return []
  if (hasEndpoints.value) {
    const rows = []
    for (const ip of readyAddrs.value) rows.push({ ip, ready: true, pod: podByIp.value[ip] || null })
    for (const ip of notReadyAddrs.value) rows.push({ ip, ready: false, pod: podByIp.value[ip] || null })
    return rows
  }
  return selectorPods.value.map(pod => ({ ip: pod.ip, ready: pod.status === 'Running', pod }))
})
function goPod(pod) {
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: pod.name } })
}

// === RBAC：can-i(SSAR) 控制 Edit/Delete（默认允许，SSAR 不可用时不锁死）===
const canMutate = ref(true)
const canDelete = ref(true)
let permsLoaded = false
async function loadPerms() {
  if (!store.remoteMode || !svc.value) return
  const ns = route.params.namespace
  const [u, d] = await Promise.all([
    store.checkAccessServer({ verb: 'update', resource: 'services', namespace: ns }),
    store.checkAccessServer({ verb: 'delete', resource: 'services', namespace: ns }),
  ])
  if (u?.ok) canMutate.value = !!u.allowed
  if (d?.ok) canDelete.value = !!d.allowed
}
watch(svc, s => { if (s && !permsLoaded) { permsLoaded = true; loadPerms() } }, { immediate: true })

// === Events：按 involvedObject 过滤该 Service 的事件（mock 回退全量 ns 事件）===
const svcEvents = computed(() => store.remoteMode ? store.eventsFor('Service', svc.value?.name, svc.value?.namespace) : store.nsEvents)
function goToRelated(event) {
  if (!event.relatedKind || !event.relatedName) return
  const ns = event.relatedNamespace || route.params.namespace
  const k = event.relatedKind, name = event.relatedName
  if (k === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: ns, name } })
  else if (k === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: ns, name } })
  else if (k === 'Ingress') router.push({ name: 'NsIngressDetail', params: { namespace: ns, name } })
  else if (k === 'Endpoints') router.push({ name: 'NsEndpoints', params: { namespace: ns } })
}

// === YAML：远端拉取真实对象（去 managedFields/status），弹窗内可编辑 + apply ===
const svcYaml = ref('')
const yamlLoading = ref(false)
async function loadYaml() {
  if (!svc.value) return
  if (!store.remoteMode) { svcYaml.value = store.generateYAML('service', svc.value); return }
  yamlLoading.value = true
  try {
    const obj = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(svc.value.namespace)}/services/${encodeURIComponent(svc.value.name)}`)
    const clone = JSON.parse(JSON.stringify(obj))
    if (clone?.metadata) delete clone.metadata.managedFields
    if (clone?.status) delete clone.status
    svcYaml.value = yamlDump(clone)
  } catch (e) {
    svcYaml.value = `# 加载失败：${e.message || ''}`
  } finally {
    yamlLoading.value = false
  }
}
function openYaml() {
  showYamlModal.value = true
  if (!svcYaml.value) loadYaml()
}
watch(() => svc.value?.name, () => { svcYaml.value = '' })     // 切换 Service 重新加载
async function onYamlSave(yamlStr) {
  const res = await applyYaml(yamlStr)
  if (res?.ok) { svcYaml.value = ''; loadYaml() }
}
async function exportSvc() {
  if (!svc.value) return
  try {
    await exportYaml(`/api/v1/namespaces/${encodeURIComponent(svc.value.namespace)}/services/${encodeURIComponent(svc.value.name)}`, `${svc.value.name}.yaml`)
    notify('success', '已导出 YAML')
  } catch (e) { notify('error', e.message || '导出失败') }
}

// === 统一 Edit：Type · Ports · Selector · Session Affinity · Traffic Policy · ExternalName ===
const editForm = ref({ type: 'ClusterIP', ports: [], selector: [], externalName: '', sessionAffinity: 'None', sessionAffinityTimeout: 10800, externalTrafficPolicy: '', internalTrafficPolicy: 'Cluster' })
function openEdit() {
  if (!svc.value) return
  const rows = portRows.value.length
    ? portRows.value.map(p => ({ port: p.port, targetPort: p.targetPort ?? '', protocol: p.protocol || 'TCP', nodePort: p.nodePort || '' }))
    : [{ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }]
  editForm.value = {
    type: svc.value.type,
    ports: rows,
    selector: Object.entries(svc.value.selector || {}).map(([key, value]) => ({ key, value })),
    externalName: svc.value.externalName || '',
    sessionAffinity: svc.value.sessionAffinity || 'None',
    sessionAffinityTimeout: svc.value.sessionAffinityTimeout ?? 10800,
    externalTrafficPolicy: svc.value.externalTrafficPolicy || '',
    internalTrafficPolicy: svc.value.internalTrafficPolicy || 'Cluster',
  }
  showEditModal.value = true
}
function addPortRow() { editForm.value.ports.push({ port: '', targetPort: '', protocol: 'TCP', nodePort: '' }) }
function removePortRow(idx) { editForm.value.ports.splice(idx, 1) }
function addSelectorRow() { editForm.value.selector.push({ key: '', value: '' }) }
function removeSelectorRow(idx) { editForm.value.selector.splice(idx, 1) }
function saveEdit() {
  const rows = editForm.value.ports.filter(p => p.port !== '' && p.port != null)
  const portList = rows.map(p => {
    const tgt = p.targetPort === '' ? p.port : p.targetPort
    return { name: '', port: Number(p.port), targetPort: isNaN(tgt) ? tgt : Number(tgt), protocol: p.protocol || 'TCP', nodePort: p.nodePort ? Number(p.nodePort) : null, appProtocol: '' }
  })
  const portsStr = portList.map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(',')
  const selector = {}
  editForm.value.selector.forEach(r => { if (r.key.trim()) selector[r.key.trim()] = r.value })
  const updates = {
    type: editForm.value.type,
    portList,
    ports: portsStr,
    selector,
    internalTrafficPolicy: editForm.value.internalTrafficPolicy,
  }
  if (editForm.value.type === 'ExternalName' && editForm.value.externalName) updates.externalName = editForm.value.externalName
  if (editForm.value.sessionAffinity === 'ClientIP') {
    updates.sessionAffinity = 'ClientIP'
    if (editForm.value.sessionAffinityTimeout !== '' && editForm.value.sessionAffinityTimeout != null) updates.sessionAffinityTimeout = Number(editForm.value.sessionAffinityTimeout)
  } else {
    updates.sessionAffinity = 'None'
  }
  if (editForm.value.externalTrafficPolicy) updates.externalTrafficPolicy = editForm.value.externalTrafficPolicy
  store.updateService(route.params.name, route.params.namespace, updates)
  showEditModal.value = false
  notify('success', 'Service 已更新')
}

// === 头部 ⋮ 操作菜单 ===
function actionItems() {
  const items = [
    { label: 'Port Forward', icon: 'cable', action: () => { showPortForward.value = true } },
    { label: '查看 / 编辑 YAML', icon: 'description', action: openYaml },
  ]
  if (store.remoteMode) items.push({ label: '导出 YAML', icon: 'download', action: exportSvc })
  items.push({ label: 'Delete Service', icon: 'delete', danger: true, disabled: !canDelete.value, action: () => { showDeleteModal.value = true } })
  return items
}

async function handleDelete() {
  await store.deleteService(route.params.name, route.params.namespace)
  router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })
}

const typeIcon = { ClusterIP: 'lan', NodePort: 'cell_tower', LoadBalancer: 'cloud_sync', ExternalName: 'link' }
</script>

<template>
  <div class="animate-fade-in" v-if="svc">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Services', route: `/ns/${route.params.namespace}/services` },
      { label: route.params.name }
    ]" />

    <!-- Header：身份 + 状态 + Edit + ⋮ -->
    <div class="flex items-center justify-between mt-sm mb-sm flex-wrap gap-sm">
      <div class="flex items-center gap-sm min-w-0">
        <div class="w-10 h-10 rounded-xl bg-primary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-xl">{{ typeIcon[svc.type] || 'hub' }}</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-baseline gap-xs flex-wrap">
            <h1 class="text-headline-md text-on-surface font-bold truncate">{{ svc.name }}</h1>
            <span v-if="isExternalName" class="font-mono text-xs text-on-surface-variant truncate">→ {{ svc.externalName || '(未设置)' }}</span>
          </div>
          <div class="flex items-center gap-xs mt-0.5 flex-wrap">
            <span class="px-1.5 py-0.5 bg-primary/10 text-primary text-xs rounded font-medium">{{ svc.type }}</span>
            <span v-if="!isExternalName" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium"
              :class="endpointsHealthy ? 'bg-primary-container/10 text-primary' : 'bg-error-container/10 text-error'">
              <span class="w-1.5 h-1.5 rounded-full" :class="endpointsHealthy ? 'bg-primary' : 'bg-error'"></span>
              {{ readyCount }}/{{ totalCount }} ready
            </span>
            <span class="text-xs text-on-surface-variant">Age {{ svc.age }}</span>
            <span class="text-xs text-on-surface-variant">ns: <span class="text-primary font-medium">{{ svc.namespace }}</span></span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs shrink-0">
        <button @click="openEdit" :disabled="!canMutate" :title="!canMutate ? '无 update 权限' : ''"
          class="flex items-center gap-xs px-2.5 py-1 bg-primary text-on-primary font-semibold rounded-lg text-xs hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
          <span class="material-symbols-outlined text-sm">edit</span> Edit
        </button>
        <DropdownMenu :items="actionItems()" />
      </div>
    </div>

    <!-- 单页主体：左 8（连接/端口/端点）| 右 4（选择器/流量策略/元数据/事件）-->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-sm items-start">
      <!-- ===== 左列 ===== -->
      <div class="lg:col-span-8 flex flex-col gap-sm">
        <!-- Connection -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">cable</span>
            <span class="text-body-sm font-semibold">Connection</span>
          </div>
          <div class="p-sm grid grid-cols-2 gap-xs">
            <div v-if="isExternalName" class="col-span-2 p-sm rounded-md bg-surface-container-low">
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">External Name (CNAME)</p>
              <p class="font-mono text-xs text-primary font-semibold break-all">{{ svc.externalName || '—' }}</p>
            </div>
            <template v-else>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Cluster IP</p>
                <p class="font-mono text-xs text-primary font-semibold">{{ svc.clusterIP }}</p>
                <p v-if="svc.clusterIPs?.length > 1" class="font-mono text-[11px] text-on-surface-variant mt-0.5">{{ svc.clusterIPs.join(', ') }}</p>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">External IP</p>
                <div v-if="svc.externalIP && svc.externalIP !== '-'" class="flex flex-wrap gap-1">
                  <span v-for="ip in svc.externalIP.split(',')" :key="ip" class="font-mono text-xs text-primary font-semibold">{{ ip }}</span>
                </div>
                <p v-else class="font-mono text-xs text-on-surface-variant">—</p>
              </div>
              <div v-if="svc.lbIngress?.length" class="col-span-2 p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">LoadBalancer Ingress</p>
                <div class="flex flex-wrap gap-1">
                  <span v-for="(lb, i) in svc.lbIngress" :key="i" class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-primary-container/10 text-primary text-[11px] rounded-full border border-primary/20 font-mono">
                    <span class="material-symbols-outlined text-xs">cloud_done</span>{{ lb.ip || lb.hostname }}
                  </span>
                </div>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Session Affinity</p>
                <p class="text-xs font-semibold text-on-surface">{{ svc.sessionAffinity }}<span v-if="svc.sessionAffinityTimeout" class="text-on-surface-variant font-normal"> · {{ svc.sessionAffinityTimeout }}s</span></p>
              </div>
              <div class="p-sm rounded-md bg-surface-container-low">
                <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">IP Family</p>
                <p class="text-xs font-semibold text-on-surface">{{ svc.ipFamilyPolicy || (svc.ipFamilies?.length ? svc.ipFamilies.join('/') : 'IPv4') }}</p>
              </div>
            </template>
          </div>
        </div>

        <!-- Ports -->
        <div v-if="!isExternalName" class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs">
              <span class="material-symbols-outlined text-primary text-base">swap_horiz</span>
              <span class="text-body-sm font-semibold">Ports</span>
            </div>
            <span class="text-xs text-on-surface-variant">{{ portRows.length }} 个</span>
          </div>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-surface-container-low border-b border-outline-variant">
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Name</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Port</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Target</th>
                <th v-if="hasNodePort" class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Node Port</th>
                <th class="px-sm py-1.5 text-xs font-medium text-on-surface-variant">Protocol</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              <tr v-for="(p, i) in portRows" :key="i" class="hover:bg-surface-container-low/40 transition-colors">
                <td class="px-sm py-1.5 text-xs text-on-surface-variant font-mono">{{ p.name || '—' }}</td>
                <td class="px-sm py-1.5 font-mono text-xs text-primary font-semibold">{{ p.port }}</td>
                <td class="px-sm py-1.5 font-mono text-xs text-on-surface">{{ p.targetPort }}</td>
                <td v-if="hasNodePort" class="px-sm py-1.5 font-mono text-xs" :class="p.nodePort ? 'text-tertiary-container font-semibold' : 'text-on-surface-variant'">{{ p.nodePort || '—' }}</td>
                <td class="px-sm py-1.5"><span class="px-1.5 py-0.5 bg-surface-container rounded text-xs font-mono text-on-surface-variant">{{ p.protocol }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Endpoints -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs">
              <span class="material-symbols-outlined text-primary text-base">hub</span>
              <span class="text-body-sm font-semibold">Endpoints</span>
            </div>
            <span v-if="!isExternalName" class="text-xs font-medium" :class="endpointsHealthy ? 'text-primary' : 'text-error'">{{ readyCount }}/{{ totalCount }} ready</span>
          </div>
          <!-- ExternalName -->
          <div v-if="isExternalName" class="p-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-xl">link</span>
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide">ExternalName 目标</p>
              <p class="font-mono text-xs text-primary font-semibold break-all">{{ svc.externalName || '—' }}</p>
            </div>
          </div>
          <!-- 后端 Pod 列表（真实端点 / selector 回退 统一渲染）-->
          <div v-else-if="backendPods.length" class="p-sm max-h-96 overflow-y-auto flex flex-col gap-xs">
            <template v-for="(item, idx) in backendPods" :key="idx">
              <!-- 有 backing pod：统一 PodCard（与 Workload 详情同组件）-->
              <PodCard v-if="item.pod" :pod="item.pod" :ready="item.ready" :show-lifecycle="false" @click="goPod" />
              <!-- 无 backing pod：仅 IP（外部端点 / Pod 不在本命名空间）-->
              <div v-else class="rounded-lg border border-dashed border-outline-variant p-sm flex items-center gap-xs">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="item.ready ? 'bg-primary' : 'bg-tertiary-fixed'"></span>
                <span class="font-mono text-xs text-on-surface-variant">{{ item.ip }}</span>
                <span class="text-[11px] text-on-surface-variant/50">未关联到本命名空间 Pod</span>
                <span class="ml-auto text-[11px] font-medium" :class="item.ready ? 'text-primary' : 'text-tertiary-container'">{{ item.ready ? 'Ready' : 'Not Ready' }}</span>
              </div>
            </template>
          </div>
          <!-- 空 -->
          <div v-else class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
            <p class="text-xs mt-xs">该 Service 暂无后端 Pod</p>
            <p class="text-[11px] text-on-surface-variant/70 mt-xs" v-if="svc.selector && Object.keys(svc.selector).length">检查 selector 是否匹配到健康 Pod，或后端 Pod 是否通过 readinessProbe</p>
          </div>
        </div>
      </div>

      <!-- ===== 右列 ===== -->
      <div class="lg:col-span-4 flex flex-col gap-sm">
        <!-- Selector -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">filter_alt</span>
            <span class="text-body-sm font-semibold">Selector</span>
          </div>
          <div class="p-sm flex flex-wrap gap-xs">
            <template v-if="Object.keys(svc.selector || {}).length">
              <span v-for="(val, key) in svc.selector" :key="key" class="px-1.5 py-0.5 bg-primary-container/10 text-primary text-xs rounded border border-primary/20 font-mono">
                <span class="font-semibold">{{ key }}</span>={{ val }}
              </span>
            </template>
            <p v-else class="text-xs text-on-surface-variant italic">No selector（ExternalName / headless 手动 Endpoints）</p>
          </div>
        </div>

        <!-- Traffic Policy（只读）-->
        <div v-if="!isExternalName" class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">alt_route</span>
            <span class="text-body-sm font-semibold">Traffic Policy</span>
          </div>
          <div class="px-sm py-xs">
            <div class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">External</span>
              <span class="text-xs font-semibold text-on-surface">{{ svc.externalTrafficPolicy || 'Cluster（默认）' }}</span>
            </div>
            <div class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">Internal</span>
              <span class="text-xs font-semibold text-on-surface">{{ svc.internalTrafficPolicy || 'Cluster' }}</span>
            </div>
            <div v-if="svc.healthCheckNodePort" class="flex justify-between items-center py-1 border-b border-outline-variant/30">
              <span class="text-xs text-on-surface-variant">Health Node Port</span>
              <span class="font-mono text-xs text-on-surface">{{ svc.healthCheckNodePort }}</span>
            </div>
            <div v-if="svc.publishNotReadyAddresses" class="flex justify-between items-center py-1">
              <span class="text-xs text-on-surface-variant">Publish Not Ready</span>
              <span class="text-xs text-tertiary-container font-semibold">true</span>
            </div>
          </div>
        </div>

        <!-- Metadata -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center gap-xs">
            <span class="material-symbols-outlined text-primary text-base">sell</span>
            <span class="text-body-sm font-semibold">Metadata</span>
          </div>
          <div class="px-sm py-xs flex flex-col gap-xs">
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Labels</p>
              <div v-if="Object.keys(svc.labels || {}).length" class="flex flex-wrap gap-1">
                <span v-for="(val, key) in svc.labels" :key="key" class="px-1.5 py-0.5 bg-surface-container rounded text-[11px] border border-outline-variant font-mono">{{ key }}: {{ val }}</span>
              </div>
              <p v-else class="text-xs text-on-surface-variant italic">—</p>
            </div>
            <div>
              <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide mb-0.5">Annotations</p>
              <div v-if="Object.keys(svc.annotations || {}).length" class="bg-surface-container p-xs rounded border border-outline-variant font-mono text-[11px] text-on-surface-variant max-h-32 overflow-y-auto">
                <div v-for="(val, key) in svc.annotations" :key="key" class="truncate" :title="`${key}: ${val}`">{{ key }}</div>
              </div>
              <p v-else class="text-xs text-on-surface-variant italic">—</p>
            </div>
          </div>
        </div>

        <!-- Recent Events -->
        <div class="rounded-lg overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-sm py-1.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-xs">
              <span class="material-symbols-outlined text-primary text-base">event_note</span>
              <span class="text-body-sm font-semibold">Events</span>
            </div>
            <span class="text-xs text-on-surface-variant">{{ svcEvents.length }}</span>
          </div>
          <div class="p-sm max-h-72 overflow-y-auto flex flex-col gap-0">
            <div v-for="(event, idx) in svcEvents" :key="idx"
              class="flex gap-xs py-1 border-b border-outline-variant/20 last:border-0"
              :class="event.relatedKind ? 'cursor-pointer hover:bg-surface-container-low/50 rounded -mx-xs px-xs transition-colors' : ''"
              @click="goToRelated(event)">
              <span class="material-symbols-outlined text-sm shrink-0 mt-0.5"
                :class="event.color === 'primary' ? 'text-primary' : event.color === 'error' ? 'text-error' : event.color === 'tertiary' ? 'text-tertiary-container' : 'text-on-surface-variant'">{{ event.icon }}</span>
              <div class="flex-1 min-w-0">
                <div class="flex justify-between gap-xs">
                  <span class="text-xs font-semibold text-on-surface truncate">{{ event.reason }}</span>
                  <span class="font-mono text-[10px] text-on-surface-variant shrink-0">{{ event.time }}</span>
                </div>
                <p class="text-[11px] text-on-surface-variant truncate">{{ event.message }}</p>
              </div>
            </div>
            <p v-if="!svcEvents.length" class="text-xs text-on-surface-variant italic text-center py-sm">暂无事件</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Not Found -->
  <div v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">Service Not Found</h2>
    <p class="text-body-md text-on-surface-variant mt-sm">Service "{{ route.params.name }}" not found in namespace "{{ route.params.namespace }}"</p>
    <button @click="router.push({ name: 'NsServices', params: { namespace: route.params.namespace } })" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to Services</button>
  </div>

  <!-- 统一 Edit 弹窗 -->
  <Modal v-model="showEditModal" title="Edit Service" width="max-w-2xl">
    <div class="flex flex-col gap-md max-h-[60vh] overflow-y-auto pr-sm -mt-xs">
      <!-- Service Type -->
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Service Type</label>
        <div class="flex flex-wrap gap-xs">
          <button v-for="st in ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']" :key="st" type="button" @click="editForm.type = st"
            class="px-md py-sm rounded-lg border font-medium text-body-sm transition-all"
            :class="editForm.type === st ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
            {{ st }}
          </button>
        </div>
      </div>

      <!-- ExternalName 目标 -->
      <div v-if="editForm.type === 'ExternalName'">
        <label class="text-label-caps text-on-surface-variant block mb-xs">External Name</label>
        <input v-model="editForm.externalName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="my-service.example.com" />
        <p class="text-xs text-on-surface-variant/60 mt-xs">ExternalName 通过外部 DNS 名路由（CNAME），无端口 / 选择器。</p>
      </div>

      <!-- Ports（结构化）-->
      <div v-else>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Ports</label>
          <button @click="addPortRow" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add Port
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(p, idx) in editForm.ports" :key="idx" class="flex gap-xs items-center flex-wrap">
            <input v-model="p.port" type="number" class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="port" />
            <span class="text-on-surface-variant text-body-sm">→</span>
            <PortSelect v-model="p.targetPort" :options="store.nsContainerPorts" placeholder="target" empty-hint="当前命名空间暂无工作负载暴露容器端口，可直接输入" input-class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
            <select v-model="p.protocol" class="bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
              <option>TCP</option><option>UDP</option><option>SCTP</option>
            </select>
            <input v-if="editForm.type === 'NodePort' || editForm.type === 'LoadBalancer'" v-model="p.nodePort" type="number" class="w-24 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="nodePort" />
            <button @click="removePortRow(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
          <p v-if="!editForm.ports.length" class="text-body-sm text-on-surface-variant italic">无端口</p>
        </div>
      </div>

      <!-- Selector -->
      <div>
        <div class="flex items-center justify-between mb-xs">
          <label class="text-label-caps text-on-surface-variant">Selector</label>
          <button @click="addSelectorRow" type="button" class="flex items-center gap-xs text-body-sm text-primary font-semibold hover:underline">
            <span class="material-symbols-outlined text-sm">add</span> Add
          </button>
        </div>
        <div class="flex flex-col gap-xs">
          <div v-for="(row, idx) in editForm.selector" :key="idx" class="flex gap-xs items-center">
            <input v-model="row.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="app" />
            <span class="text-on-surface-variant text-body-sm">=</span>
            <input v-model="row.value" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="my-app" />
            <button @click="removeSelectorRow(idx)" type="button" class="p-xs text-on-surface-variant hover:text-error rounded-lg">
              <span class="material-symbols-outlined text-lg">remove</span>
            </button>
          </div>
          <p v-if="!editForm.selector.length" class="text-body-sm text-on-surface-variant italic">No selector（ExternalName / headless）</p>
        </div>
      </div>

      <!-- Session Affinity -->
      <div class="grid grid-cols-2 gap-md items-end">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Session Affinity</label>
          <select v-model="editForm.sessionAffinity" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="None">None（负载均衡）</option>
            <option value="ClientIP">ClientIP（会话保持）</option>
          </select>
        </div>
        <div v-if="editForm.sessionAffinity === 'ClientIP'">
          <label class="text-label-caps text-on-surface-variant block mb-xs">Timeout (s)</label>
          <input v-model.number="editForm.sessionAffinityTimeout" type="number" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        </div>
      </div>

      <!-- Traffic Policy -->
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">External Traffic</label>
          <select v-model="editForm.externalTrafficPolicy" :disabled="editForm.type !== 'NodePort' && editForm.type !== 'LoadBalancer'" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary disabled:opacity-50">
            <option value="">默认（Cluster）</option>
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Internal Traffic</label>
          <select v-model="editForm.internalTrafficPolicy" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-sm py-sm text-body-sm focus:ring-2 focus:ring-primary">
            <option value="Cluster">Cluster</option>
            <option value="Local">Local</option>
          </select>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showEditModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveEdit" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">Save</button>
    </template>
  </Modal>

  <!-- YAML 弹窗 -->
  <Modal v-model="showYamlModal" title="Service YAML" width="max-w-4xl">
    <p v-if="yamlLoading" class="text-body-sm text-on-surface-variant">加载 YAML…</p>
    <YamlEditor v-else :model-value="svcYaml" :readonly="false" height="60vh" @save="onYamlSave" />
    <template #actions>
      <button @click="showYamlModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Close</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Service" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete service <span class="text-on-surface font-semibold">{{ route.params.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will disrupt traffic to the backend pods. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Port Forward Panel -->
  <PortForwardPanel v-model="showPortForward" kind="Service" :name="route.params.name" :namespace="route.params.namespace" :suggested-ports="forwardPorts" />
</template>
