import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { load as yamlLoad, loadAll as yamlLoadAll } from 'js-yaml'
import { api, k8sStream, portForwardApi, getSavedClusters, addSavedCluster, removeSavedCluster, setActiveToken, activeApiServer, getSessionToken } from '@/api/client'
import { notify } from '@/composables/useToast'
import { yamlScalar, ensureServicePortNames } from '@/composables/useYaml'
import { classifyResource } from '@/composables/useLayering'
import { computeClusterHealth } from '@/composables/useClusterHealth'
import { buildIngressRulesPatch } from '@/composables/useIngressRules'
import { buildPVPatch, buildStorageClassPatch } from '@/composables/useStoragePatch'
import { buildStorageClassYaml } from '@/data/storageClassYaml'
import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'
import { queryClient } from '@/queryClient'
import { mapNode, mapPod, mapWorkload, mapEvent, mapConfigMap, mapSecret, mapPVC, mapPV, mapStorageClass, mapEndpoints, mapIngressClass, mapRuntimeClass, mapPriorityClass, mapService, mapIngress, mapNetworkPolicy, mapHPA, mapResourceQuota, mapLimitRange, mapRole, mapServiceAccount, mapRoleBinding, mapPDB, mapCRD, mapCRInstance, ageOf, eventIconColor, encodeSecretData, encodeBase64, decodeBase64 } from '@/composables/useResourceMappers'
import { fetchNodes, fetchNode, fetchServices, fetchService, fetchConfigMaps, fetchConfigMap, fetchSecrets, fetchSecret, fetchIngresses, fetchIngress, fetchNetworkPolicies, fetchNetworkPolicy, fetchPDBs, fetchPDB, fetchLimitRanges, fetchLimitRange, fetchResourceQuotas, fetchResourceQuota, fetchHPAs, fetchHPA, fetchEndpoints, fetchWorkloads, fetchPVCs, fetchPVs, fetchPV, fetchStorageClasses, fetchStorageClass, fetchPVC, fetchRoles, fetchRoleBindings, fetchClusterRoleBindings, fetchServiceAccounts, fetchRole, fetchRoleBinding, fetchServiceAccount, fetchClusterRole, fetchClusterRoleBinding, fetchRuntimeClasses, fetchRuntimeClass, fetchIngressClasses, fetchIngressClass, fetchPriorityClasses, fetchPriorityClass, fetchNamespaces, fetchNamespace } from '@/composables/useFetchers'
import { applyWatchEvent } from '@/composables/useK8sQuery'
import { deriveClusterCounts } from '@/logic/clusterCounts'
import { pushSample, restoreSamples, persistPayload } from '@/logic/metricsWindow'

// YAML 强制双引号序列化：metadata.name/namespace/标签值/容器名等必须是字符串,
// 裸 ${name} 在 name 形如数字(如 123)时会被 YAML 解析成 int → K8s "expected string"。
// generateYAML/generateExtraYAML 的 name/namespace 插值统一用它包一层。
const yamlQ = v => JSON.stringify(String(v ?? ''))
import { i18n } from '@/i18n'

export { formatCpu, formatMem } from '@/composables/useResourceFormat'

// 失效某资源的所有 cluster query（跨 cid，匹配 key[2]），让读 query 的列表/详情页在 CRUD 后自动刷新。
// key[2] = 资源名（如 'configmaps'）；详情页 key ['cluster',cid,'configmaps',name] 也被匹配。
function invalidateResource(resource) {
  queryClient.invalidateQueries({
    predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === resource,
  })
}

// 失效所有 cluster query（跨 cid、跨资源）。供 Namespaces/NamespaceDetail 的「Sync」按钮调用，
// 取代旧的 hydrateCoreResources 手动全量同步——让 Vue Query 按需重拉（stale 的才会刷新）。
function invalidateAllClusterQueries() {
  queryClient.invalidateQueries({
    predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster',
  })
}

// HPA 定点 patch(strategic-merge):仅更新可编辑字段(minReplicas/maxReplicas/metrics),
// 保留 spec.behavior / scaleTargetRef 等其余字段 —— 避免全量 SSA prune。
// 提到模块级以便单测直接导入(纯函数)。
export const hpaPatchFn = (name, ns, updates, before) => ({ spec: {
  minReplicas: updates.minReplicas ?? before.minReplicas,
  maxReplicas: updates.maxReplicas ?? before.maxReplicas,
  metrics: [
    { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: updates.cpuTarget ?? before.cpuTarget } } },
    { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: updates.memoryTarget ?? before.memoryTarget } } },
  ],
} })

export const useClusterStore = defineStore('cluster', () => {
  // === Base64（Secret data 编解码，UTF-8 安全）===
  // K8s 的 Secret.data 一律 base64 编码；mock 里以明文（stringData）书写，
  // 这里在存储层统一编码、展示层（详情页 reveal / 编辑）再解码，
  // 保持与真实 K8s 语义一致。

  // === 基础数据 ===
  const cluster = ref({
    name: '',
    version: 'k8s v1.28.2',
    apiServer: 'https://api.prod-cluster.kubezen.io:6443',
    status: 'Healthy',
    nodeCount: 0,
    podCount: 0,
    activeEvents: 0,
    cpuUsage: null,
    cpuTrend: '—',
    cpuTrendUp: null,
    memoryUsage: null,
    memoryTrend: '—',
    memoryTrendUp: null,
    metricsAvailable: false,
  })
  const nodeList = ref([])
  const namespaceList = ref([])
  // P2-B：podList/workloadList/eventList/serviceList/ingressList 孤儿 ref 已删——
  // 服务端状态全归 Vue Query（列表 useResourceList / 变更 invalidateResource / watch setQueryData 桥）。
  // 多集群：已保存集群来自 localStorage；clusterList 为其映射
  const savedClusters = ref(getSavedClusters())
  const activeApiServerRef = ref(activeApiServer())
  const clusterList = computed(() => savedClusters.value.map(c => ({ name: c.name, apiServer: c.apiServer, version: c.version, status: c.status || 'Healthy', distribution: c.distribution || 'Kubernetes', context: c.name, current: c.apiServer === activeApiServerRef.value })))
  const currentCluster = ref('')
  const connectionState = ref('')
  // 上一次水合的集群级 CPU/内存百分比，用于计算趋势（首次为 null → 趋势显示「—」）
  let prevClusterMetrics = { cpu: null, mem: null }
  // Pod Watch（实时监听）的资源版本续接点 + 句柄；断开/出错即停，避免重连风暴
  let podWatchRv = null
  let podWatchHandle = null
  const podWatchLive = ref(false)
  // Event Watch 同款状态
  let eventWatchRv = ''
  let eventWatchHandle = null
  const eventWatchLive = ref(false)

  // === 当前选中的 Namespace（持久化：刷新不丢，与集群选择同模式）===
  const currentNamespace = ref(localStorage.getItem('aliangboard.namespace') || '')

  const healthyNodes = computed(() => nodeList.value.filter(n => n.status === 'Ready').length)
  const totalNodes = computed(() => nodeList.value.length)
  const apiReachable = ref(true)
  const clusterHealth = computed(() => computeClusterHealth({
    nodeList: nodeList.value, apiReachable: apiReachable.value,
  }))

  // === Namespace 作用域的计算属性 ===

  // === Actions ===
  // 平台编辑/回滚/创建后自动写入的 tag：标识「由 AliangBoard 管理」+ 最后编辑时间
  function aliangTag(extra) {
    const tag = {
      labels: { 'aliangboard.io/managed-by': 'aliangboard' },
      annotations: { 'aliangboard.io/last-edited': new Date().toISOString() },
    }
    if (extra) { tag.labels = { ...tag.labels, ...extra.labels }; tag.annotations = { ...tag.annotations, ...extra.annotations } }
    return tag
  }

  function setNamespace(ns) {
    currentNamespace.value = ns
    // 持久化选中 namespace；清空时移除键
    if (ns) localStorage.setItem('aliangboard.namespace', ns)
    else localStorage.removeItem('aliangboard.namespace')
  }

  // 按需拉取单个工作负载并 upsert 进 workloads Query 缓存。
  // Job/CronJob 不在 fetchWorkloads 批量列表里（deployments/sts/ds）；从 Pod 详情跳转或直接链接进入
  // NsWorkloadDetail 时由 ensureWorkload 调此补齐——P2-B 前写孤儿 workloadList（无读者）→ 详情恒空白。
  // 缓存里已有同名条目时跳过：批量列表带 attachRolloutHistory 的 revisions，单体 upsert 会覆盖丢失。
  async function fetchWorkload(type, name, ns) {
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs' }[type]
    if (!plural) throw new Error(i18n.global.t('store.unsupportedWorkloadType', { type }))
    const gv = type === 'Job' || type === 'CronJob' ? '/apis/batch/v1' : '/apis/apps/v1'
    const data = await api.k8s(`${gv}/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`)
    const wl = mapWorkload(data, type)
    const _cid = currentCluster.value || 'cluster'
    queryClient.setQueryData(['cluster', _cid, 'workloads'], old => {
      const list = old || []
      const exists = list.some(w => w.name === name && w.namespace === ns && w.type === type)
      return exists ? list : [...list, wl]
    })
    return wl
  }


  // 从 workload 原始 K8s 对象提取 ConfigMap / Secret 引用（volumes + envFrom + env valueFrom）。
  // 支持 Deployment/StatefulSet/DaemonSet/Job（spec.template.spec）+ CronJob（spec.jobTemplate.spec.template.spec）。
  function extractWorkloadReferences(raw, type) {
    if (!raw?.spec) return []
    const podSpec = type === 'CronJob'
      ? raw.spec?.jobTemplate?.spec?.template?.spec
      : raw.spec?.template?.spec
    if (!podSpec) return []
    const refs = []
    const seen = new Set()
    const add = (kind, name) => {
      if (!name) return
      const key = `${kind}/${name}`
      if (!seen.has(key)) { seen.add(key); refs.push({ kind, name }) }
    }
    // volumes: configMap / secret / projected
    for (const vol of (podSpec.volumes || [])) {
      if (vol.configMap?.name) add('ConfigMap', vol.configMap.name)
      if (vol.secret?.secretName) add('Secret', vol.secret.secretName)
      for (const src of (vol.projected?.sources || [])) {
        if (src.configMap?.name) add('ConfigMap', src.configMap.name)
        if (src.secret?.name) add('Secret', src.secret.name)
      }
    }
    // containers + initContainers: envFrom + env.valueFrom
    const allContainers = [...(podSpec.containers || []), ...(podSpec.initContainers || [])]
    for (const c of allContainers) {
      for (const ef of (c.envFrom || [])) {
        if (ef.configMapRef?.name) add('ConfigMap', ef.configMapRef.name)
        if (ef.secretRef?.name) add('Secret', ef.secretRef.name)
      }
      for (const env of (c.env || [])) {
        if (env.valueFrom?.configMapKeyRef?.name) add('ConfigMap', env.valueFrom.configMapKeyRef.name)
        if (env.valueFrom?.secretKeyRef?.name) add('Secret', env.valueFrom.secretKeyRef.name)
      }
    }
    return refs
  }

  // 反查：哪些 workload 引用了指定的 ConfigMap / Secret。纯函数——workloads 由调用方的
  // useResourceList(workloads) 查询供（响应式 + 同 key 去重）。P2-B 前读孤儿 workloadList 恒空。
  // 返回 [{ workload, reference }]，按引用方式分组
  function findResourceReferences(workloads, kind, name, ns) {
    const namespace = ns || currentNamespace.value
    const results = []
    for (const w of (workloads || [])) {
      if (w.namespace !== namespace) continue
      const refs = extractWorkloadReferences(w.raw, w.type)
      for (const r of refs) if (r.kind === kind && r.name === name) results.push({ workload: w, reference: r })
    }
    return results
  }

  // 正查：某个 workload 引用了哪些 ConfigMap / Secret

  // 远端删除 + 本地列表同步：乐观先移除，API 失败则回滚并全局提示，保证 UI 与集群一致
  async function remoteDelete(path, list, matchFn, label) {
    const idx = list.value.findIndex(matchFn)
    const backup = idx !== -1 ? list.value[idx] : null
    if (idx !== -1) list.value.splice(idx, 1)
    try {
      await api.k8s(path, { method: 'DELETE' })
    } catch (e) {
      if (backup) list.value.splice(idx, 0, backup)
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: label || i18n.global.t('store.resource'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // 远端创建：用 generateYAML 生成清单 → server-side apply → 刷新对应列表
  async function remoteCreate(yamlStr, label, refreshFn) {
    try {
      await api.applyYaml(yamlStr)
      if (refreshFn) await refreshFn()
      notify('success', i18n.global.t('store.created', { label }))
      return { ok: true }
    } catch (e) {
      notify('error', i18n.global.t('store.createFailed', { label, msg: e.message || i18n.global.t('store.checkYamlPerm') }))
      return { ok: false }
    }
  }

  // 重新拉取某类资源列表（集群范围），创建后用于回填真实状态
  async function refetch(path, list, mapper) {
    try {
      const data = await api.k8s(`${path}?limit=500`)
      list.value = (data.items || []).map(mapper)
    } catch (e) { console.warn('[refetch] 刷新失败:', path, e?.message || e) }
  }

  // 远端结构化更新：用更新后的对象重新生成清单并 server-side apply（与 YAML 编辑器同链路）。
  // 适用于 generateYAML 无损的资源；失败回滚本地并提示。Workload 浅编辑等用 remotePatch 定点 PATCH。
  // {ok} 契约（与 remoteCreate/remoteDeletePath 对齐）：失败吞异常（内部已 toast）但必须返回 {ok:false}，
  // 调用方（如 NsServiceDetail.saveAddPort）据此决定关弹窗/报成功，不再无条件成功。
  async function remoteUpdate(yamlStr, label, rollbackFn) {
    try {
      await api.applyYaml(yamlStr)
      notify('success', `${label}${i18n.global.t('common.save')}`)
      return { ok: true }
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrConflict')}`)
      if (rollbackFn) rollbackFn()
      return { ok: false }
    }
  }
  // 远端定点 PATCH（application/merge-patch+json），失败回滚本地并提示;{ok} 契约同 remoteUpdate
  async function remotePatch(path, patch, label, rollbackFn) {
    try {
      await api.k8s(path, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch) })
      notify('success', `${label}${i18n.global.t('common.save')}`)
      return { ok: true }
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrNotExist')}`)
      if (rollbackFn) rollbackFn()
      return { ok: false }
    }
  }

  // === CRUD 工厂（全真实数据模型：纯远端 + Vue Query 缓存）===
  // makeCrud 为每类规整资源生成 add/update/delete 三函数：
  // - add: generateYAML → server-side apply → invalidateResource(刷 Vue Query)
  // - update: 从 Vue Query 缓存取当前对象（fromCache）→ merge → remoteUpdate/remotePatch
  //   · patchFn 资源(HPA)：定向 patch body，不 regenerate 全量 YAML
  //   · 缓存未命中：仅 invalidate（下次有缓存再编辑），不抛
  // - delete: api.k8s DELETE → invalidateResource
  // 集中 await + invalidateResource，结构性消灭 await-race。
  function makeCrud(plural, spec) {
    const { kind, group, resource, namespaced, genType = resource, genExtra = false,
            beforeSave, customYaml, patchFn, sideEffects, skipRemoteUpdate, fetch } = spec
    const genFn = genExtra ? generateExtraYAML : generateYAML
    const itemApi = (name, ns) => namespaced
      ? `${group}/namespaces/${encodeURIComponent(ns)}/${resource}/${encodeURIComponent(name)}`
      : `${group}/${resource}/${encodeURIComponent(name)}`
    const yamlOf = item => customYaml ? customYaml(item) : genFn(genType, beforeSave ? beforeSave(item) : item)

    // 从 Vue Query 缓存取当前对象（all-real-data 的唯一真相源；替代旧 store-ref idxOf）
    const fromCache = (name, ns) => {
      const cid = currentCluster.value || 'cluster'
      const list = queryClient.getQueryData(['cluster', cid, plural]) || []
      return list.find(x => x.name === name && (!namespaced || x.namespace === ns))
    }

    async function add(item) {
      const r = await remoteCreate(yamlOf(item), `${kind}/${item.name}`)
      if (r.ok && sideEffects?.onAdd) sideEffects.onAdd(item) // 失败不触发 sideEffects(修 services 计数漂移)
      invalidateResource(plural)
      return r // { ok } from remoteCreate;失败时已 toast,调用方可据 r.ok 决定后续(见 CreatePvcDialog)
    }
    // {ok} 契约（对齐 add/remove）：调用方必须据 r.ok 决定关弹窗/报成功
    async function update(name, ns, updates) {
      if (skipRemoteUpdate) return { ok: true }
      let cur = fromCache(name, ns)
      if (!cur && fetch) cur = await fetch(name, ns).catch(() => null)
      let r
      if (patchFn) {
        r = await remotePatch(itemApi(name, ns), patchFn(name, ns, updates, cur || {}), kind)
      } else {
        if (!cur) { invalidateResource(plural); return { ok: false, skipped: true } }
        const merged = { ...cur, ...(beforeSave ? beforeSave(updates) : updates) }
        r = await remoteUpdate(yamlOf(merged), kind)
      }
      if (r.ok && sideEffects?.onUpdate) sideEffects.onUpdate(name, ns)
      invalidateResource(plural)
      return r
    }
    async function remove(name, ns) {
      const r = await remoteDeletePath(itemApi(name, ns), `${kind}/${name}`)
      if (r.ok && sideEffects?.onDelete) sideEffects.onDelete(name, ns)
      invalidateResource(plural)
      return r
    }
    return { add, update, delete: remove }
  }

  // 远端删除（工厂专用）：纯 DELETE，无 store ref / 无乐观回滚——Vue Query invalidate 重拉即同步。
  async function remoteDeletePath(path, label) {
    try {
      await api.k8s(path, { method: 'DELETE' })
      return { ok: true }
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: label || i18n.global.t('store.resource'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
      return { ok: false }
    }
  }

  const RESOURCE_SPECS = {
    configmaps: { kind: 'ConfigMap', group: '/api/v1', resource: 'configmaps', namespaced: true, genType: 'configmap', fetch: fetchConfigMap },
    secrets: { kind: 'Secret', group: '/api/v1', resource: 'secrets', namespaced: true, genType: 'secret', beforeSave: s => (s.data ? { ...s, data: encodeSecretData(s.data) } : s), fetch: fetchSecret },
    pvcs: { kind: 'PVC', group: '/api/v1', resource: 'persistentvolumeclaims', namespaced: true, genType: 'pvc', fetch: fetchPVC },
    services: { kind: 'Service', group: '/api/v1', resource: 'services', namespaced: true, genType: 'service', fetch: fetchService, sideEffects: {
      onAdd: svc => { const ns = namespaceList.value.find(n => n.name === svc.namespace); if (ns) ns.services = (ns.services || 0) + 1 },
      onDelete: (_n, ns) => { const nsObj = namespaceList.value.find(n => n.name === ns); if (nsObj) nsObj.services = Math.max(0, (nsObj.services || 0) - 1) },
    } },
    networkpolicies: { kind: 'NetworkPolicy', group: '/apis/networking.k8s.io/v1', resource: 'networkpolicies', namespaced: true, genType: 'networkpolicy', fetch: fetchNetworkPolicy },
    hpas: { kind: 'HPA', group: '/apis/autoscaling/v2', resource: 'horizontalpodautoscalers', namespaced: true, genType: 'hpa', patchFn: hpaPatchFn, fetch: fetchHPA },
    resourcequotas: { kind: 'ResourceQuota', group: '/api/v1', resource: 'resourcequotas', namespaced: true, genType: 'resourcequota', fetch: fetchResourceQuota },
    limitranges: { kind: 'LimitRange', group: '/api/v1', resource: 'limitranges', namespaced: true, genType: 'limitrange', fetch: fetchLimitRange },
    serviceaccounts: { kind: 'ServiceAccount', group: '/api/v1', resource: 'serviceaccounts', namespaced: true, genType: 'serviceaccount', fetch: fetchServiceAccount },
    rolebindings: { kind: 'RoleBinding', group: '/apis/rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespaced: true, genType: 'rolebinding', fetch: fetchRoleBinding },
    poddisruptionbudgets: { kind: 'PDB', group: '/apis/policy/v1', resource: 'poddisruptionbudgets', namespaced: true, genType: 'pdb', genExtra: true, fetch: fetchPDB },
    ingresses: { kind: 'Ingress', group: '/apis/networking.k8s.io/v1', resource: 'ingresses', namespaced: true, genType: 'ingress', fetch: fetchIngress },
    // 集群级规整资源 (namespaced:false)：单一 API 端点 + 标准 remoteXxx
    ingressclasses: { kind: 'IngressClass', group: '/apis/networking.k8s.io/v1', resource: 'ingressclasses', namespaced: false, genType: 'ingressclass', fetch: fetchIngressClass },
    runtimeclasses: { kind: 'RuntimeClass', group: '/apis/node.k8s.io/v1', resource: 'runtimeclasses', namespaced: false, genType: 'runtimeclass', fetch: fetchRuntimeClass },
    priorityclasses: { kind: 'PriorityClass', group: '/apis/scheduling.k8s.io/v1', resource: 'priorityclasses', namespaced: false, genType: 'priorityclass', genExtra: true, fetch: fetchPriorityClass },
    clusterrolebindings: { kind: 'ClusterRoleBinding', group: '/apis/rbac.authorization.k8s.io/v1', resource: 'clusterrolebindings', namespaced: false, genType: 'clusterrolebinding', fetch: fetchClusterRoleBinding },
  }
  // 生成并顶替手写（解构到与原函数同名）
  const _crud = {}
  ;(_crud.configmaps = makeCrud('configmaps', RESOURCE_SPECS.configmaps))
  const { add: addConfigMap, update: updateConfigMap, delete: deleteConfigMap } = _crud.configmaps
  ;(_crud.secrets = makeCrud('secrets', RESOURCE_SPECS.secrets))
  const { add: addSecret, update: updateSecret, delete: deleteSecret } = _crud.secrets
  ;(_crud.pvcs = makeCrud('pvcs', RESOURCE_SPECS.pvcs))
  const { add: addPVC, update: updatePVC, delete: deletePVC } = _crud.pvcs
  ;(_crud.services = makeCrud('services', RESOURCE_SPECS.services))
  const { add: addService, update: updateService, delete: deleteService } = _crud.services
  ;(_crud.networkpolicies = makeCrud('networkpolicies', RESOURCE_SPECS.networkpolicies))
  const { add: addNetworkPolicy, update: updateNetworkPolicy, delete: deleteNetworkPolicy } = _crud.networkpolicies
  ;(_crud.hpas = makeCrud('hpas', RESOURCE_SPECS.hpas))
  const { add: addHPA, update: updateHPA, delete: deleteHPA } = _crud.hpas
  ;(_crud.resourcequotas = makeCrud('resourcequotas', RESOURCE_SPECS.resourcequotas))
  const { add: addResourceQuota, update: updateResourceQuota, delete: deleteResourceQuota } = _crud.resourcequotas
  ;(_crud.limitranges = makeCrud('limitranges', RESOURCE_SPECS.limitranges))
  const { add: addLimitRange, update: updateLimitRange, delete: deleteLimitRange } = _crud.limitranges
  ;(_crud.serviceaccounts = makeCrud('serviceaccounts', RESOURCE_SPECS.serviceaccounts))
  const { add: addServiceAccount, update: updateServiceAccount, delete: deleteServiceAccount } = _crud.serviceaccounts
  ;(_crud.rolebindings = makeCrud('rolebindings', RESOURCE_SPECS.rolebindings))
  const { add: addRoleBinding, update: updateRoleBinding, delete: deleteRoleBinding } = _crud.rolebindings
  ;(_crud.poddisruptionbudgets = makeCrud('poddisruptionbudgets', RESOURCE_SPECS.poddisruptionbudgets))
  const { add: addPDB, update: updatePDB, delete: deletePDB } = _crud.poddisruptionbudgets
  ;(_crud.ingresses = makeCrud('ingresses', RESOURCE_SPECS.ingresses))
  const { add: addIngress, update: updateIngress, delete: deleteIngress } = _crud.ingresses
  ;(_crud.ingressclasses = makeCrud('ingressclasses', RESOURCE_SPECS.ingressclasses))
  const { add: addIngressClass, update: updateIngressClass, delete: deleteIngressClass } = _crud.ingressclasses
  ;(_crud.runtimeclasses = makeCrud('runtimeclasses', RESOURCE_SPECS.runtimeclasses))
  const { add: addRuntimeClass, update: updateRuntimeClass, delete: deleteRuntimeClass } = _crud.runtimeclasses
  ;(_crud.priorityclasses = makeCrud('priorityclasses', RESOURCE_SPECS.priorityclasses))
  const { add: addPriorityClass, update: updatePriorityClass, delete: deletePriorityClass } = _crud.priorityclasses
  ;(_crud.clusterrolebindings = makeCrud('clusterrolebindings', RESOURCE_SPECS.clusterrolebindings))
  const { add: addClusterRoleBinding, update: updateClusterRoleBinding, delete: deleteClusterRoleBinding } = _crud.clusterrolebindings

  // === CRUD: Ingress (add/update/delete 已进工厂；updateIngressRules 手写——特殊 PATCH)===
  // 结构化编辑 Ingress 路由规则：入参 flatRules + defaultBackend，
  // 用 buildIngressRulesPatch 构造 PATCH body（rules + defaultBackend 一次提交）；
  // defaultBackend===null 时 merge-patch 删除该字段。
  // 单次远端写：PATCH 已携带全量 rules+defaultBackend；不再二次 updateIngress——
  // 那条链路走 generateYAML 有损 SSA（单 tls 折叠/无 defaultBackend 会静默剪除多 TLS 条目）。
  // 成功 toast 由调用方负责（④ NsIngressDetail.saveRules / ② NsWorkloadDetail.saveIngressMap 各自 notify）。
  async function updateIngressRules(name, ns, flatRules, defaultBackend = null) {
    const patch = buildIngressRulesPatch(flatRules, defaultBackend)
    await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify(patch),
    })
    invalidateResource('ingresses') // Vue Query refetch 恢复缓存真值
  }

  // (ConfigMaps / Secrets / PVCs CRUD 已进工厂)

  // === CRUD: PersistentVolumes（集群级，手写——特殊 patch）===
  async function addPV(pv) {
    return remoteCreate(generateYAML('pv', pv), `PersistentVolume/${pv.name}`, () => invalidateResource('pvs'))
  }
  async function updatePV(name, updates) {
    const cur = await fetchPV(name).catch(() => null)
    if (!cur) { invalidateResource('pvs'); return }
    const patch = buildPVPatch(cur, updates)
    if (!patch) return
    await remotePatch(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, patch, 'PersistentVolume')
    invalidateResource('pvs') // Storage.vue 的 PV 查询 key 是 'pvs'(旧 'persistentvolumes' 失效打空)
  }
  async function deletePV(name) {
    try {
      await api.k8s(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('pvs')
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `PersistentVolume/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // === CRUD: StorageClasses（集群级）===
  async function addStorageClass(sc) {
    return remoteCreate(generateYAML('storageclass', sc), `StorageClass/${sc.name}`, () => invalidateResource('storageclasses'))
  }
  async function updateStorageClass(name, updates) {
    const cur = await fetchStorageClass(name).catch(() => null)
    if (!cur) { invalidateResource('storageclasses'); return }
    const patch = buildStorageClassPatch(cur, updates)
    if (!patch) return
    await remotePatch(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, patch, 'StorageClass')
    invalidateResource('storageclasses')
  }
  async function deleteStorageClass(name) {
    try {
      await api.k8s(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('storageclasses')
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `StorageClass/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  async function deleteWorkload(name, ns) {
    const wl = await getWorkloadForEdit(name, ns)
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl?.type]
    if (!plural) { notify('error', i18n.global.t('store.deleteNotSupported', { type: wl?.type || i18n.global.t('store.thisWorkload') })); return }
    try {
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, { method: 'DELETE' })
      invalidateResource('workloads')
    } catch (e) {
      // 与旧 remoteDelete 一致：失败只提示不抛（handleDelete 仍会跳列表页）
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: i18n.global.t('store.workload'), msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // 从 Vue Query 缓存或 API 取单个工作负载（all-real-data 真相源；替代旧 workloadList.findIndex）
  async function getWorkloadForEdit(name, ns) {
    const cid = currentCluster.value || 'cluster'
    const cached = queryClient.getQueryData(['cluster', cid, 'workloads']) || []
    const hit = cached.find(w => w.name === name && w.namespace === ns)
    if (hit) return hit
    // 缓存未命中：逐类型探测 API（Deployment/StatefulSet/DaemonSet）
    for (const type of ['Deployment', 'StatefulSet', 'DaemonSet']) {
      try { return await fetchWorkload(type, name, ns) } catch { /* 继续下一个类型 */ }
    }
    return null
  }

  async function updateWorkload(name, ns, updates) {
    const cur = await getWorkloadForEdit(name, ns)
    if (!cur) { invalidateResource('workloads'); return }
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[cur.type]
    // 定点 merge-patch：仅改动字段，避免 regenerate 丢失深模板（env/probes/卷）。Job/CronJob 等不支持定点编辑。
    if (plural) {
      const patch = {}
      // labels：合并 tier→layer.aliangboard.io，保留既有 labels（merge-patch 全量回写，故取并集）
      if (updates.labels || updates.tier != null) {
        const labels = { ...(updates.labels || cur.labels || {}) }
        if (updates.tier != null) labels['layer.aliangboard.io'] = updates.tier
        patch.metadata = { labels }
      }
      // 平台编辑自动 tag（managed-by + last-edited）
      const _edittag = aliangTag()
      patch.metadata = patch.metadata || {}
      patch.metadata.labels = { ...(patch.metadata.labels || {}), ..._edittag.labels }
      patch.metadata.annotations = _edittag.annotations
      const spec = {}
      if (updates.replicas != null) {
        const r = Number(String(updates.replicas).split('/')[0])
        if (!Number.isNaN(r)) spec.replicas = r
      }
      if (updates.image) {
        const tpl = cur.raw?.spec?.template || { spec: { containers: [{ name: cur.name, image: cur.image }] } }
        if (tpl.spec?.containers?.[0]) {
          const tpl2 = JSON.parse(JSON.stringify(tpl))
          tpl2.spec.containers[0].image = updates.image
          spec.template = tpl2
        }
      }
      // 更新策略 + 历史版本上限（Deployment 级 spec，不在 pod 模板）
      if (updates.strategy) {
        spec.strategy = { type: updates.strategy }
        if (updates.strategy === 'RollingUpdate') {
          const ru = {}
          if (updates.maxSurge != null && updates.maxSurge !== '') ru.maxSurge = updates.maxSurge
          if (updates.maxUnavailable != null && updates.maxUnavailable !== '') ru.maxUnavailable = updates.maxUnavailable
          if (Object.keys(ru).length) spec.strategy.rollingUpdate = ru
        }
      }
      if (updates.revisionHistoryLimit != null && updates.revisionHistoryLimit !== '') spec.revisionHistoryLimit = Number(updates.revisionHistoryLimit)
      if (Object.keys(spec).length) patch.spec = spec
      if (Object.keys(patch).length) {
        await remotePatch(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, patch, i18n.global.t('store.workload'))
      }
    }
    invalidateResource('workloads')
  }

  // 深度编辑工作负载的 Pod 模板（image/env/resources/probes/nodeSelector 等）：
  // 入参 template 为完整的 pod template 对象（深克隆后由视图修改）。
  // 远端 PATCH spec.template（全量 merge-patch，安全）；本地合并并刷新 image。仅 Deployment/StatefulSet/DaemonSet。
  // 就地修改任意资源的分层（NsLayers 用）：写 layer.aliangboard.io label 并本地即时反映。
  // 取当前 labels 再合并后全量回写，避免 merge-patch 下 labels 对象被替换而丢其它键。
  const LABEL_RES = {
    Deployment: ['/apis/apps/v1', 'deployments', 'workload'],
    StatefulSet: ['/apis/apps/v1', 'statefulsets', 'workload'],
    DaemonSet: ['/apis/apps/v1', 'daemonsets', 'workload'],
    Job: ['/apis/batch/v1', 'jobs', 'workload'],
    CronJob: ['/apis/batch/v1', 'cronjobs', 'workload'],
    Service: ['/api/v1', 'services', 'service'],
    Ingress: ['/apis/networking.k8s.io/v1', 'ingresses', 'ingress'],
  }
  async function reassignLayer(kind, name, ns, layerKey) {
    const res = LABEL_RES[kind]
    if (!res) throw new Error(i18n.global.t('store.unsupportedLayerKind', { kind }))
    const [gv, plural] = res
    const path = `${gv}/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`
    let labels = {}
    try { labels = (await api.k8s(path))?.metadata?.labels || {} } catch { /* 读取失败则从空开始 */ }
    labels = { ...labels, 'layer.aliangboard.io': layerKey, 'aliangboard.io/managed-by': 'aliangboard' }
    await api.k8s(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ metadata: { labels, annotations: { 'aliangboard.io/last-edited': new Date().toISOString() } } }),
    })
    // P2-B：NsLayers 已迁 Vue Query（store 孤儿列表无读者）→ PATCH 后失效对应查询，
    // 页面 30s 轮询之外的即时对齐；乐观写 store 列表的旧路径删除。
    invalidateResource(res[2] === 'workload' ? 'workloads' : res[2] === 'service' ? 'services' : 'ingresses')
  }

  async function applyWorkloadTemplate(name, ns, template) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (!plural) throw new Error(`${i18n.global.t('store.deepEditNotSupported', { type: wl.type || i18n.global.t('store.thisWorkload') })}`)
    const tag = aliangTag()
    await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { template }, metadata: { labels: tag.labels, annotations: tag.annotations } }),
    })
    invalidateResource('workloads')
  }

  // 业务元数据编辑：一次 merge-patch 同时写 Deployment.metadata.labels/annotations + Pod 模板 labels（与创建一致）。
  // - labels/annotations：期望「全量 map」（视图已并入系统保留键的旧值）；removedLabels/removedAnnotations：需删除的键（merge-patch 用 null 删除）。
  // - templateLabels：期望的 Pod 模板 labels 全量（镜像业务/自定义标签，与创建落点一致）；null 则不触碰 Pod 模板。
  // 乐观更新本地状态，远端失败回滚。仅 Deployment/StatefulSet/DaemonSet。
  async function updateWorkloadMeta(name, ns, payload) {
    const cur = await getWorkloadForEdit(name, ns)
    if (!cur) throw new Error(i18n.global.t('store.workloadNotFound'))
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[cur.type]
    if (!plural) throw new Error(`${i18n.global.t('store.editMetadataNotSupported', { type: cur.type || i18n.global.t('store.thisWorkload') })}`)
    const { labels = {}, annotations = {}, removedLabels = [], removedAnnotations = [], templateLabels = null } = payload || {}
    const tag = aliangTag() // managed-by + last-edited 自动 tag
    const outLabels = { ...labels, ...tag.labels }
    removedLabels.forEach(k => { outLabels[k] = null })
    const outAnnotations = { ...annotations, ...tag.annotations }
    removedAnnotations.forEach(k => { outAnnotations[k] = null })
    const patch = { metadata: { labels: outLabels, annotations: outAnnotations } }
    if (templateLabels) patch.spec = { template: { metadata: { labels: templateLabels } } }

    await remotePatch(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, patch, i18n.global.t('store.metadata'))
    invalidateResource('workloads')
  }

  // 伸缩副本数（Deployment/StatefulSet）：PATCH /scale。
  // 数据层与 updateWorkload/updateWorkloadMeta 同源——getWorkloadForEdit 从 Vue Query 缓存取类型
  // （缓存未命中逐类型探测），不再读 store.workloadList（远端为空 → 旧实现 find 返回 undefined →
  // 误抛 scaleNotSupported，即概览页「+/- 调副本」偶尔提示「不支持调整」的真因）。
  // 成功：乐观 setQueryData（desired 立即跳变，ready 不虚增）+ invalidateResource（后台纠偏）。
  // 失败：invalidateResource 触发 refetch，真值覆盖乐观值，实现自动回滚。
  async function scaleWorkload(name, ns, replicas) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets' }[wl.type]
    if (!plural) throw new Error(`${i18n.global.t('store.scaleNotSupported', { type: wl.type || i18n.global.t('store.thisWorkload') })}`)
    const next = Number(replicas)
    const cid = currentCluster.value || 'cluster'
    // 乐观：副本大数字（rollout.desired 读 raw.spec.replicas）+ 概览卡（workload.replicas 扁平串）立即跳变
    queryClient.setQueryData(['cluster', cid, 'workloads'], old => (old || []).map(w => {
      if (w.name !== name || w.namespace !== ns) return w
      const ready = Number(String(w.replicas || '0/0').split('/')[0]) || 0
      const raw = w.raw ? { ...w.raw, spec: { ...(w.raw.spec || {}), replicas: next } } : w.raw
      return { ...w, raw, replicas: `${Math.min(ready, next)}/${next}` }
    }))
    try {
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}/scale`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { replicas: next } }),
      })
    } catch (e) {
      invalidateResource('workloads') // 失败回滚：refetch 用真值覆盖乐观值
      throw e
    }
    invalidateResource('workloads') // 成功后台纠偏（ready 副本数等控制器追上）
  }

  // 重启（Deployment/StatefulSet/DaemonSet）：PATCH template 注解 restartedAt 触发滚动重启。
  // 与 scaleWorkload 同源走 getWorkloadForEdit——旧实现读空 workloadList → 误抛 restartNotSupported。
  async function restartWorkload(name, ns) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (!plural) throw new Error(`${i18n.global.t('store.restartNotSupported', { type: wl.type || i18n.global.t('store.thisWorkload') })}`)
    await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }),
    })
    invalidateResource('workloads')
  }

  // 一键回滚到指定 revision（kubectl rollout undo --to-revision=N 语义）
  // 与 scaleWorkload 同源走 getWorkloadForEdit——旧实现读空 workloadList → 误抛 workloadNotFound。
  // revisions 来自缓存的工作负载对象（mapWorkload 从 ReplicaSets 填充），target._template 携带完整模板。
  async function rollbackWorkload(name, ns, revNumber) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const target = (wl.revisions || []).find(r => r.rev === revNumber)
    if (!target) throw new Error(i18n.global.t('store.revisionNotFound', { rev: revNumber }))
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (plural) {
      // kubectl rollout undo --to-revision=N：把工作负载 template 还原为目标 ReplicaSet 的完整 template
      const body = target._template
        ? { spec: { template: target._template }, metadata: { labels: { 'aliangboard.io/managed-by': 'aliangboard' }, annotations: { 'aliangboard.io/last-edited': new Date().toISOString(), 'aliangboard.io/last-action': `rollback-to-rev-${revNumber}` } } }
        : { spec: { template: { spec: { containers: [{ name: wl.name, image: target.image }] } } }, metadata: { labels: { 'aliangboard.io/managed-by': 'aliangboard' }, annotations: { 'aliangboard.io/last-edited': new Date().toISOString(), 'aliangboard.io/last-action': `rollback-to-rev-${revNumber}` } } }
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(body),
      })
    }
    invalidateResource('workloads')
  }

  async function deletePod(name, ns) {
    await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`, { method: 'DELETE' })
    // P2-B：旧实现 splice 孤儿 podList（无读者、不触发列表刷新）；改失效 pods 查询，
    // NsPods/PodDetail/NsWorkloadDetail 等 Query 消费者即时对齐（live watch 之外的第二道纠偏）。
    invalidateResource('pods')
    return null
  }

  // 周期健康检查：轻量重拉 /api/v1/nodes → 就地更新 nodeList 的 Ready/NotReady + apiReachable。
  // 失败 → apiReachable=false（clusterHealth 转 Disconnected）。只更新现有节点状态，不碰 metrics/raw；节点增删由全量 hydrate 处理。
  let healthTimer = null
  async function refreshNodeHealth() {
    try {
      const data = await api.k8s('/api/v1/nodes?limit=500')
      const byName = new Map((data?.items || []).map(it => [it.metadata?.name, it]))
      for (const n of nodeList.value) {
        const item = byName.get(n.name)
        if (item) {
          const ready = item.status?.conditions?.find(c => c.type === 'Ready')
          n.status = ready?.status === 'True' ? 'Ready' : 'NotReady'
        }
      }
      apiReachable.value = true
    } catch { apiReachable.value = false }
  }
  function startHealthCheck() {
    if (healthTimer) return
    refreshNodeHealth()
    healthTimer = setInterval(refreshNodeHealth, 10000)
  }
  function stopHealthCheck() { if (healthTimer) clearInterval(healthTimer); healthTimer = null }

  // === Pod / Event Watch：实时监听（ADDED/MODIFIED/DELETED 增量更新）===
  // P2-B：watch 事件只 queryClient.setQueryData（NsPods/NsEvents 等 Query 消费者享 live）。
  // 安全策略：从水合时的 resourceVersion 续接，只收变更事件；流断开或出错（含 RV 失效 410）即停，
  // 由 UI 提示用户手动恢复——不做自动重连，避免在不可控网络下产生重连风暴。

  // --- Pod Watch ---
  function startPodWatch() {
    if (podWatchHandle) return
    const rv = podWatchRv || ''
    const path = `/api/v1/pods?watch=true${rv ? `&resourceVersion=${encodeURIComponent(rv)}` : ''}`
    podWatchLive.value = true
    podWatchHandle = k8sStream(path, {
      onMessage: line => {
        try {
          const evt = JSON.parse(line)
          if (evt.object?.metadata?.resourceVersion) podWatchRv = evt.object.metadata.resourceVersion
          // P2-B：只写 Query 缓存（NsPods 等 Query 消费者享 live）；旧 applyPodWatchEvent 双写孤儿 podList 已删
          const _cid = currentCluster.value || 'cluster'
          queryClient.setQueryData(['cluster', _cid, 'pods'], old => applyWatchEvent(old || [], evt.type, mapPod(evt.object)))
        } catch { /* 忽略非 JSON 心跳行 */ }
      },
      onError: stopPodWatch,
      onClose: stopPodWatch,
    })
  }
  function stopPodWatch() {
    podWatchLive.value = false
    if (podWatchHandle) { podWatchHandle.abort(); podWatchHandle = null }
  }

  // --- Event Watch ---
  function startEventWatch() {
    if (eventWatchHandle) return
    const path = `/api/v1/events?watch=true${eventWatchRv ? `&resourceVersion=${encodeURIComponent(eventWatchRv)}` : ''}`
    eventWatchLive.value = true
    eventWatchHandle = k8sStream(path, {
      onMessage: line => {
        try {
          const evt = JSON.parse(line)
          if (evt.object?.metadata?.resourceVersion) eventWatchRv = evt.object.metadata.resourceVersion
          // P2-B：只写 Query 缓存（NsEvents 等 Query 消费者享 live）；旧 applyEventWatchEvent 双写孤儿 eventList 已删
          const _cid = currentCluster.value || 'cluster'
          queryClient.setQueryData(['cluster', _cid, 'events'], old => applyWatchEvent(old || [], evt.type, mapEvent(evt.object)))
        } catch { /* 忽略非 JSON 心跳行 */ }
      },
      onError: stopEventWatch,
      onClose: stopEventWatch,
    })
  }
  function stopEventWatch() {
    eventWatchLive.value = false
    if (eventWatchHandle) { eventWatchHandle.abort(); eventWatchHandle = null }
  }
  // 节点列表拉取（自包含：nodes + node-metrics → mapNode）。供 Nodes 页 Vue Query 作 fetcher，不依赖 hydrate。

  // 轻量 metrics 刷新：只重拉 metrics.k8s.io nodes+pods → 就地更新现有 nodeList 指标字段 → 重算集群汇总。
  // 供监控中心高频轮询；不重拉 nodes/pods 列表（结构不变）。失败静默（保留上次 metricsAvailable，下次全量 hydrate 纠正）。
  async function refreshMetrics() {
    try {
      const [nodeMetricsData, podMetricsData] = await Promise.all([
        api.k8s('/apis/metrics.k8s.io/v1beta1/nodes'),
        api.k8s('/apis/metrics.k8s.io/v1beta1/pods'),
      ])
      const metricsAvailable = Boolean(nodeMetricsData && podMetricsData)
      const nodeMetricMap = new Map()
      for (const it of (nodeMetricsData?.items || [])) nodeMetricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
      const podMetricMap = new Map()
      for (const it of (podMetricsData?.items || [])) {
        let cpuMilli = 0, memKi = 0
        for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
        podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
      }
      const pct = (used, alloc) => (used != null && alloc > 0 ? Math.min(100, Math.round((used / alloc) * 100)) : null)
      for (const n of nodeList.value) {
        const m = metricsAvailable ? (nodeMetricMap.get(n.name) || null) : null
        n.usedCpu = m ? m.cpuMilli : null
        n.usedMem = m ? m.memKi : null
        n.cpu = pct(n.usedCpu, n.allocCpu)
        n.memory = pct(n.usedMem, n.allocMem)
      }
      // P2-B:pod 级指标不再写孤儿 podList——NsPods 等由 fetchPods 的 Query 轮询携带 podMetric;
      // podMetricMap 仅用于 metricsAvailable 探测(pods metrics 端点可达性)。
      computeClusterMetrics(metricsAvailable)
    } catch { /* 静默：保留上次 metricsAvailable */ }
  }

  // === 集群指标采样(全局共享,15min 窗口按集群持久化) ===
  // ClusterOverview/MonitoringCenter 引用计数共享:切页不清零、不双倍轮询;
  // 恢复窗口来自 localStorage,图表首屏即有最近 15 分钟历史。
  const cpuSamples = ref([])
  const memSamples = ref([])
  const metricsSampling = ref(false)
  const metricsLastRefresh = ref(null)
  let metricsTimer = null
  let metricsConsumers = 0
  let metricsVisListener = null
  // 切集群竞态双守卫:
  // - metricsEpoch:窗口代数。reloadMetricsWindow 真重载时 ++;tick 入口捕获、await 后
  //   不等则丢弃本次 push/persist——杀变体 A(tick 挂起间切集群,恢复后旧集群值进新窗口/新 key)。
  // - metricsHold:switchCluster 入口置 true、自身 finally 必清(hydrateCriticalResources
  //   的 finally 也兜底清)。hold 期间 tick 直接 return——杀变体 B(nodeList 未换血前,
  //   旧节点配新集群 metrics 算出 0% 假样本并持久化)。
  let metricsEpoch = 0
  let metricsHold = false
  // 当前内存窗口所属集群:reloadMetricsWindow 同集群时跳过重载——隐私模式/配额下
  // (localStorage 读写退化)页面导航 stop/start 不再清窗,会话内窗口得以延续。
  const metricsWindowCluster = ref(null)

  function metricsStorageKey() {
    return currentCluster.value ? `aliangboard.metrics.${encodeURIComponent(currentCluster.value)}.v1` : null
  }
  function persistMetricsWindow() {
    const key = metricsStorageKey()
    if (!key) return
    try { localStorage.setItem(key, JSON.stringify(persistPayload(cpuSamples.value, memSamples.value))) } catch { /* 配额/隐私模式:退化为会话内窗口 */ }
  }
  // 从 localStorage 恢复当前集群窗口(切集群/首个消费者上线时调用)。
  // 窗口已属于当前集群时跳过:隐私模式/配额下导航不清窗(降级持久化模式)。
  function reloadMetricsWindow() {
    if (metricsWindowCluster.value === currentCluster.value) return
    metricsEpoch++   // 翻代:挂起中的旧 tick 恢复后按代数不等自弃
    const key = metricsStorageKey()
    let cpu = [], mem = []
    if (key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null')
        const now = Date.now()
        cpu = restoreSamples(raw?.cpu, { now })
        mem = restoreSamples(raw?.mem, { now })
      } catch { cpu = []; mem = [] }
    }
    cpuSamples.value = cpu
    memSamples.value = mem
    metricsLastRefresh.value = null
    metricsWindowCluster.value = currentCluster.value
  }
  async function metricsTick() {
    if (document.hidden) return
    if (metricsSampling.value) return   // 重入守卫:慢 fetch 上一轮未完,本轮直接跳过(与 sampleNow 亦去重)
    if (metricsHold) return             // 切集群水合中:不采样,防旧 nodeList 算出假样本
    const epoch = metricsEpoch
    metricsSampling.value = true
    try {
      await refreshMetrics()
      if (epoch !== metricsEpoch) return   // await 间切了集群:丢弃本次 push/persist
      const now = Date.now()
      const cpu = cluster.value.cpuUsage
      const mem = cluster.value.memoryUsage
      if (cpu != null) cpuSamples.value = pushSample(cpuSamples.value, { t: now, v: cpu })
      if (mem != null) memSamples.value = pushSample(memSamples.value, { t: now, v: mem })
      if (cpu != null || mem != null) {
        metricsLastRefresh.value = now
        persistMetricsWindow()
      }
    } finally { metricsSampling.value = false }
  }
  function startMetricsSampling() {
    metricsConsumers++
    if (metricsConsumers === 1) {
      reloadMetricsWindow()
      metricsVisListener = () => { if (!document.hidden && metricsTimer) metricsTick() }
      document.addEventListener('visibilitychange', metricsVisListener)
      metricsTick()   // 立即一轮(不 await)
      metricsTimer = setInterval(metricsTick, 10000)
    }
  }
  function stopMetricsSampling() {
    metricsConsumers = Math.max(0, metricsConsumers - 1)
    if (metricsConsumers === 0) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null }
      if (metricsVisListener) { document.removeEventListener('visibilitychange', metricsVisListener); metricsVisListener = null }
    }
  }
  function sampleNow() { return metricsTick() }

  // (NetworkPolicies / HPAs / ResourceQuotas / LimitRanges CRUD 已进工厂)

  // === CRUD: RBAC (Role 手写——Cluster/Namespace 双 scope；ServiceAccount/RoleBinding 已进工厂)===
  async function addRole(role) {
    return remoteCreate(generateYAML('role', role), `${role.scope === 'Cluster' ? 'ClusterRole' : 'Role'}/${role.name}`, () => invalidateResource('roles'))
  }

  async function updateRole(name, ns, updates) {
    // Role 双 scope：优先 namespace Role，失败则试 ClusterRole
    let cur = null
    if (ns) cur = await fetchRole(name, ns).catch(() => null)
    if (!cur) cur = await fetchClusterRole(name).catch(() => null)
    if (!cur) { invalidateResource('roles'); return }
    const merged = { ...cur, ...updates }
    await remoteUpdate(generateYAML('role', merged), 'Role')
    invalidateResource('roles')
  }

  async function deleteRole(name, ns) {
    // P2-B:ns 空 = ClusterRole。旧版读孤儿 roleList 判 scope(恒 undefined)→ 删 ClusterRole
    // 永远错走 namespaced 路径 404(RBAC 页 clusterrole 行的删除曾必失败)。
    const path = ns
      ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`
      : `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`
    try {
      await api.k8s(path, { method: 'DELETE' })
      invalidateResource('roles') // fetchRoles 合并 roles+clusterroles,单 key 覆盖双端点
    } catch (e) {
      notify('error', i18n.global.t('store.deleteFailedWithLabel', { label: `Role/${name}`, msg: e.message || i18n.global.t('store.permissionDeniedOrNotFound') }))
    }
  }

  // (ServiceAccount / RoleBinding CRUD 已进工厂)

  // === CRUD: ClusterRoleBindings（CRUD 已进工厂）===

  // === CRUD: Nodes ===
  async function cordonNode(name) {
    await api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { unschedulable: true } }),
    })
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = true
    invalidateResource('nodes')
  }

  async function uncordonNode(name) {
    await api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { unschedulable: false } }),
    })
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = false
    invalidateResource('nodes')
  }

  // Drain：cordon + 驱逐该节点上的业务 Pod（保留系统命名空间 Pod）
  async function drainNode(name) {
    await cordonNode(name)
    const data = await api.k8s(`/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${name}`)}`)
    const evictable = (data.items || []).filter(item => {
      const owners = item.metadata?.ownerReferences || []
      const isDaemonSet = owners.some(owner => owner.kind === 'DaemonSet')
      const isMirrorPod = Boolean(item.metadata?.annotations?.['kubernetes.io/config.mirror'])
      return !isDaemonSet && !isMirrorPod
    })
    for (const item of evictable) {
      await api.k8s(`/api/v1/namespaces/${encodeURIComponent(item.metadata.namespace)}/pods/${encodeURIComponent(item.metadata.name)}/eviction`, {
        method: 'POST',
        body: JSON.stringify({
          apiVersion: 'policy/v1',
          kind: 'Eviction',
          metadata: { name: item.metadata.name, namespace: item.metadata.namespace },
        }),
      })
    }
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' })
    await hydrateCriticalResources({ silent: true })
    return evictable.length
  }

  // === CRUD: Namespaces ===
  async function addNamespace(ns) {
    if (typeof ns === 'string') ns = { name: ns, labels: {} }
    const labelsYaml = ns.labels && Object.keys(ns.labels).length
      ? '\n  labels:\n' + Object.entries(ns.labels).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`).join('\n')
      : ''
    const yaml = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns.name}${labelsYaml}`
    const refresh = () => refetch('/api/v1/namespaces', namespaceList, item => ({
      name: item.metadata?.name,
      status: item.status?.phase || 'Unknown',
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
    }))
    return remoteCreate(yaml, `Namespace/${ns.name}`, refresh)
  }

  async function deleteNamespace(name) {
    await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(name)}`, namespaceList, n => n.name === name)
  }

  // === 多集群 ===
  // 切换活跃集群：写入该集群 token 为活跃 → 重新水合（后端 session 仍在内存中即可直接复用）
  async function switchCluster(apiServer) {
    const c = savedClusters.value.find(x => x.apiServer === apiServer)
    if (!c) return
    metricsHold = true   // 水合期间挂起 tick(变体 B);try/finally 必清,不会永久卡死采样
    try {
      // 切集群前停止旧集群的实时监听并清空命名空间作用域，避免旧 ns 残留 / 旧 watch 带失效 token 报错
      try { stopPodWatch() } catch { /* 未启动时忽略 */ }
      try { stopEventWatch() } catch { /* 未启动时忽略 */ }
      currentNamespace.value = ''
      setActiveToken(c.token)
      activeApiServerRef.value = c.apiServer
      currentCluster.value = c.name
      reloadMetricsWindow()   // epoch++:挂起中的旧 tick 恢复后自弃(变体 A)
      cluster.value = { ...cluster.value, name: c.name, apiServer: c.apiServer, version: c.version, status: c.status || 'Healthy' }
      connectionState.value = 'loading'
      try { queryClient.clear(); await hydrateCriticalResources() } catch { connectionState.value = 'error' }
      apiReachable.value = true
      startHealthCheck()
    } finally { metricsHold = false }
  }
  // 移除已保存集群
  function removeSavedClusterStore(apiServer) {
    // 孤儿清理:按 apiServer 反查集群 name,连带删该集群的 metrics 持久化窗口 key
    const c = savedClusters.value.find(x => x.apiServer === apiServer)
    if (c) {
      try { localStorage.removeItem(`aliangboard.metrics.${encodeURIComponent(c.name)}.v1`) } catch { /* 静默:隐私模式等 */ }
    }
    removeSavedCluster(apiServer)
    savedClusters.value = getSavedClusters()
  }

  function setConnectedCluster(info) {
    connectionState.value = 'loading'
    let name = info.name
    try { name = name || new URL(info.apiServer).hostname } catch { name = name || info.apiServer }
    // 持久化到「已保存集群」（多集群）：token 取当前活跃会话
    addSavedCluster({ name, apiServer: info.apiServer, token: getSessionToken(), version: info.version, authMethod: info.authMethod })
    savedClusters.value = getSavedClusters()
    activeApiServerRef.value = info.apiServer
    currentCluster.value = name
    reloadMetricsWindow()
    cluster.value = {
      ...cluster.value,
      name,
      apiServer: info.apiServer,
      version: info.version || cluster.value.version,
      status: 'Healthy',
    }
    apiReachable.value = true
    startHealthCheck()
  }

  async function fetchCRDs() { const d = await api.k8s('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500'); return (d?.items || []).map(mapCRD) }
  async function fetchCRD(name) { const d = await api.k8s(`/apis/apiextensions.k8s.io/v1/customresourcedefinitions/${encodeURIComponent(name)}`); return d ? mapCRD(d) : null }
  async function fetchCRInstances(crd) {
    const d = await api.k8s(`/apis/${crd.group}/${crd.version}/${crd._plural}?limit=500`)
    return (d?.items || []).map(mapCRInstance)
  }
  async function fetchPods() {
    const [podData, metricsData] = await Promise.all([
      api.k8s('/api/v1/pods?limit=1000'),
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods').catch(() => null),
    ])
    const metricsAvailable = Boolean(metricsData)
    const podMetricMap = new Map()
    for (const it of (metricsData?.items || [])) {
      let cpuMilli = 0, memKi = 0
      for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
      podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
    }
    const podMetric = (ns, name) => (metricsAvailable ? (podMetricMap.get(`${ns}/${name}`) || null) : null)
    return (podData?.items || []).map(item => mapPod(item, podMetric(item.metadata?.namespace, item.metadata?.name)))
  }
  async function fetchPod(name, ns) {
    const [data, metricsData] = await Promise.all([
      api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`),
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods').catch(() => null),
    ])
    if (!data) return null
    const m = (metricsData?.items || []).find(it => it.metadata?.namespace === ns && it.metadata?.name === name)
    return mapPod(data, m ? { cpuMilli: m.containers?.reduce((s, c) => s + cpuToMilli(c.usage?.cpu), 0), memKi: m.containers?.reduce((s, c) => s + memToKi(c.usage?.memory), 0) } : null)
  }
  async function fetchEvents() { const d = await api.k8s('/api/v1/events?limit=1000'); return ((d?.items || []).map(mapEvent)).sort((a, b) => (b._ts || 0) - (a._ts || 0)) }

  // 集群级 CPU/内存汇总（按 nodeList 的 used/alloc）+ 与上次对比的趋势 + cluster.value 更新。
  // 入参 metricsAvailable：调用前 nodeList 的 metric 字段须已就绪
  // （hydrate 经 mapNode/mapPod 设置；refreshMetrics 就地更新）。hydrate 与 refreshMetrics 共用本函数。
  function computeClusterMetrics(metricsAvailable) {
    let cpuUsage = null, memoryUsage = null
    if (metricsAvailable) {
      let usedCpu = 0, allocCpu = 0, usedMem = 0, allocMem = 0
      for (const n of nodeList.value) {
        if (n.usedCpu != null) usedCpu += n.usedCpu
        if (n.allocCpu > 0) allocCpu += n.allocCpu
        if (n.usedMem != null) usedMem += n.usedMem
        if (n.allocMem > 0) allocMem += n.allocMem
      }
      cpuUsage = allocCpu > 0 ? Math.min(100, Math.round((usedCpu / allocCpu) * 100)) : null
      memoryUsage = allocMem > 0 ? Math.min(100, Math.round((usedMem / allocMem) * 100)) : null
    }
    const trendOf = (cur, prev) => {
      if (cur == null || prev == null) return { trend: '—', up: false }
      const d = cur - prev
      return { trend: (d >= 0 ? '+' : '') + d.toFixed(1) + '%', up: d > 0 }
    }
    const cpuT = trendOf(cpuUsage, prevClusterMetrics.cpu)
    const memT = trendOf(memoryUsage, prevClusterMetrics.mem)
    prevClusterMetrics = { cpu: cpuUsage, mem: memoryUsage }
    const _cid = currentCluster.value || 'cluster'
    const counts = deriveClusterCounts({
      nodes: queryClient.getQueryData(['cluster', _cid, 'nodes']),
      pods: queryClient.getQueryData(['cluster', _cid, 'pods']),
      events: queryClient.getQueryData(['cluster', _cid, 'events']),
    })
    cluster.value = {
      ...cluster.value,
      nodeCount: counts.nodeCount ?? nodeList.value.length,
      podCount: counts.podCount ?? 0,
      activeEvents: counts.activeEvents ?? 0,
      metricsAvailable,
      cpuUsage, memoryUsage,
      cpuTrend: cpuT.trend, cpuTrendUp: cpuT.up,
      memoryTrend: memT.trend, memoryTrendUp: memT.up,
    }
  }

  // 关键路径水合：仅 namespaces + nodes（2 请求），替代原 12 路全量 hydrateCoreResources。
  // clusterHealth 只需 nodeList（Ready/controlPlane），不需 metrics。
  // pods/workloads/services/ingresses/events 等由各页面 Vue Query 自取。
  async function hydrateCriticalResources(opts = {}) {
    if (!opts.silent) connectionState.value = 'loading'
    try {
      const requests = await Promise.allSettled([
        api.k8s('/api/v1/namespaces'),
        api.k8s('/api/v1/nodes'),
      ])
      const namespaceData = requests[0].status === 'fulfilled' ? requests[0].value : null
      const nodeData = requests[1].status === 'fulfilled' ? requests[1].value : null
      if (!nodeData) notify('error', i18n.global.t('store.nodeFetchFailed'))
      if (!namespaceData) {
        if (!opts.silent) connectionState.value = 'error'
        throw new Error(i18n.global.t('store.namespaceReadFailed'))
      }
      if (nodeData?.items) nodeList.value = nodeData.items.map(item => mapNode(item, null))
      if (namespaceData?.items) namespaceList.value = namespaceData.items.map(item => ({
        name: item.metadata?.name,
        status: item.status?.phase || 'Unknown',
        age: ageOf(item.metadata?.creationTimestamp),
        labels: item.metadata?.labels || {},
      }))
      if (currentNamespace.value && namespaceList.value.length
          && !namespaceList.value.some(n => n.name === currentNamespace.value)) {
        setNamespace(namespaceList.value[0].name)
      }
      // hydrateExtendedResources 已停用：11 个 extended 资源全部迁 Vue Query（零直接 store 读者），
      // 各页面按需拉取 + 同 key 去重。首屏从 2+11=13 请求降至 2（namespaces+nodes）。
      // if (!opts.lite) { try { await hydrateExtendedResources() } catch (e) { ... } }
      if (!opts.silent) connectionState.value = 'connected'
      return { failed: requests.filter(r => r.status === 'rejected').length }
    } finally { metricsHold = false }   // 兜底:任何置 hold 后走水合的路径,水合结束必释放
  }

  function getCurrentCluster() {
    return clusterList.value.find(c => c.name === currentCluster.value) || clusterList.value[0]
  }

  // === Generate YAML for a resource ===
  function generateYAML(type, resource) {
    if (!resource) return ''
    const ns = resource.namespace || currentNamespace.value
    const name = resource.name
    // 标量序列化：含换行走 block scalar(|-)，含特殊字符走双引号转义，否则裸值。
    // ConfigMap data / Secret stringData / Ingress 注解等任意用户值都应走它，避免 " 或换行破坏 YAML。
    // 复用共享 useYaml.yamlScalar（cluster.js 与 DeployApp 向导统一同一份实现）。
    const scalar = yamlScalar

    if (type === 'service') {
      const isExtName = resource.type === 'ExternalName'
      // 端口：优先用结构化 portList（含 name/nodePort/appProtocol，无损），否则解析扁平 ports 字符串
      let portSrc = (!isExtName && resource.portList?.length)
        ? resource.portList
        : (!isExtName ? String(resource.ports || '80:80/TCP').split(',').filter(Boolean).map(p => {
            const m = String(p).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/) || [, 80, 80, 'TCP']
            return { name: '', port: Number(m[1]) || 80, targetPort: isNaN(m[2]) ? m[2] : Number(m[2]), protocol: m[3] || 'TCP', nodePort: null, appProtocol: '' }
          }) : [])
      // K8s 校验:多端口 Service 每个 port 都必须有 name(spec.ports[i].name: Required value)。
      // 空名自动补 port-<端口号>(重号加序号);单端口匿名无损;不动调用方对象(防缓存污染)。
      // 单一事实源在 useYaml.ensureServicePortNames,与 DeployApp 向导共用(2026-08-17 前曾各自为政漏向导)。
      portSrc = ensureServicePortNames(portSrc)
      const portsYaml = portSrc.map(p => {
        const tgt = p.targetPort
        const lines = [`    - port: ${p.port}`]
        if (p.name) lines.push(`      name: ${p.name}`)
        if (tgt != null && tgt !== '') lines.push(`      targetPort: ${isNaN(tgt) ? tgt : Number(tgt)}`)
        lines.push(`      protocol: ${p.protocol || 'TCP'}`)
        if (p.appProtocol) lines.push(`      appProtocol: ${p.appProtocol}`)
        if (p.nodePort) lines.push(`      nodePort: ${p.nodePort}`)
        return lines.join('\n')
      }).join('\n')
      const selObj = resource.selector || {}
      const selEntries = Object.keys(selObj).length
        ? Object.entries(selObj).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : (!isExtName ? `    app: ${yamlQ(name)}` : '')
      const selBlock = selEntries ? `\n  selector:\n${selEntries}` : ''
      const portsBlock = portSrc.length ? `\n  ports:\n${portsYaml}` : ''
      // 可选 spec 字段：仅在有值 / 非默认时输出，保持无损且不污染默认服务
      const extras = []
      if (isExtName && resource.externalName) extras.push(`  externalName: ${resource.externalName}`)
      if (resource.sessionAffinity && resource.sessionAffinity !== 'None') {
        extras.push(`  sessionAffinity: ${resource.sessionAffinity}`)
        if (resource.sessionAffinityTimeout != null) extras.push(`  sessionAffinityConfig:\n    clientIP:\n      timeoutSeconds: ${resource.sessionAffinityTimeout}`)
      }
      if (resource.externalTrafficPolicy) extras.push(`  externalTrafficPolicy: ${resource.externalTrafficPolicy}`)
      if (resource.internalTrafficPolicy && resource.internalTrafficPolicy !== 'Cluster') extras.push(`  internalTrafficPolicy: ${resource.internalTrafficPolicy}`)
      if (resource.publishNotReadyAddresses) extras.push(`  publishNotReadyAddresses: true`)
      const extraYaml = extras.length ? '\n' + extras.join('\n') : ''
      return `apiVersion: v1
kind: Service
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  type: ${resource.type || 'ClusterIP'}${selBlock}${portsBlock}${extraYaml}`
    }

    if (type === 'ingress') {
      // 优先从规范 rules 数组生成，保证多 host/多 path 回写无损
      const rules = (resource.rules && resource.rules.length) ? resource.rules : [{
        host: resource.hosts,
        http: { paths: [{ path: resource.path || '/', pathType: 'Prefix', backend: { serviceName: resource.backend?.split(':')[0], servicePort: Number(resource.backend?.split(':')[1]) || 80 } }] },
      }]
      const firstHost = rules[0]?.host || resource.hosts || ''
      // tlsList(多 host TLS,③ per-host 创建)优先;存量单 tls 布尔兜底(② 与其他调用方不变)
      const tlsBlock = resource.tlsList?.length
        ? '\n  tls:\n' + resource.tlsList.map(e => `  - hosts:\n    - ${e.hosts[0]}\n    secretName: ${e.secretName}`).join('\n')
        : (resource.tls ? `\n  tls:\n  - hosts:\n    - ${firstHost}\n    secretName: ${resource.tlsSecret || name + '-tls'}` : '')
      const rulesYaml = rules.map(r => {
        const pathsYaml = (r.http?.paths || []).map(p => {
          const be = p.backend?.service || p.backend
          const svcName = be?.name ?? be?.serviceName
          const portNum = be?.port?.number ?? be?.servicePort ?? be?.port
          return `      - path: ${p.path || '/'}
        pathType: ${p.pathType || 'Prefix'}
        backend:
          service:
            name: ${svcName || name + '-svc'}
            port:
              number: ${portNum || 80}`
        }).join('\n')
        return `  - host: ${r.host}
    http:
      paths:
${pathsYaml}`
      }).join('\n')
      const labelsYaml = resource.labels && Object.keys(resource.labels).length
        ? '\n  labels:\n' + Object.entries(resource.labels).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const annYaml = resource.annotations && Object.keys(resource.annotations).length
        ? '\n  annotations:\n' + Object.entries(resource.annotations).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      // ingressClassName 仅在显式指定时写入；未指定则省略，由集群默认 IngressClass 接管（避免硬编码 nginx 指向不存在的类）
      const classNameLine = resource.className ? `\n  ingressClassName: ${resource.className}` : ''
      return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${labelsYaml}${annYaml}
spec:${classNameLine}${tlsBlock}
  rules:
${rulesYaml}`
    }

    if (type === 'configmap') {
      const fmtMap = obj => obj && Object.keys(obj).length
        ? Object.entries(obj).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const labelsYaml = fmtMap(resource.labels)
      const annYaml = fmtMap(resource.annotations)
      const metaExtra = [
        labelsYaml && '  labels:\n' + labelsYaml,
        annYaml && '  annotations:\n' + annYaml,
      ].filter(Boolean).join('\n')
      const dataEntries = resource.data ? Object.entries(resource.data)
        .map(([k, v]) => `  ${k}: ${scalar(v)}`).join('\n') : ''
      return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${metaExtra ? '\n' + metaExtra : ''}
data:
${dataEntries || '  {}'}`
    }

    if (type === 'secret') {
      // 展示为 stringData（明文）以便直接编辑；回写时由 applyResourceYaml 重新 base64 编码
      const fmtMap = obj => obj && Object.keys(obj).length
        ? Object.entries(obj).map(([k, v]) => `    ${k}: ${scalar(v)}`).join('\n')
        : ''
      const metaExtra = [
        fmtMap(resource.labels) && '  labels:\n' + fmtMap(resource.labels),
        fmtMap(resource.annotations) && '  annotations:\n' + fmtMap(resource.annotations),
      ].filter(Boolean).join('\n')
      const dataEntries = resource.data
        ? Object.entries(resource.data).map(([k, v]) => `  ${k}: ${scalar(decodeBase64(v))}`).join('\n')
        : ''
      return `apiVersion: v1
kind: Secret
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}${metaExtra ? '\n' + metaExtra : ''}
type: ${resource.type || 'Opaque'}
stringData:
${dataEntries || '  {}'}`
    }

    if (type === 'pvc') {
      const ACCESS_MODES = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }
      const accessMode = ACCESS_MODES[resource.accessModes] || resource.accessModes || 'ReadWriteOnce'
      const volumeName = resource.volume ? `\n  volumeName: ${resource.volume}` : ''
      return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  accessModes:
    - ${accessMode}
  resources:
    requests:
      storage: ${resource.capacity || '10Gi'}
  storageClassName: ${resource.storageClass || 'standard'}${volumeName}`
    }

    if (type === 'pv') {
      const ACCESS_MODES = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }
      const accessMode = ACCESS_MODES[resource.accessModes] || resource.accessModes || 'ReadWriteOnce'
      const [claimNs, claimName] = (resource.claim || '').split('/')
      const claimRef = claimName ? `\n  claimRef:\n    name: ${claimName}\n    namespace: ${claimNs || 'default'}` : ''
      return `apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${yamlQ(name)}
spec:
  capacity:
    storage: ${resource.capacity || '10Gi'}
  accessModes:
    - ${accessMode}
  persistentVolumeReclaimPolicy: ${resource.reclaimPolicy || 'Retain'}
  storageClassName: ${resource.storageClass || 'standard'}${claimRef}`
    }

    if (type === 'storageclass') {
      return buildStorageClassYaml(resource)
    }

    if (type === 'deployment') {
      const kind = resource.type || 'Deployment'
      const img = resource.image || 'nginx:latest'
      const desired = resource.replicas?.split('/')[1] || 1
      // Pod 模板（各工作负载共用）
      const podTemplate = `    metadata:
      labels:
        app: ${yamlQ(name)}
    spec:
      containers:
      - name: ${yamlQ(resource.name)}
        image: ${img}
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi`

      // CronJob：batch/v1，schedule + jobTemplate，无 replicas
      if (kind === 'CronJob') {
        const tpl = podTemplate.split('\n').map(l => '    ' + l).join('\n')
        return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  schedule: "${resource.schedule || '*/5 * * * *'}"
  jobTemplate:
    spec:
      template:
${tpl}`
      }

      // Job：batch/v1，completions/parallelism/backoffLimit，无 replicas
      if (kind === 'Job') {
        return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  backoffLimit: 6
  completions: ${resource.completions || 1}
  parallelism: 1
  template:
${podTemplate}`
      }

      // DaemonSet：apps/v1，按节点调度，无 replicas，用 updateStrategy
      if (kind === 'DaemonSet') {
        return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  selector:
    matchLabels:
      app: ${yamlQ(name)}
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
${podTemplate}`
      }

      // Deployment / StatefulSet
      return `apiVersion: apps/v1
kind: ${kind}
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
  labels:
    app: ${yamlQ(name)}
spec:
  replicas: ${desired}
  selector:
    matchLabels:
      app: ${yamlQ(name)}
  template:
${podTemplate}`
    }

    if (type === 'networkpolicy') {
      const peerYaml = f => {
        const t = f.type || 'podSelector'
        if (t === 'ipBlock') return `      - ipBlock:\n          cidr: ${f.cidr || '0.0.0.0/0'}`
        const entries = f.matchLabels ? Object.entries(f.matchLabels) : []
        if (!entries.length) return `      - ${t}: {}`
        return `      - ${t}:
          matchLabels:
${entries.map(([k, v]) => `            ${k}: ${v}`).join('\n')}`
      }
      const ingressRules = resource.ingressRules?.length
        ? resource.ingressRules.map(r => `    - from:\n${(r.from || []).map(peerYaml).join('\n')}`).join('\n')
        : '    []'
      const egressRules = resource.egressRules?.length
        ? resource.egressRules.map(r => `    - to:\n${(r.to || []).map(peerYaml).join('\n')}`).join('\n')
        : '    []'
      return `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  podSelector:
    matchLabels:
${Object.entries(resource.podSelector || {}).map(([k,v]) => `      ${k}: ${v}`).join('\n') || '      {}'}
  policyTypes:
${resource.policyTypes?.map(t => `  - ${t}`).join('\n') || '  - Ingress\n  - Egress'}
  ingress:
${ingressRules}
  egress:
${egressRules}`
    }

    if (type === 'hpa') {
      return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: ${resource.targetKind || 'Deployment'}
    name: ${resource.targetName || name}
  minReplicas: ${resource.minReplicas || 1}
  maxReplicas: ${resource.maxReplicas || 10}
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: ${resource.cpuTarget || 80}
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: ${resource.memoryTarget || 80}`
    }

    if (type === 'resourcequota') {
      const hardPairs = resource.hard ? Object.entries(resource.hard)
        .map(([k, v]) => `    ${k}: ${scalar(v)}`) : []
      const hardBlock = hardPairs.length ? hardPairs.join('\n') : '    {}'
      return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: "${name}"
  namespace: "${ns}"
spec:
  hard:
${hardBlock}`
    }

    if (type === 'limitrange') {
      return `apiVersion: v1
kind: LimitRange
metadata:
  name: "${name}"
  namespace: "${ns}"
spec:
  limits:
  - type: Container
    default:
      cpu: "${resource.defaultCPU || '500m'}"
      memory: "${resource.defaultMemory || '512Mi'}"
    defaultRequest:
      cpu: "${resource.defaultRequestCPU || '250m'}"
      memory: "${resource.defaultRequestMemory || '256Mi'}"
    max:
      cpu: "${resource.maxCPU || '2'}"
      memory: "${resource.maxMemory || '4Gi'}"
    min:
      cpu: "${resource.minCPU || '50m'}"
      memory: "${resource.minMemory || '64Mi'}"`
    }

    if (type === 'role') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: ${resource.scope === 'Cluster' ? 'ClusterRole' : 'Role'}
metadata:
  name: ${yamlQ(name)}
${resource.scope !== 'Cluster' ? `  namespace: ${yamlQ(ns)}` : ''}
rules:
${resource.rules?.map(r => `- apiGroups: [${(r.apiGroups || ['']).map(g => `"${g}"`).join(', ')}]
  resources: [${(r.resources || []).map(r => `"${r}"`).join(', ')}]
  verbs: [${(r.verbs || []).map(v => `"${v}"`).join(', ')}]`).join('\n') || '- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]'}`
    }

    if (type === 'serviceaccount') {
      return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}`
    }

    if (type === 'rolebinding') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
subjects:
${resource.subjects?.map(s => `- kind: ${s.kind || 'User'}
  name: ${s.name}
  ${s.namespace ? `namespace: ${s.namespace}` : ''}`).join('\n') || '- kind: User\n  name: default'}
roleRef:
  kind: ${resource.roleKind || 'Role'}
  name: ${resource.roleName || name}
  apiGroup: rbac.authorization.k8s.io`
    }

    if (type === 'clusterrolebinding') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${yamlQ(name)}
subjects:
${resource.subjects?.map(s => `- kind: ${s.kind || 'User'}
  name: ${s.name}${s.namespace ? `\n  namespace: ${s.namespace}` : ''}`).join('\n') || '- kind: User\n  name: default'}
roleRef:
  kind: ${resource.roleKind || 'ClusterRole'}
  name: ${resource.roleName || name}
  apiGroup: rbac.authorization.k8s.io`
    }

    if (type === 'ingressclass') {
      const def = resource.isDefault ? '\n  annotations:\n    ingressclass.kubernetes.io/is-default-class: "true"' : ''
      return `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: ${yamlQ(name)}${def}
spec:
  controller: ${resource.controller || 'k8s.io/ingress-nginx'}`
    }

    if (type === 'runtimeclass') {
      return `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: ${yamlQ(name)}
spec:
  handler: ${resource.handler || 'runc'}`
    }

    if (type === 'endpoints') {
      const addresses = resource.addresses || []
      const notReady = resource.notReadyAddresses || []
      const ports = resource.ports || []
      const addrYaml = addresses.length ? '\n' + addresses.map(a => `  - ip: ${a}`).join('\n') : ' []'
      const notReadyYaml = notReady.length ? `\n  notReadyAddresses:\n${notReady.map(a => `  - ip: ${a}`).join('\n')}` : ''
      // 端口 name 无损回写(NsEndpoints 的 YAML 编辑器内容即本函数产出,丢 name 会破坏
      // 已有多端口 Endpoints 的编辑保存;匿名端口保持匿名,不擅自补名——须与 Service 端口名对应)
      const portsYaml = ports.length ? '\n' + ports.map(p => `  - port: ${p.port}` + (p.name ? `\n    name: ${p.name}` : '') + `\n    protocol: ${p.protocol || 'TCP'}`).join('\n') : ' []'
      return `apiVersion: v1
kind: Endpoints
metadata:
  name: ${yamlQ(name)}
  namespace: ${yamlQ(ns)}
subsets:
- addresses:${addrYaml}${notReadyYaml}
  ports:${portsYaml}`
    }

    if (type === 'node') {
      return `apiVersion: v1
kind: Node
metadata:
  name: ${yamlQ(name)}
  labels:
    kubernetes.io/role: ${resource.roles || 'worker'}
    kubernetes.io/os: linux
    kubernetes.io/arch: amd64
spec:
  ${resource.unschedulable ? 'unschedulable: true' : 'unschedulable: false'}
status:
  conditions:
${Object.entries(resource.conditions || {}).map(([k, v]) => `  - type: ${k}\n    status: "${v}"`).join('\n')}`
    }

    return `# YAML for ${type}/${yamlQ(name)}`
  }

  // 单独的 YAML 生成（PDB / PriorityClass），避免破坏上面的逻辑
  function generateExtraYAML(type, resource) {
    if (!resource) return ''
    if (type === 'pdb') {
      const sel = resource.selector ? Object.entries(resource.selector).map(([k, v]) => `      ${k}: ${v}`).join('\n') : '      {}'
      return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: "${resource.name}"
  namespace: "${resource.namespace}"
spec:
  ${resource.minAvailable ? `minAvailable: ${resource.minAvailable}` : `maxUnavailable: ${resource.maxUnavailable}`}
  selector:
    matchLabels:
${sel}`
    }
    if (type === 'priorityclass') {
      return `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: ${yamlQ(resource.name)}
value: ${resource.value}
globalDefault: ${resource.globalDefault}
description: "${resource.description || ''}"`
    }
    return ''
  }

  // === 通用 YAML 应用（kubectl edit / apply 语义）===
  // 解析编辑后的 YAML → 按 kind 转换为扁平字段 → 调用对应 updateXxx。
  // 这样所有资源都具备与真实 K8s 一致的「编辑 YAML 即生效」能力。
  const ACCESS_MODE_TO_CODE = { ReadWriteOnce: 'RWO', ReadWriteMany: 'RWM', ReadOnlyMany: 'ROM', ReadWriteOncePod: 'RWOP' }
  const CODE_TO_ACCESS_MODE = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }

  // canonical NetworkPolicy peer → 前端 peer 结构
  const toPeer = (p) => {
    if (p.podSelector) return { type: 'podSelector', matchLabels: p.podSelector.matchLabels || {} }
    if (p.namespaceSelector) return { type: 'namespaceSelector', matchLabels: p.namespaceSelector.matchLabels || {} }
    if (p.ipBlock) return { type: 'ipBlock', cidr: p.ipBlock.cidr }
    return { type: 'podSelector', matchLabels: {} }
  }

  // 自定义资源（CR）的 YAML 生成：CRD 的 group/version/kind + 实例元数据；
  // spec 用按 kind 的模板填充（实例本身只存 name/namespace/status/age）。
  const CR_SPEC_TEMPLATES = {
    Certificate: inst => `  secretName: ${inst.name}-tls\n  issuerRef:\n    name: letsencrypt-prod\n    kind: Issuer\n  dnsNames:\n  - ${inst.name}.kubezen.io`,
    Issuer: () => '  acme:\n    server: https://acme-v02.api.letsencrypt.org/directory\n    email: admin@kubezen.io\n    privateKeySecretRef:\n      name: letsencrypt-prod',
    ClusterIssuer: () => '  acme:\n    server: https://acme-v02.api.letsencrypt.org/directory\n    email: admin@kubezen.io',
    AlertmanagerConfig: () => '  route:\n    receiver: default\n    group_by: ["alertname"]\n  receivers:\n  - name: default',
  }
  function generateCRYaml(crd, inst) {
    if (!crd || !inst) return ''
    const meta = crd.namespaced && inst.namespace
      ? `metadata:\n  name: ${inst.name}\n  namespace: ${inst.namespace}`
      : `metadata:\n  name: ${inst.name}`
    const specBody = CR_SPEC_TEMPLATES[crd.kind] ? CR_SPEC_TEMPLATES[crd.kind](inst) : '  {}'
    return `apiVersion: ${crd.group}/${crd.version}
kind: ${crd.kind}
${meta}
spec:
${specBody}
status:
  phase: ${inst.status || 'Ready'}`
  }

  // 某个 CR 实例在 API 上的路径（cluster-scoped vs namespaced 两种形态）
  function crInstancePath(crd, inst) {
    if (!crd) return ''
    const plural = crd.name?.split('.')[0]
    const gv = `/apis/${crd.group}/${crd.version}`
    return crd.namespaced
      ? `${gv}/namespaces/${encodeURIComponent(inst?.namespace || 'default')}/${plural}/${encodeURIComponent(inst?.name)}`
      : `${gv}/${plural}/${encodeURIComponent(inst?.name)}`
  }

  // 重新拉取某个 CRD 的全部实例（CR 增删改后刷新局部，不必全量 hydrate）
  async function refreshCRDInstances(crdName) {
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'crds' && q.queryKey[3] === crdName && q.queryKey[4] === 'instances' })
  }

  // 通用 CR apply（server-side apply，适用于任意 CRD kind）+ 局部刷新
  async function applyCRYaml(crdName, yamlStr) {
    try {
      let object = null
      yamlLoadAll(yamlStr, d => { if (!object && d) object = d })
      const result = await api.applyYaml(yamlStr)
      const resource = result?.resources?.[0]
      await refreshCRDInstances(crdName)
      return { ok: true, kind: resource?.kind || object?.kind, name: resource?.metadata?.name || object?.metadata?.name }
    } catch (error) {
      return { ok: false, error: error.message || i18n.global.t('store.applyYamlFailed') }
    }
  }

  // 删除某个 CR 实例 + 局部刷新
  async function deleteCRInstance(crd, inst) {
    await api.k8s(crInstancePath(crd, inst), { method: 'DELETE' })
    await refreshCRDInstances(crd.name)
  }

  // can-i 服务端真值：SelfSubjectAccessReview。
  // 注意 SSAR 只判定「当前登录用户」（subjectName 无关）；任意 subject 的本地推演仍用 checkAccess。
  const RESOURCE_TO_GROUP = {
    pods: '', services: '', configmaps: '', secrets: '', serviceaccounts: '',
    persistentvolumeclaims: '', persistentvolumes: '', nodes: '', namespaces: '',
    endpoints: '', events: '',
    deployments: 'apps', statefulsets: 'apps', daemonsets: 'apps', replicasets: 'apps',
    ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io',
    roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
    clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io',
    jobs: 'batch', cronjobs: 'batch',
  }
  async function checkAccessServer({ verb, resource, namespace }) {
    // pods/log → resource=pods + subresource=log
    let name = String(resource || ''), subresource = ''
    if (name.includes('/')) { const [n, s] = name.split('/'); name = n; subresource = s }
    const group = RESOURCE_TO_GROUP[name] ?? ''
    const attrs = { verb: String(verb || 'get'), resource: name, group }
    if (namespace) attrs.namespace = namespace
    if (subresource) attrs.subresource = subresource
    const body = {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: attrs },
    }
    try {
      const r = await api.k8s('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', { method: 'POST', body: JSON.stringify(body) })
      return {
        ok: true,
        allowed: !!r?.status?.allowed,
        denied: !r?.status?.allowed,
        reason: r?.status?.reason || '',
        evaluationError: r?.status?.evaluationError || '',
      }
    } catch (e) {
      return { ok: false, error: e.message || i18n.global.t('store.ssarFailed') }
    }
  }

  async function applyResourceYaml(yamlStr) {
    try {
      let object = null
      yamlLoadAll(yamlStr, document => { if (!object && document) object = document })
      const result = await api.applyYaml(yamlStr) // { resources, applied, failed, total }
      queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' })
      const resource = result?.resources?.[0]
      const failed = result?.failed || []
      // applied 缺省(旧后端只回 resources)时回退用 resources 计数,避免新版前端+旧后端误报失败
      const appliedCount = result?.applied?.length ?? result?.resources?.length ?? 0
      // 全失败(http 422 已抛错,理论不至此,防御):报失败
      if (!appliedCount) {
        return { ok: false, error: failed[0]?.error || i18n.global.t('store.applyYamlFailed') }
      }
      const out = {
        ok: true,
        kind: resource?.kind || object?.kind,
        name: resource?.metadata?.name || object?.metadata?.name,
        namespace: resource?.metadata?.namespace || object?.metadata?.namespace || '',
      }
      // 部分成功:主资源已落,但有资源失败 —— 不阻断成功,以 warning 上报(QA ISSUE-002:旧实现整体报失败且残留资源)
      if (failed.length) {
        out.partial = true
        out.applied = result.applied
        out.failed = failed
        out.warning = failed.map(f => `${f.kind}/${f.name}: ${f.error}`).join('; ')
      }
      return out
    } catch (error) {
      return { ok: false, error: error.message || i18n.global.t('store.applyYamlFailed') }
    }
  }

  // === 端口转发（kubectl port-forward 语义）===
  const portForwards = ref([])
  async function addPortForward({ kind, name, namespace, port, localPort }) {
    const fwd = await portForwardApi.create({ kind, name, namespace, port, localPort })
    const pf = { id: fwd.id, kind, name, namespace, port, pod: fwd.pod, targetPort: fwd.targetPort, localPort: fwd.localPort, host: fwd.host, status: 'Forwarding' }
    portForwards.value.push(pf)
    return pf
  }
  async function removePortForward(id) {
    try { await portForwardApi.remove(id) } catch { /* 已停止或会话过期 */ }
    const idx = portForwards.value.findIndex(p => p.id === id)
    if (idx !== -1) portForwards.value.splice(idx, 1)
  }
  async function refreshPortForwards() {
    try {
      const { forwards } = await portForwardApi.list()
      portForwards.value = forwards.map(f => ({
        id: f.id, kind: f.kind, name: f.name, namespace: f.namespace,
        port: f.targetPort, pod: f.pod, targetPort: f.targetPort, localPort: f.localPort, host: f.host, status: 'Forwarding',
      }))
    } catch { /* 忽略 */ }
  }

  // === RBAC 权限模拟（kubectl auth can-i 语义）===
  // 根据 subject 匹配的 RoleBinding/ClusterRoleBinding → Role/ClusterRole 的 rules，
  // 判断该 subject 能否对指定 resource 执行指定 verb。纯前端基于本地缓存数据推演。
  const RESOURCE_TO_APIGROUP = {
    pods: '', services: '', configmaps: '', secrets: '', endpoints: '', namespaces: '', nodes: '',
    persistentvolumeclaims: '', persistentvolumes: '',
    deployments: 'apps', statefulsets: 'apps', daemonsets: 'apps', replicasets: 'apps',
    ingresses: 'networking.k8s.io', networkpolicies: 'networking.k8s.io',
    roles: 'rbac.authorization.k8s.io', rolebindings: 'rbac.authorization.k8s.io',
    clusterroles: 'rbac.authorization.k8s.io', clusterrolebindings: 'rbac.authorization.k8s.io',
    jobs: 'batch', cronjobs: 'batch', horizontalpodautoscalers: 'autoscaling',
    serviceaccounts: '', persistentvolumeclaims2: '',
  }
  function checkAccess({ subjectKind, subjectName, verb, resource, namespace }) {
    const group = RESOURCE_TO_APIGROUP[resource] ?? ''
    // P2-B:读 Vue Query 缓存(RbacCanI 挂载即预热;旧读孤儿三表恒空 → 模拟器永远拒绝)。
    const _cid = currentCluster.value || 'cluster'
    const roles = queryClient.getQueryData(['cluster', _cid, 'roles']) || []
    const rb = queryClient.getQueryData(['cluster', _cid, 'rolebindings']) || []
    const crb = queryClient.getQueryData(['cluster', _cid, 'clusterrolebindings']) || []
    // 命名空间级 RoleBinding 仅在所属 ns 生效；ClusterRoleBinding 全局生效
    const bindings = [
      ...rb.filter(b => !namespace || b.namespace === namespace).map(b => ({ ...b, bindingKind: 'RoleBinding' })),
      ...crb.map(b => ({ ...b, bindingKind: 'ClusterRoleBinding' })),
    ]
    for (const b of bindings) {
      const subs = b.subjects || []
      // 精确匹配 subject 名称（subjectName 为空表示通配查询）；类型一致或未指定
      const hit = subs.some(s => {
        if (subjectName && s.name !== subjectName) return false
        if (subjectKind && s.kind && s.kind !== subjectKind) return false
        return true
      })
      if (!hit) continue
      const wantCluster = (b.roleKind || 'Role') === 'ClusterRole' || b.bindingKind === 'ClusterRoleBinding'
      const role = roles.find(r => r.name === b.roleName && (wantCluster ? r.scope === 'Cluster' : r.scope !== 'Cluster' && (!b.namespace || r.namespace === b.namespace)))
      if (!role) continue
      for (const rule of (role.rules || [])) {
        const groups = rule.apiGroups || ['']
        const resources = rule.resources || []
        const verbs = rule.verbs || []
        const groupOk = groups.includes('*') || groups.includes(group)
        const resOk = resources.includes('*') || resources.includes(resource)
        const verbOk = verbs.includes('*') || verbs.includes(verb)
        if (groupOk && resOk && verbOk) {
          return {
            allowed: true,
            matchedBy: `${b.bindingKind} "${b.name}" → ${role.scope === 'Cluster' ? 'ClusterRole' : 'Role'} "${role.name}"`,
            rule,
          }
        }
      }
    }
    return { allowed: false, matchedBy: null, rule: null }
  }

  return {
    // 基础数据
    cluster, nodeList, namespaceList, currentNamespace,
    clusterList, savedClusters, currentCluster, connectionState,
    // 全局计算
    healthyNodes, totalNodes, clusterHealth, apiReachable,
    // Actions
    setNamespace, fetchWorkload,
    findResourceReferences,
    // CRUD: Services
    addService, updateService, deleteService,
    // CRUD: Ingress
    addIngress, updateIngress, updateIngressRules, deleteIngress,
    // CRUD: ConfigMaps
    addConfigMap, updateConfigMap, deleteConfigMap,
    // CRUD: Secrets
    addSecret, updateSecret, deleteSecret,
    decodeBase64,
    // CRUD: PVCs
    addPVC, updatePVC, deletePVC,
    // CRUD: PersistentVolumes / StorageClasses（集群级）
    addPV, updatePV, deletePV, addStorageClass, updateStorageClass, deleteStorageClass,
    // CRUD: Endpoints
    // CRUD: IngressClass / RuntimeClass（集群级）
    addIngressClass, updateIngressClass, deleteIngressClass, addRuntimeClass, updateRuntimeClass, deleteRuntimeClass,
    // CRUD: Workloads
    deleteWorkload, updateWorkload, applyWorkloadTemplate, updateWorkloadMeta, scaleWorkload, restartWorkload, rollbackWorkload, reassignLayer,
    // CRUD: Pods
    deletePod, invalidateResource,
    // CRUD: NetworkPolicies
    addNetworkPolicy, updateNetworkPolicy, deleteNetworkPolicy,
    // CRUD: HPAs
    addHPA, updateHPA, deleteHPA,
    // CRUD: ResourceQuotas
    addResourceQuota, updateResourceQuota, deleteResourceQuota,
    // CRUD: LimitRanges
    addLimitRange, updateLimitRange, deleteLimitRange,
    // CRUD: RBAC
    addRole, updateRole, deleteRole, addServiceAccount, updateServiceAccount, deleteServiceAccount,
    addRoleBinding, updateRoleBinding, deleteRoleBinding,
    // CRUD: ClusterRoleBindings
    addClusterRoleBinding, updateClusterRoleBinding, deleteClusterRoleBinding,
    // CRUD: PDB
    addPDB, updatePDB, deletePDB,
    // CRUD: PriorityClass
    addPriorityClass, updatePriorityClass, deletePriorityClass,
    // CRUD: Nodes
    cordonNode, uncordonNode, drainNode,
    // CRUD: Namespaces
    addNamespace, deleteNamespace,
    // 多集群
    switchCluster, getCurrentCluster, setConnectedCluster, removeSavedClusterStore,
    hydrateCriticalResources,
    invalidateAllClusterQueries,
    // Pod 列表轻量刷新（删 Pod 后看重建）
    fetchNodes,
    fetchServices, fetchConfigMaps, fetchSecrets, fetchIngresses, fetchNetworkPolicies,
    fetchConfigMap,
    fetchSecret,
    fetchService,
    fetchIngress,
    fetchNetworkPolicy, fetchPVC,
    fetchPVs, fetchStorageClasses, fetchPV, fetchStorageClass,
    fetchHPA, fetchResourceQuota, fetchLimitRange, fetchPDB,
    fetchNode,
    fetchPDBs, fetchLimitRanges, fetchResourceQuotas, fetchHPAs, fetchEndpoints, fetchWorkloads, fetchPVCs, fetchRuntimeClasses, fetchIngressClasses, fetchPriorityClasses, fetchPriorityClass,
    fetchRoles, fetchRoleBindings, fetchClusterRoleBindings, fetchServiceAccounts,
    fetchRole, fetchRoleBinding, fetchServiceAccount, fetchClusterRole, fetchClusterRoleBinding,
    fetchCRDs, fetchCRD, fetchCRInstances,
    fetchNamespaces, fetchNamespace,
    fetchPods, fetchPod, fetchEvents,
    refreshMetrics,
    // 全局指标采样(引用计数 + localStorage 持久化)
    cpuSamples, memSamples, metricsSampling, metricsLastRefresh,
    startMetricsSampling, stopMetricsSampling, sampleNow,
    // Pod Watch（实时监听）
    podWatchLive, startPodWatch, stopPodWatch,
    eventWatchLive, startEventWatch, stopEventWatch,
    // CRD
    crInstancePath, refreshCRDInstances, applyCRYaml, deleteCRInstance,
    // 审计
    // YAML generation
    generateYAML, generateExtraYAML, generateCRYaml, applyResourceYaml,
    // 端口转发
    portForwards, addPortForward, removePortForward, refreshPortForwards,
    // RBAC 权限模拟
    checkAccess, checkAccessServer,
  }
})
