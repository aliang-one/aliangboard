<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useResourceApply } from '@/composables/useResourceApply'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'
import PortSelect from '@/components/common/PortSelect.vue'
import AnnotationKeySelect from '@/components/common/AnnotationKeySelect.vue'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
store.setNamespace(route.params.namespace)

// 详情走 Vue Query（单资源 + 15s 轮询）；store CRUD 已接 invalidateResource('ingresses')，编辑后自动刷新。
const cid = computed(() => (store.remoteMode ? (store.currentCluster || 'cluster') : 'demo'))
const ingDetail = useResourceDetail({
  key: ['cluster', cid.value, 'ingresses', route.params.name],
  fetcher: () => store.fetchIngress(route.params.name, route.params.namespace),
  mock: store.getIngressByName(route.params.name, route.params.namespace),
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 15000 : false },
})
const ing = computed(() => ingDetail.data.value ?? store.getIngressByName(route.params.name, route.params.namespace))
const yaml = computed(() => store.generateYAML('ingress', ing.value))

const ingressClassesQuery = useResourceList({
  key: ['cluster', cid.value, 'ingressclasses'],
  fetcher: () => store.fetchIngressClasses(),
  mock: store.ingressClassList,
  mockMode: !store.remoteMode,
  options: { refetchInterval: store.remoteMode ? 30000 : false },
})
const ingressClasses = computed(() => ingressClassesQuery.data.value || [])
// Service 下拉源走 Vue Query（nsServices.value 在 remote 下孤立）
const svcQ = useResourceList({ key: ['cluster', cid.value, 'services'], fetcher: () => store.fetchServices(), mock: store.serviceList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })
const nsServices = computed(() => (svcQ.data.value || []).filter(s => s.namespace === route.params.namespace))
const svcByName = (name, ns) => (svcQ.data.value || []).find(s => s.name === name && s.namespace === ns)
// TLS Secret 下拉源走 Vue Query（store.nsSecrets 在 remote 下孤立）
const _secQ = useResourceList({ key: ['cluster', cid.value, 'secrets'], fetcher: () => store.fetchSecrets(), mock: store.secretList, mockMode: !store.remoteMode, options: { refetchInterval: store.remoteMode ? 30000 : false } })
const allSecrets = computed(() => _secQ.data.value || [])

const showDeleteModal = ref(false)

async function handleDelete() {
  await store.deleteIngress(route.params.name, route.params.namespace)
  router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })
}

const allRules = computed(() => {
  if (!ing.value?.rules) return []
  return ing.value.rules.flatMap(r =>
    (r.http?.paths || []).map(p => {
      const svc = p.backend?.service || p.backend
      return {
        host: r.host,
        path: p.path,
        pathType: p.pathType,
        serviceName: svc?.name ?? svc?.serviceName ?? '',
        servicePort: svc?.port?.number ?? svc?.port?.name ?? svc?.servicePort ?? '',
      }
    })
  )
})

// 路由规则按域名分组（同名 host 聚合，更贴近「一个域名 → 多 path」的真实结构）
const rulesByHost = computed(() => {
  const map = {}
  for (const r of allRules.value) {
    const h = r.host || '*'
    ;(map[h] ||= []).push(r)
  }
  return Object.entries(map).map(([host, paths]) => ({ host, paths }))
})
// 涉及的独立域名
const hostList = computed(() => [...new Set(allRules.value.map(r => r.host).filter(Boolean))])
// 去重的后端服务（右侧面板展示，可点击跳转）
const backendServices = computed(() => {
  const seen = new Set(), out = []
  for (const r of allRules.value) {
    if (r.serviceName && !seen.has(r.serviceName)) { seen.add(r.serviceName); out.push(r.serviceName) }
  }
  return out
})

// === Rules 结构化编辑（按 host 分组 + defaultBackend + 校验 + 操作）===
const showRulesModal = ref(false)
const pathTypeOptions = ['Prefix', 'Exact', 'ImplementationSpecific']
// 当前 ns Service 名候选（serviceName 下拉）
const nsServiceNames = computed(() => nsServices.value.map(s => s.name))
// 按行 serviceName 取其暴露端口（servicePort 下拉）
function portsFor(serviceName) {
  const svc = svcByName(serviceName, route.params.namespace)
  return (svc?.portList || []).map(p => p.port)
}
// 编辑模型：host 分组 + defaultBackend（告别平铺 editRules）
const editModel = ref({ hosts: [], defaultBackend: { enabled: false, serviceName: '', servicePort: '' } })

function openRulesEditor() {
  const byHost = {}
  for (const r of allRules.value) {
    const h = r.host || ''
    ;(byHost[h] ||= []).push({ path: r.path || '/', pathType: r.pathType || 'Prefix', serviceName: r.serviceName || '', servicePort: String(r.servicePort ?? '') })
  }
  const hosts = Object.entries(byHost).map(([host, paths]) => ({ host, paths }))
  if (!hosts.length) hosts.push({ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] })
  const db = ing.value?.defaultBackend
  editModel.value = {
    hosts,
    defaultBackend: db && db.serviceName
      ? { enabled: true, serviceName: db.serviceName, servicePort: db.servicePort }
      : { enabled: false, serviceName: '', servicePort: '' },
  }
  showRulesModal.value = true
}
// host / path 增删
function addHost() { editModel.value.hosts.push({ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] }) }
function removeHost(hi) { editModel.value.hosts.splice(hi, 1) }
function addPath(hi) { editModel.value.hosts[hi].paths.push({ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }) }
function removePath(hi, i) { editModel.value.hosts[hi].paths.splice(i, 1) }
// 复制 / 上下移
function duplicateHost(hi) {
  const h = editModel.value.hosts[hi]
  editModel.value.hosts.splice(hi + 1, 0, { host: h.host ? h.host + '-copy' : '', paths: h.paths.map(p => ({ ...p })) })
}
function moveHost(hi, dir) {
  const j = hi + dir
  if (j < 0 || j >= editModel.value.hosts.length) return
  const a = editModel.value.hosts, t = a[hi]; a[hi] = a[j]; a[j] = t
}
function duplicatePath(hi, i) {
  editModel.value.hosts[hi].paths.splice(i + 1, 0, { ...editModel.value.hosts[hi].paths[i] })
}
function movePath(hi, i, dir) {
  const paths = editModel.value.hosts[hi].paths, j = i + dir
  if (j < 0 || j >= paths.length) return
  const t = paths[i]; paths[i] = paths[j]; paths[j] = t
}
const showClearConfirm = ref(false)
function clearAll() {
  editModel.value.hosts = []
  editModel.value.defaultBackend = { enabled: false, serviceName: '', servicePort: '' }
  showClearConfirm.value = false
}
// 校验：错误列表，用于顶部汇总 + 行标红 + Save 禁用
const errors = computed(() => {
  const errs = []
  editModel.value.hosts.forEach((h, hi) => {
    const seen = {}
    h.paths.forEach((p, i) => {
      const loc = `host[${hi}].path[${i}]`
      if (!p.path) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathRequired') })
      else if (!p.path.startsWith('/')) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathSlash', { val: p.path }) })
      else { if (seen[p.path]) errs.push({ loc: `host[${hi}]`, field: 'path', msg: t('ns.ingressDetail.valPathDup', { val: p.path }) }); seen[p.path] = true }
      if (!p.serviceName) errs.push({ loc, field: 'serviceName', msg: t('ns.ingressDetail.valSvcRequired') })
      if (!p.servicePort) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortRequired') })
      else if (isNaN(Number(p.servicePort))) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortNumber', { val: p.servicePort }) })
    })
  })
  const db = editModel.value.defaultBackend
  if (db.enabled) {
    if (!db.serviceName) errs.push({ loc: 'defaultBackend', field: 'serviceName', msg: t('ns.ingressDetail.valDefaultSvcRequired') })
    if (!db.servicePort) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortRequired') })
    else if (isNaN(Number(db.servicePort))) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortNumber') })
  }
  return errs
})
function fieldError(hi, i, field) {
  return errors.value.find(e => e.loc === `host[${hi}].path[${i}]` && e.field === field)
}
async function saveRules() {
  if (errors.value.length) return
  const flat = editModel.value.hosts.flatMap(h => h.paths.map(p => ({ host: h.host, path: p.path, pathType: p.pathType, serviceName: p.serviceName, servicePort: p.servicePort })))
  try {
    await store.updateIngressRules(route.params.name, route.params.namespace, flat, editModel.value.defaultBackend)
    showRulesModal.value = false
  } catch (e) { notify('error', e.message || t('ns.ingressDetail.saveRulesFailed')) }
}

// === IngressClass / TLS 编辑（远端 regenerate + apply）===
const showClassModal = ref(false)
const editClassName = ref('')
function openClassEditor() { editClassName.value = ing.value?.className || ''; showClassModal.value = true }
function saveClassName() {
  store.updateIngress(route.params.name, route.params.namespace, { className: editClassName.value })
  showClassModal.value = false
}
const showTlsModal = ref(false)
const editTls = ref(false)
const editTlsSecret = ref('')
function openTlsEditor() { editTls.value = ing.value?.tls || false; editTlsSecret.value = ing.value?.tlsSecret || ''; showTlsModal.value = true }
function saveTls() {
  store.updateIngress(route.params.name, route.params.namespace, { tls: editTls.value, tlsSecret: editTlsSecret.value })
  showTlsModal.value = false
}

const allAnnotations = computed(() => {
  if (!ing.value?.annotations) return []
  return Object.entries(ing.value.annotations)
})

const allLabels = computed(() => {
  if (!ing.value?.labels) return []
  return Object.entries(ing.value.labels)
})

// === Annotations 编辑 ===
const showAddAnnModal = ref(false)
const newAnnKey = ref('')
const newAnnValue = ref('')
const editingAnn = ref(null)
const editAnnValue = ref('')

function addAnnotation() {
  if (!newAnnKey.value) return
  const annotations = { ...(ing.value.annotations || {}) }
  annotations[newAnnKey.value] = newAnnValue.value
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
  newAnnKey.value = ''
  newAnnValue.value = ''
  showAddAnnModal.value = false
}
function deleteAnnotation(key) {
  const annotations = { ...ing.value.annotations }
  delete annotations[key]
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
}
function startEditAnn(key) { editingAnn.value = key; editAnnValue.value = ing.value.annotations[key] }
function saveEditAnn() {
  if (editingAnn.value === null) return
  const annotations = { ...ing.value.annotations }
  annotations[editingAnn.value] = editAnnValue.value
  store.updateIngress(route.params.name, route.params.namespace, { annotations })
  editingAnn.value = null
}

// === Labels 编辑 ===
const showAddLabelModal = ref(false)
const newLabelKey = ref('')
const newLabelValue = ref('')
const editingLabel = ref(null)
const editLabelValue = ref('')

function addLabel() {
  if (!newLabelKey.value) return
  const labels = { ...(ing.value.labels || {}) }
  labels[newLabelKey.value] = newLabelValue.value
  store.updateIngress(route.params.name, route.params.namespace, { labels })
  newLabelKey.value = ''
  newLabelValue.value = ''
  showAddLabelModal.value = false
}
function deleteLabel(key) {
  const labels = { ...ing.value.labels }
  delete labels[key]
  store.updateIngress(route.params.name, route.params.namespace, { labels })
}
function startEditLabel(key) { editingLabel.value = key; editLabelValue.value = ing.value.labels[key] }
function saveEditLabel() {
  if (editingLabel.value === null) return
  const labels = { ...ing.value.labels }
  labels[editingLabel.value] = editLabelValue.value
  store.updateIngress(route.params.name, route.params.namespace, { labels })
  editingLabel.value = null
}
</script>

<template>
  <div class="animate-fade-in" v-if="ing">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Ingress', route: `/ns/${route.params.namespace}/ingress` },
      { label: route.params.name }
    ]" />

    <!-- Hero -->
    <div class="flex items-start justify-between gap-md mt-sm mb-md">
      <div class="flex items-start gap-md min-w-0">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center shrink-0 ring-1 ring-primary/10">
          <span class="material-symbols-outlined text-primary text-2xl">language</span>
        </div>
        <div class="min-w-0">
          <h1 class="text-headline-md font-bold text-on-surface truncate">{{ ing.name }}</h1>
          <div class="flex items-center gap-xs flex-wrap mt-xs">
            <span class="px-2 py-0.5 bg-primary/8 text-primary text-xs rounded-md font-medium">{{ $t('ns.ingressDetail.ingress') }}</span>
            <span v-if="ing.className" class="px-2 py-0.5 bg-surface-container text-on-surface-variant text-xs rounded-md font-medium border border-outline-variant">{{ ing.className }}</span>
            <span class="flex items-center gap-0.5 px-2 py-0.5 text-xs rounded-md font-medium" :class="ing.tls ? 'bg-primary-container/15 text-primary' : 'bg-surface-container text-on-surface-variant border border-outline-variant'">
              <span class="material-symbols-outlined text-sm">{{ ing.tls ? 'lock' : 'lock_open' }}</span>{{ ing.tls ? $t('ns.ingressDetail.tls') : $t('ns.ingressDetail.noTls') }}
            </span>
            <span class="text-xs text-on-surface-variant">{{ $t('ns.ingressDetail.rulesCount', { n: allRules.length, hosts: hostList.length, age: ing.age }) }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs shrink-0">
        <button @click="openRulesEditor" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
          <span class="material-symbols-outlined text-sm">edit</span> {{ $t('ns.ingressDetail.editRules') }}
        </button>
        <button @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">{{ $t('ns.ingressDetail.delete') }}</button>
      </div>
    </div>

    <!-- 主体：左=路由规则 + YAML | 右=配置/后端/标签/注解 -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-sm items-start">

      <!-- ===== 左列 ===== -->
      <div class="lg:col-span-8 flex flex-col gap-sm">

        <!-- 路由规则（按域名分组，核心内容置顶）-->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/50 bg-surface-container-low flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">alt_route</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.routesTitle') }}</span>
            <span class="text-xs text-on-surface-variant">{{ $t('ns.ingressDetail.routesSummary', { n: allRules.length, hosts: hostList.length }) }}</span>
          </div>
          <div v-if="rulesByHost.length" class="p-sm flex flex-col gap-sm">
            <div v-for="group in rulesByHost" :key="group.host" class="rounded-lg border border-outline-variant/60 overflow-hidden">
              <div class="px-sm py-1.5 bg-surface-container-low flex items-center gap-xs">
                <span class="material-symbols-outlined text-primary text-base">language</span>
                <span class="font-mono text-code-sm text-primary font-semibold truncate">{{ group.host }}</span>
                <span class="ml-auto text-[10px] text-on-surface-variant shrink-0">{{ group.paths.length }} path</span>
              </div>
              <div class="divide-y divide-outline-variant/20">
                <div v-for="(p, i) in group.paths" :key="i" class="px-sm py-1.5 flex items-center gap-sm flex-wrap">
                  <span class="font-mono text-xs text-on-surface px-1.5 py-0.5 rounded bg-surface-container">{{ p.path }}</span>
                  <span class="text-[10px] px-1.5 py-0.5 rounded border border-outline-variant text-on-surface-variant">{{ p.pathType }}</span>
                  <span class="material-symbols-outlined text-on-surface-variant/40 text-base">arrow_forward</span>
                  <span class="font-mono text-xs text-secondary font-medium cursor-pointer hover:text-primary hover:underline" @click="p.serviceName && router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: p.serviceName } })">{{ p.serviceName || '—' }}</span>
                  <span class="font-mono text-xs text-on-surface-variant">:{{ p.servicePort }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="p-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-2xl text-surface-container-high">alt_route</span>
            <p class="text-body-sm mt-xs">{{ $t('ns.ingressDetail.noRoutes') }}</p>
          </div>
        </div>

        <!-- YAML（折叠，默认收起）-->
        <details class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant group">
          <summary class="px-md py-2 flex items-center gap-sm cursor-pointer hover:bg-surface-container-low transition-colors list-none">
            <span class="material-symbols-outlined text-on-surface-variant text-base group-open:rotate-90 transition-transform">chevron_right</span>
            <span class="material-symbols-outlined text-primary text-lg">code</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.yaml') }}</span>
            <span class="ml-auto text-xs text-on-surface-variant">{{ $t('ns.ingressDetail.yamlHint') }}</span>
          </summary>
          <div class="border-t border-outline-variant/50">
            <YamlEditor :model-value="yaml" :readonly="false" height="420px" @save="applyYaml" />
          </div>
        </details>
      </div>

      <!-- ===== 右列 ===== -->
      <div class="lg:col-span-4 flex flex-col gap-sm">

        <!-- 配置 -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">tune</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.configTitle') }}</span>
          </div>
          <div class="divide-y divide-outline-variant/15">
            <div class="px-md py-2 flex items-center justify-between gap-sm">
              <span class="text-xs text-on-surface-variant shrink-0">{{ $t('ns.ingressDetail.ingressClass') }}</span>
              <div class="flex items-center gap-xs min-w-0">
                <span class="text-body-sm text-on-surface truncate">{{ ing.className || $t('ns.ingressDetail.defaultClass') }}</span>
                <button @click="openClassEditor" class="p-0.5 text-on-surface-variant hover:text-primary rounded shrink-0" :title="$t('ns.ingressDetail.editClassTitle')"><span class="material-symbols-outlined text-base">edit</span></button>
              </div>
            </div>
            <div class="px-md py-2 flex items-center justify-between gap-sm">
              <span class="text-xs text-on-surface-variant shrink-0">{{ $t('ns.ingressDetail.tls') }}</span>
              <div class="flex items-center gap-xs">
                <span class="flex items-center gap-0.5 text-body-sm" :class="ing.tls ? 'text-primary font-medium' : 'text-on-surface-variant'">
                  <span class="material-symbols-outlined text-sm">{{ ing.tls ? 'lock' : 'lock_open' }}</span>{{ ing.tls ? $t('ns.ingressDetail.tlsEnabled') : $t('ns.ingressDetail.tlsDisabled') }}
                </span>
                <button @click="openTlsEditor" class="p-0.5 text-on-surface-variant hover:text-primary rounded shrink-0" :title="$t('ns.ingressDetail.editTlsTitle')"><span class="material-symbols-outlined text-base">edit</span></button>
              </div>
            </div>
            <div v-if="ing.tlsSecret" class="px-md py-2 flex items-center justify-between gap-sm">
              <span class="text-xs text-on-surface-variant shrink-0">{{ $t('ns.ingressDetail.tlsSecret') }}</span>
              <span class="font-mono text-xs text-on-surface truncate" :title="ing.tlsSecret">{{ ing.tlsSecret }}</span>
            </div>
            <div class="px-md py-2 flex items-center justify-between">
              <span class="text-xs text-on-surface-variant">{{ $t('ns.ingressDetail.createdAt') }}</span>
              <span class="text-body-sm text-on-surface">{{ ing.age }}</span>
            </div>
          </div>
        </div>

        <!-- 后端服务 -->
        <div v-if="backendServices.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">hub</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.backendTitle') }}</span>
            <span class="ml-auto text-xs text-on-surface-variant">{{ backendServices.length }}</span>
          </div>
          <div class="p-sm flex flex-wrap gap-xs">
            <button v-for="svc in backendServices" :key="svc" @click="router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: svc } })" class="flex items-center gap-0.5 px-2 py-0.5 rounded-md bg-primary-container/10 text-primary text-xs font-mono font-medium hover:bg-primary-container/20 transition-colors">
              <span class="material-symbols-outlined text-sm">share</span>{{ svc }}
            </button>
          </div>
        </div>

        <!-- Labels -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">sell</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.labelsTitle') }}</span>
            <span class="ml-auto text-xs text-on-surface-variant">{{ allLabels.length }}</span>
            <button @click="showAddLabelModal = true" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="$t('ns.ingressDetail.addLabel')"><span class="material-symbols-outlined text-base">add</span></button>
          </div>
          <div class="p-sm flex flex-wrap gap-xs">
            <span v-for="([k, v]) in allLabels" :key="k" class="group inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-container text-[11px] border border-outline-variant font-mono">
              <span class="text-secondary font-semibold">{{ k }}</span><span class="text-on-surface-variant">:{{ v }}</span>
              <button @click="deleteLabel(k)" class="opacity-0 group-hover:opacity-100 text-on-surface-variant hover:text-error transition-opacity" title="Delete"><span class="material-symbols-outlined text-xs">close</span></button>
            </span>
            <span v-if="!allLabels.length" class="text-xs text-on-surface-variant/50 py-xs">{{ $t('ns.ingressDetail.noLabels') }}</span>
          </div>
        </div>

        <!-- Annotations -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">label</span>
            <span class="text-body-sm font-semibold">{{ $t('ns.ingressDetail.annotationsTitle') }}</span>
            <span class="ml-auto text-xs text-on-surface-variant">{{ allAnnotations.length }}</span>
            <button @click="showAddAnnModal = true" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="$t('ns.ingressDetail.addAnnotation')"><span class="material-symbols-outlined text-base">add</span></button>
          </div>
          <div class="divide-y divide-outline-variant/15 max-h-80 overflow-y-auto">
            <div v-for="([key, val], idx) in allAnnotations" :key="idx" class="px-md py-1.5 group">
              <div class="flex items-center justify-between gap-xs">
                <span class="font-mono text-[11px] text-primary font-semibold truncate" :title="key">{{ key }}</span>
                <div class="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button v-if="editingAnn !== key" @click="startEditAnn(key)" class="p-0.5 text-on-surface-variant hover:text-primary rounded"><span class="material-symbols-outlined text-sm">edit</span></button>
                  <button @click="deleteAnnotation(key)" class="p-0.5 text-on-surface-variant hover:text-error rounded"><span class="material-symbols-outlined text-sm">delete</span></button>
                </div>
              </div>
              <div v-if="editingAnn === key" class="flex gap-xs mt-1">
                <textarea v-model="editAnnValue" class="flex-1 bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-xs font-mono min-h-[48px] resize-y focus:ring-1 focus:ring-primary"></textarea>
                <div class="flex flex-col gap-0.5">
                  <button @click="saveEditAnn" class="px-2 py-0.5 bg-primary text-on-primary rounded text-xs font-semibold">{{ $t('ns.ingressDetail.save') }}</button>
                  <button @click="editingAnn = null" class="px-2 py-0.5 border border-outline-variant rounded text-xs">{{ $t('ns.ingressDetail.cancel') }}</button>
                </div>
              </div>
              <p v-else class="font-mono text-[11px] text-on-surface-variant mt-0.5 break-all line-clamp-2" :title="val">{{ val }}</p>
            </div>
            <div v-if="!allAnnotations.length" class="px-md py-sm text-center text-xs text-on-surface-variant/50">{{ $t('ns.ingressDetail.noAnnotations') }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="animate-fade-in text-center py-xl">
    <span class="material-symbols-outlined text-2xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ $t('ns.ingressDetail.notFound') }}</h2>
    <button @click="router.push({ name: 'NsIngress', params: { namespace: route.params.namespace } })" class="mt-md px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg">{{ $t('ns.ingressDetail.backToList') }}</button>
  </div>

  <!-- Add Annotation Modal -->
  <Modal v-model="showAddAnnModal" :title="$t('ns.ingressDetail.addAnnotation')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.ingressDetail.annotationKey') }}</label>
        <AnnotationKeySelect v-model="newAnnKey" field-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.ingressDetail.value') }}</label>
        <textarea v-model="newAnnValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono h-20 resize-y focus:ring-2 focus:ring-primary" :placeholder="$t('ns.ingressDetail.valuePlaceholder')"></textarea>
      </div>
    </div>
    <template #actions>
      <button @click="showAddAnnModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="addAnnotation" :disabled="!newAnnKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('ns.ingressDetail.add') }}</button>
    </template>
  </Modal>

  <!-- Add Label Modal -->
  <Modal v-model="showAddLabelModal" :title="$t('ns.ingressDetail.addLabel')" width="max-w-md">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.ingressDetail.labelKey') }}</label>
        <input v-model="newLabelKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.ingressDetail.labelPlaceholder')" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.ingressDetail.value') }}</label>
        <input v-model="newLabelValue" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.ingressDetail.labelValuePlaceholder')" />
      </div>
    </div>
    <template #actions>
      <button @click="showAddLabelModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="addLabel" :disabled="!newLabelKey" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ $t('ns.ingressDetail.add') }}</button>
    </template>
  </Modal>

  <!-- Edit Rules Modal -->
  <Modal v-model="showRulesModal" :title="$t('ns.ingressDetail.editRulesTitle')" width="max-w-4xl">
    <p class="text-body-sm text-on-surface-variant mb-md">{{ $t('ns.ingressDetail.editRulesHint', { name: route.params.name }) }}<code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl patch ingress</code>）。</p>

    <!-- 校验错误汇总 -->
    <div v-if="errors.length" class="mb-md rounded-lg border border-error/40 bg-error-container/10 p-sm">
      <div class="flex items-center gap-xs text-error text-body-sm font-medium mb-xs"><span class="material-symbols-outlined text-base">error</span>{{ $t('ns.ingressDetail.errorsCount', { n: errors.length }) }}</div>
      <ul class="text-xs text-error/80 space-y-0.5 list-disc list-inside">
        <li v-for="(e, ei) in errors" :key="ei"><span class="font-mono">{{ e.loc }}</span>：{{ e.msg }}</li>
      </ul>
    </div>

    <!-- 默认后端（开关式卡片，默认收起）-->
    <div class="rounded-lg border border-outline-variant p-sm mb-md">
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="editModel.defaultBackend.enabled" type="checkbox" class="h-4 w-4 accent-primary" />
        <span class="text-body-sm font-medium">{{ $t('ns.ingressDetail.enableDefaultBackend') }} <code class="font-mono text-xs text-on-surface-variant">spec.defaultBackend</code></span>
      </label>
      <div v-if="editModel.defaultBackend.enabled" class="grid grid-cols-2 gap-sm mt-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service</label>
          <PortSelect v-model="editModel.defaultBackend.serviceName" :options="nsServiceNames" placeholder="my-svc" :empty-hint="$t('ns.ingressDetail.defaultBackendSvcHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Port</label>
          <PortSelect v-model="editModel.defaultBackend.servicePort" :options="portsFor(editModel.defaultBackend.serviceName)" placeholder="80" :empty-hint="$t('ns.ingressDetail.defaultBackendPortHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" />
        </div>
      </div>
    </div>

    <!-- host 分组卡片 -->
    <div class="flex flex-col gap-sm">
      <div v-for="(h, hi) in editModel.hosts" :key="hi" class="rounded-lg border border-outline-variant overflow-hidden">
        <div class="px-sm py-1.5 bg-surface-container-low flex items-center gap-xs">
          <span class="material-symbols-outlined text-primary text-base">language</span>
          <input v-model="h.host" class="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" :placeholder="$t('ns.ingressDetail.hostPlaceholder')" />
          <span class="text-[10px] text-on-surface-variant shrink-0">{{ $t('ns.ingressDetail.pathCount', { n: h.paths.length }) }}</span>
          <div class="flex items-center gap-0.5 shrink-0">
            <button @click="moveHost(hi, -1)" :disabled="hi === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="$t('ns.ingressDetail.moveUpHost')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
            <button @click="moveHost(hi, 1)" :disabled="hi === editModel.hosts.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="$t('ns.ingressDetail.moveDownHost')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
            <button @click="duplicateHost(hi)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="$t('ns.ingressDetail.dupHost')"><span class="material-symbols-outlined text-base">content_copy</span></button>
            <button @click="removeHost(hi)" class="p-0.5 text-on-surface-variant hover:text-error rounded" :title="$t('ns.ingressDetail.removeHost')"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </div>
        <div class="p-sm flex flex-col gap-xs">
          <div v-for="(p, i) in h.paths" :key="i" class="flex gap-xs items-center flex-wrap">
            <input v-model="p.path" :class="['w-28 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'path') ? 'border-error' : 'border-outline-variant']" placeholder="/" />
            <select v-model="p.pathType" class="bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm">
              <option v-for="t in pathTypeOptions" :key="t" :value="t">{{ t }}</option>
            </select>
            <PortSelect v-model="p.serviceName" :options="nsServiceNames" placeholder="my-svc" :empty-hint="$t('ns.ingressDetail.noService')" :input-class="['w-32 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'serviceName') ? 'border-error' : 'border-outline-variant'].join(' ')" />
            <PortSelect v-model="p.servicePort" :options="portsFor(p.serviceName)" placeholder="80" :empty-hint="$t('ns.ingressDetail.selectServiceForPort')" :input-class="['w-20 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'servicePort') ? 'border-error' : 'border-outline-variant'].join(' ')" />
            <div class="flex items-center gap-0.5 shrink-0">
              <button @click="movePath(hi, i, -1)" :disabled="i === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="$t('ns.ingressDetail.moveUpPath')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
              <button @click="movePath(hi, i, 1)" :disabled="i === h.paths.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="$t('ns.ingressDetail.moveDownPath')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
              <button @click="duplicatePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="$t('ns.ingressDetail.dupPath')"><span class="material-symbols-outlined text-base">content_copy</span></button>
              <button @click="removePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-error rounded" :title="$t('ns.ingressDetail.removePath')"><span class="material-symbols-outlined text-base">delete</span></button>
            </div>
          </div>
          <button @click="addPath(hi)" class="self-start flex items-center gap-xs px-sm py-xs text-body-sm text-primary hover:bg-primary-container/10 rounded">
            <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.ingressDetail.addPath') }}
          </button>
        </div>
      </div>
      <div v-if="!editModel.hosts.length" class="text-center text-on-surface-variant text-body-sm py-md">{{ $t('ns.ingressDetail.noHost') }}</div>
    </div>

    <div class="flex items-center gap-sm mt-md">
      <button @click="addHost" class="flex items-center gap-xs px-md py-xs border border-dashed border-outline-variant rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-low">
        <span class="material-symbols-outlined text-sm">add</span> {{ $t('ns.ingressDetail.addHost') }}
      </button>
      <button @click="showClearConfirm = true" :disabled="!editModel.hosts.length && !editModel.defaultBackend.enabled" class="ml-auto flex items-center gap-xs px-md py-xs text-body-sm text-error hover:bg-error-container/10 rounded-lg disabled:opacity-40">
        <span class="material-symbols-outlined text-sm">delete_sweep</span> {{ $t('ns.ingressDetail.clearAll') }}
      </button>
    </div>

    <template #actions>
      <button @click="showRulesModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="saveRules" :disabled="errors.length > 0" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">{{ $t('ns.ingressDetail.saveRules') }}</button>
    </template>
  </Modal>

  <!-- 清空全部确认 -->
  <Modal v-model="showClearConfirm" :title="$t('ns.ingressDetail.clearAllTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.ingressDetail.clearAllConfirm') }}</p>
    <template #actions>
      <button @click="showClearConfirm = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="clearAll" class="px-md py-sm bg-error text-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('ns.ingressDetail.clear') }}</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" :title="$t('ns.ingress.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ $t('ns.ingressDetail.deleteConfirm', { name: route.params.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ $t('ns.ingressDetail.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('common.delete') }}</button>
    </template>
  </Modal>

  <!-- IngressClass 编辑 -->
  <Modal v-model="showClassModal" :title="$t('ns.ingressDetail.editClassTitle')" width="max-w-md">
    <p class="text-body-sm text-on-surface-variant mb-sm">{{ $t('ns.ingressDetail.editClassHint') }}</p>
    <select v-model="editClassName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
      <option value="">{{ $t('ns.ingressDetail.defaultEmpty') }}</option>
      <option v-for="c in ingressClasses" :key="c.name" :value="c.name">{{ c.name }}{{ c.isDefault ? $t('ns.ingressDetail.defaultClass') : '' }}</option>
    </select>
    <template #actions>
      <button @click="showClassModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="saveClassName" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('ns.ingressDetail.saveLabel') }}</button>
    </template>
  </Modal>

  <!-- TLS 编辑 -->
  <Modal v-model="showTlsModal" :title="$t('ns.ingressDetail.editTlsTitle')" width="max-w-md">
    <label class="flex items-center gap-sm mb-md cursor-pointer">
      <input v-model="editTls" type="checkbox" class="h-4 w-4 accent-primary" />
      <span class="text-body-md text-on-surface">{{ $t('ns.ingressDetail.enableTlsSpec') }}</span>
    </label>
    <div v-if="editTls">
      <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('ns.ingressDetail.tlsSecretNameLabel') }}</label>
      <input v-model="editTlsSecret" list="ing-tls-secrets" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" :placeholder="$t('ns.ingressDetail.tlsSecretPlaceholder')" />
      <datalist id="ing-tls-secrets">
        <option v-for="s in allSecrets.filter(x => x.type === 'kubernetes.io/tls')" :key="s.name" :value="s.name" />
      </datalist>
      <p class="text-xs text-on-surface-variant mt-xs">{{ $t('ns.ingressDetail.tlsHint') }}</p>
    </div>
    <template #actions>
      <button @click="showTlsModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('ns.ingressDetail.cancel') }}</button>
      <button @click="saveTls" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('ns.ingressDetail.saveLabel') }}</button>
    </template>
  </Modal>
</template>
