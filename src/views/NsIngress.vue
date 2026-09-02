<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useQueryClient } from '@tanstack/vue-query'
import { useI18n } from 'vue-i18n'
import { useTableColumns } from '@/composables/useTableColumns'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import AnnotationKeySelect from '@/components/common/AnnotationKeySelect.vue'
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import { usePagination } from '@/composables/usePagination'
import { dialectGroups, dialectHint, detectDialect, buildIngressAnnotations, validateIngressAdv, validateCustomAnnotations, hintKeyOfKey, placeholderOfKey } from '@/composables/useIngressPerf'
import IngressPerfField from '@/components/common/IngressPerfField.vue'
import { hostsToK8sSpec, ingressHostsErrors } from '@/composables/useIngressRules'
import { pickIngressClassName } from '@/logic/ingressClass'
import { notify } from '@/composables/useToast'
import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { t } = useI18n()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('nsIngress'))
store.setNamespace(route.params.namespace)
const queryClient = useQueryClient()

// Ingress 走 Vue Query（cluster-wide + 按 ns 过滤）：远端 30s 轮询 + 聚焦重拉 + 新鲜度。
const cid = computed(() => (store.currentCluster || 'cluster'))
// watch live 零轮询 / 降级 60s 兜底；refetchInterval 直传 ref
const ingState = computed(() => store.watchStateOf('ingresses'))
const ingInterval = computed(() => (ingState.value === 'live' || ingState.value === 'reconnecting') ? false : 60000)
const svcState = computed(() => store.watchStateOf('services'))
const svcInterval = computed(() => (svcState.value === 'live' || svcState.value === 'reconnecting') ? false : 60000)
const ingressesKey = ['cluster', cid, 'ingresses']
const ingressesQuery = useResourceList({
  key: ingressesKey,
  fetcher: () => store.fetchIngresses(),
  options: { refetchInterval: ingInterval, refetchOnWindowFocus: false },
})
const nsIngress = computed(() => (ingressesQuery.data.value || []).filter(i => i.namespace === route.params.namespace))
// Service 下拉源走 Vue Query（nsServices.value 在 remote 下孤立）
const svcQ = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), options: { refetchInterval: svcInterval, refetchOnWindowFocus: false } })
const nsServices = computed(() => (svcQ.data.value || []).filter(s => s.namespace === route.params.namespace))
const secQ = useResourceList({ key: ['cluster', cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })
// TLS Secret 候选:当前 ns + kubernetes.io/tls 类型(fetchSecrets 拉的是全 ns 列表,须过滤)
const tlsSecretNames = computed(() => (secQ.data.value || []).filter(s => s.namespace === route.params.namespace && s.type === 'kubernetes.io/tls').map(s => s.name))
// IngressClass 下拉源走 Vue Query（集群级，真实网关类；不再用硬编码列表，避免指向集群里不存在的类）
const icQ = useResourceList({ key: ['cluster', cid, 'ingressclasses'], fetcher: () => store.fetchIngressClasses(), options: { staleTime: 60_000 } })
const allIngressClasses = computed(() => icQ.data.value || [])

// 把 Ingress 的 rules 展平为路由条目（host → path → backend），便于列表紧凑展示与搜索
function flattenRules(row) {
  const out = []
  for (const r of (row.rules || [])) {
    const host = r.host || '*'
    const paths = r.http?.paths || []
    if (!paths.length) { out.push({ host, path: '*', backend: '' }); continue }
    for (const p of paths) {
      const svc = p.backend?.service
      const port = svc?.port?.number ?? svc?.port?.name ?? ''
      out.push({ host, path: p.path || '/', backend: svc ? `${svc.name}${port !== '' ? ':' + port : ''}` : '' })
    }
  }
  if (!out.length) out.push({ host: row.hosts || '*', path: '/', backend: '' })
  return out
}

// 搜索过滤（名称 / 域名 / 后端服务）
const searchQuery = ref('')
const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return nsIngress.value
  return nsIngress.value.filter(i => {
    if (i.name.toLowerCase().includes(q) || (i.hosts || '').toLowerCase().includes(q)) return true
    return flattenRules(i).some(r => (r.host + ' ' + r.backend).toLowerCase().includes(q))
  })
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery] })

// Create Ingress Dialog
const showCreateModal = ref(false)
const createTab = ref('basic')   // basic | perf | extra
const createForm = ref({ name: '', className: '' })
// 多 host 多 path 规则（共享 IngressRulesEditor；与 ④ Edit Rules 同一模型）
const hosts = ref([{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }] }])
const rulesErrors = ref([])
// Service 下拉源（编辑器双下拉：name + 该 Service 暴露的端口）
const svcOptions = computed(() => nsServices.value.map(s => ({ name: s.name, ports: (s.portList || []).map(p => p.port) })))
const hasValidRule = computed(() => hosts.value.some(h => h.host && h.paths.some(p => p.path)))
// 性能调优参数（→ <方言前缀>/<key> 注解，空值不写入;方言随 className 自动切换）
const adv = ref({})
// 自定义 annotations（键值对，兼容任意控制器）
const customAnnotations = ref([])

// Ingress 方言:按 className 自动探测;切换方言清空旧 adv 值(键对新方言无意义)
const createDialect = computed(() => detectDialect(createForm.value.className))
watch(createDialect, (d) => {
  adv.value = {}
  // 停在已消失的 extra 标签时跳回 perf(traefik/kong/generic 无 extra 组;自定义注解在其 perf 标签兜底显示)
  if (createTab.value === 'extra' && !dialectGroups(d).some(g => g.tab === 'extra')) createTab.value = 'perf'
})

// 「集群默认」退役(2026-09-01):曾默认 className='' 指望集群默认类兜底,但集群经常没有任何
// is-default-class 标记(平台自带控制器清单全不标)→ Ingress 落地无类,控制器不接。
// 现在:仅当未选时补选一个确定的类(isDefault 优先,否则字母序第一);用户已手选不覆盖。
watch(allIngressClasses, () => {
  if (createForm.value.className) return
  const picked = pickIngressClassName(allIngressClasses.value)
  if (picked) createForm.value.className = picked
}, { immediate: true })


function resetCreate() {
  createForm.value = { name: '', className: pickIngressClassName(allIngressClasses.value) }
  hosts.value = [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }] }]
  rulesErrors.value = []
  adv.value = {}
  customAnnotations.value = []
  createTab.value = 'basic'
}
function addCustomAnnotation() { customAnnotations.value.push({ key: '', value: '' }) }
function removeCustomAnnotation(i) { customAnnotations.value.splice(i, 1) }


async function handleCreate() {
  const f = createForm.value
  // 客户端格式门:性能字段 + 自定义注解非法值(数字框拦不住脚本注入,走校验器兜底)拦截提交
  const errs = [...validateIngressAdv(createDialect.value, adv.value), ...validateCustomAnnotations(customAnnotations.value)]
  if (errs.length) {
    notify('error', t('ingressPerf.invalidField', { field: t(errs[0].labelKey), msg: t(errs[0].msgKey) }))
    return
  }
  // backend 门禁(生成层不兜底,spec §3.3):空 Service/非数字端口若放行,
  // 会经 Number()→NaN/0 再被 generateYAML `|| 80` 静默改写 80 端口——必须在入口拦下。
  const ruleErr = ingressHostsErrors(hosts.value)[0]
  if (ruleErr) {
    notify('error', t(ruleErr.reason === 'badPort' ? 'ns.ingress.rulesPortNumeric' : 'ns.ingress.rulesBackendInvalid', { host: ruleErr.host }))
    return
  }
  const spec = hostsToK8sSpec(hosts.value, { defaultTlsSecret: `${f.name}-tls` })
  const r = await store.addIngress({
    name: f.name,
    namespace: route.params.namespace,
    hosts: spec.rules.map(rr => rr.host).filter(Boolean).join(','),
    tls: !!spec.tls.length,
    tlsSecret: spec.tls[0]?.secretName || '',
    tlsList: spec.tls,
    className: f.className,
    annotations: buildIngressAnnotations(createDialect.value, adv.value, customAnnotations.value),
    rules: spec.rules,
  })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  queryClient.invalidateQueries({ queryKey: ingressesKey })
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function goDetail(row) {
  router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: row.name } })
}
function confirmDelete(ing) {
  deleteTarget.value = ing
  showDeleteModal.value = true
}
async function handleDelete() {
  if (deleteTarget.value) {
    await store.deleteIngress(deleteTarget.value.name, route.params.namespace)
    queryClient.invalidateQueries({ queryKey: ingressesKey })
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: t('ns.ingress.title') }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md font-bold text-on-surface">{{ t('ns.ingress.title') }}</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ t('ns.ingress.subtitle', { count: nsIngress.length, ns: route.params.namespace }) }}</p>
      </div>
      <CreateWithYamlButton :label="t('ns.ingress.new')" :main-action="() => { showCreateModal = true }" yaml-template="Ingress" :namespace="route.params.namespace" />
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" :placeholder="t('ns.ingress.searchPlaceholder')" />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"><span class="material-symbols-outlined text-lg">close</span></button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ nsIngress.length }}</span>
    </div>

    <DataTable :headers="headers" :rows="paginated" column-key="nsIngress" @row-click="goDetail">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-lg">language</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #className="{ row }">
        <span v-if="row.className" class="font-mono text-xs px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">{{ row.className }}</span>
        <span v-else class="text-xs text-on-surface-variant/40">—</span>
      </template>
      <template #rules="{ row }">
        <div class="flex flex-col gap-0.5">
          <div v-for="(r, i) in flattenRules(row)" :key="i" class="flex items-center gap-xs text-code-sm font-mono">
            <span class="text-primary font-semibold max-w-[220px] truncate" :title="r.host">{{ r.host }}</span>
            <span class="text-on-surface-variant">{{ r.path }}</span>
            <span class="text-on-surface-variant/40">→</span>
            <span v-if="r.backend" class="text-on-surface max-w-[200px] truncate" :title="r.backend">{{ r.backend }}</span>
            <span v-else class="text-on-surface-variant/40 italic">{{ t('ns.ingress.noBackend') }}</span>
          </div>
        </div>
      </template>
      <template #tls="{ row }">
        <div v-if="row.tls" class="flex items-center gap-xs">
          <span class="material-symbols-outlined text-base text-primary">lock</span>
          <span class="font-mono text-xs text-primary max-w-[140px] truncate" :title="row.tlsSecret">{{ row.tlsSecret || 'TLS' }}</span>
        </div>
        <span v-else class="text-xs text-on-surface-variant/50">{{ t('common.none') }}</span>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant whitespace-nowrap">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <div class="flex gap-1 justify-end">
          <button @click.stop="goDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="t('ns.ingress.viewDetail')">
            <span class="material-symbols-outlined text-lg">open_in_new</span>
          </button>
          <button @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="t('common.delete')">
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
      <template v-if="filtered.length" #pagination>
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>
  </section>

  <!-- Create Ingress Modal(@cancel:X/ESC/背景关闭同样重置表单,与取消按钮一致,防旧值泄漏) -->
  <Modal v-model="showCreateModal" :title="t('ns.ingress.createTitle')" width="max-w-3xl" @cancel="resetCreate">
    <!-- 标签栏 -->
    <div class="flex gap-xs border-b border-outline-variant mb-md">
      <button data-testid="tab-basic" @click="createTab = 'basic'"
        class="px-md py-sm text-body-sm font-medium border-b-2 -mb-px transition-colors"
        :class="createTab === 'basic' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        {{ t('ns.ingress.tabBasic') }}
      </button>
      <!-- perf 标签恒显:generic 方言下调优组为空,但承载 hint + 自定义注解兜底(spec: generic 保留自定义注解) -->
      <button data-testid="tab-perf" @click="createTab = 'perf'"
        class="px-md py-sm text-body-sm font-medium border-b-2 -mb-px transition-colors"
        :class="createTab === 'perf' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        {{ t('ns.ingress.tabPerf') }}
      </button>
      <button v-if="dialectGroups(createDialect).some(g => g.tab === 'extra')" data-testid="tab-extra" @click="createTab = 'extra'"
        class="px-md py-sm text-body-sm font-medium border-b-2 -mb-px transition-colors"
        :class="createTab === 'extra' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        {{ t('ns.ingress.tabExtra') }}
      </button>
    </div>

    <!-- 基础 -->
    <div v-if="createTab === 'basic'" class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.ingress.nameLabel') }}</label>
          <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-ingress" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">{{ t('ns.ingress.classLabel') }}</label>
          <select v-model="createForm.className" data-testid="ingress-class-select" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option v-if="!allIngressClasses.length" value="">{{ t('ns.ingress.classNoneAvailable') }}</option>
            <option v-for="c in allIngressClasses" :key="c.name" :value="c.name">{{ c.name }}{{ c.isDefault ? t('ns.ingress.defaultClass') : '' }}</option>
          </select>
        </div>
      </div>
      <!-- 多 host 多 path 规则（共享编辑器:per-host TLS + 行级校验内置;validation 供创建按钮禁用） -->
      <IngressRulesEditor v-model="hosts" :services="svcOptions" :secrets="tlsSecretNames" :with-tls="true" @validation="v => rulesErrors = v" />
    </div>

    <!-- 性能调优 / 安全与其它：参数分组 -->
    <div v-else data-testid="perf-panel" class="flex flex-col gap-md max-h-[60vh] overflow-y-auto pr-sm">
      <p class="text-xs text-on-surface-variant">{{ t('ns.ingress.perfHint') }}</p>
      <p v-if="dialectHint(createDialect)" class="text-xs text-on-surface-variant">{{ t(dialectHint(createDialect)) }}</p>
      <div v-for="g in dialectGroups(createDialect).filter(x => x.tab === createTab)" :key="g.titleKey" class="border border-outline-variant rounded-lg p-md">
        <div class="flex items-center gap-sm mb-sm">
          <span class="material-symbols-outlined text-primary text-lg">{{ g.icon }}</span>
          <h4 class="text-body-sm font-semibold text-on-surface">{{ t(g.titleKey) }}</h4>
        </div>
        <div class="grid grid-cols-2 gap-sm">
          <div v-for="fld in g.fields" :key="fld.key">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ t(fld.labelKey) }}</label>
            <IngressPerfField v-model="adv[fld.key]" :fld="fld" />
          </div>
        </div>
      </div>

      <!-- 自定义注解:extra 标签显示;无 extra 组的方言(traefik/kong/generic)在 perf 标签兜底显示,保证任何方言可达 -->
      <div v-if="createTab === 'extra' || (createTab === 'perf' && !dialectGroups(createDialect).some(g => g.tab === 'extra'))" data-testid="custom-annotations" class="border border-outline-variant rounded-lg p-md">
        <div class="flex items-center justify-between mb-sm">
          <h4 class="text-body-sm font-semibold text-on-surface">{{ t('ns.ingress.customAnnoTitle') }}</h4>
          <button @click="addCustomAnnotation" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded-lg text-xs hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span>{{ t('ns.ingress.addAnno') }}</button>
        </div>
        <div v-for="(a, i) in customAnnotations" :key="i" class="flex items-center gap-sm mb-xs">
          <AnnotationKeySelect v-model="a.key" class="flex-1" field-class="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
          <div class="flex-1 flex flex-col gap-xs">
            <input v-model="a.value" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="placeholderOfKey(a.key) || t('ns.ingress.valuePlaceholder')" />
            <p v-if="hintKeyOfKey(a.key)" class="text-xs text-on-surface-variant">{{ t(hintKeyOfKey(a.key)) }}</p>
          </div>
          <button @click="removeCustomAnnotation(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
        <p v-if="!customAnnotations.length" class="text-xs text-on-surface-variant">{{ t('ns.ingress.noCustomAnno') }}</p>
      </div>
    </div>

    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleCreate" data-testid="create-ingress-btn" :disabled="!createForm.name || !hasValidRule || rulesErrors.length > 0" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">{{ t('common.create') }}</button>
    </template>
  </Modal>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" :title="t('ns.ingress.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">{{ t('ns.ingress.deleteConfirm', { name: deleteTarget?.name }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.ingress.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
</template>
