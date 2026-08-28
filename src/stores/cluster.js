import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { load as yamlLoad, loadAll as yamlLoadAll } from 'js-yaml'
import { api, k8sStream, k8sChannel, portForwardApi, getSavedClusters, addSavedCluster, removeSavedCluster, setActiveToken, activeApiServer, getSessionToken } from '@/api/client'
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
import { fetchNodes, fetchNode, fetchServices, fetchService, fetchConfigMaps, fetchConfigMap, fetchSecrets, fetchSecret, fetchIngresses, fetchIngress, fetchNetworkPolicies, fetchNetworkPolicy, fetchPDBs, fetchPDB, fetchLimitRanges, fetchLimitRange, fetchResourceQuotas, fetchResourceQuota, fetchHPAs, fetchHPA, fetchEndpoints, fetchWorkloads, fetchPVCs, fetchPVs, fetchPV, fetchStorageClasses, fetchStorageClass, fetchPVC, fetchRoles, fetchRoleBindings, fetchClusterRoleBindings, fetchServiceAccounts, fetchRole, fetchRoleBinding, fetchServiceAccount, fetchClusterRole, fetchClusterRoleBinding, fetchRuntimeClasses, fetchRuntimeClass, fetchIngressClasses, fetchIngressClass, fetchPriorityClasses, fetchPriorityClass, fetchNamespaces, fetchNamespace, fetchWorkloadRevisions } from '@/composables/useFetchers'
import { applyWatchEvent } from '@/composables/useK8sQuery'
import { createWatchController } from '@/composables/useClusterWatch'
import { createYamlDomain } from './cluster/yaml'
import { createCrudDomain } from './cluster/crud'
export { hpaPatchFn } from './cluster/crud'
import { invalidateResource, invalidateAllClusterQueries } from './cluster/invalidate'
import { recordListRv, getListRv, clearWatchRegistry } from '@/composables/watchRegistry'
import { deriveClusterCounts } from '@/logic/clusterCounts'
import { pushSample, restoreSamples, persistPayload } from '@/logic/metricsWindow'

import { i18n } from '@/i18n'

export { formatCpu, formatMem } from '@/composables/useResourceFormat'

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
  // Pod/Event Watch 兼容布尔（旧消费方 NsPods/NsEvents/AuditLogs/MonitoringCenter 读）；
  // 真值现由 watchStates 驱动（见下方 Workload 族 Watch 区块）
  const podWatchLive = ref(false)
  const eventWatchLive = ref(false)

  // === 当前选中的 Namespace（持久化：刷新不丢，与集群选择同模式）===
  const currentNamespace = ref(localStorage.getItem('aliangboard.namespace') || '')

  const healthyNodes = computed(() => nodeList.value.filter(n => n.status === 'Ready').length)
  const totalNodes = computed(() => nodeList.value.length)
  const apiReachable = ref(true)
  const clusterHealth = computed(() => computeClusterHealth({
    nodeList: nodeList.value, apiReachable: apiReachable.value,
  }))



  // === YAML 域(Plan 5 拆分到 ./cluster/yaml.js):工厂注入 currentNamespace getter ===
  const { generateYAML, generateExtraYAML, generateCRYaml, crInstancePath, refreshCRDInstances, applyCRYaml, deleteCRInstance, checkAccessServer, applyResourceYaml } = createYamlDomain({ getCurrentNamespace: () => currentNamespace.value })
  // === CRUD 域(Plan 5 拆分到 ./cluster/crud.js):工厂注入 store 作用域依赖 ===
  const { remoteDelete, remoteCreate, refetch, remoteUpdate, remotePatch, remoteDeletePath,
    addConfigMap, updateConfigMap, deleteConfigMap, addSecret, updateSecret, deleteSecret,
    addPVC, updatePVC, deletePVC, addService, updateService, deleteService,
    addNetworkPolicy, updateNetworkPolicy, deleteNetworkPolicy, addHPA, updateHPA, deleteHPA,
    addResourceQuota, updateResourceQuota, deleteResourceQuota, addLimitRange, updateLimitRange, deleteLimitRange,
    addServiceAccount, updateServiceAccount, deleteServiceAccount, addRoleBinding, updateRoleBinding, deleteRoleBinding,
    addPDB, updatePDB, deletePDB, addIngress, updateIngress, deleteIngress,
    addIngressClass, updateIngressClass, deleteIngressClass, addRuntimeClass, updateRuntimeClass, deleteRuntimeClass,
    addPriorityClass, updatePriorityClass, deletePriorityClass, addClusterRoleBinding, updateClusterRoleBinding, deleteClusterRoleBinding,
    updateIngressRules, addPV, updatePV, deletePV, addStorageClass, updateStorageClass, deleteStorageClass,
    deleteWorkload, getWorkloadForEdit, updateWorkload } = createCrudDomain({ aliangTag, currentCluster, namespaceList, fetchWorkload, generateYAML, generateExtraYAML })
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
  // 缓存里已有同名条目时跳过：避免单体 upsert 覆盖批量列表条目（历史 attachRolloutHistory 时代防 revisions 丢失;现仅防字段面回退）。
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
  // 改源:revisions 不再读列表缓存对象(fetchWorkloads 已瘦身),按需 fetchWorkloadRevisions,
  // target._template 携带完整模板,兜底走镜像 PATCH。
  async function rollbackWorkload(name, ns, revNumber) {
    const wl = await getWorkloadForEdit(name, ns)
    if (!wl) { invalidateResource('workloads'); throw new Error(i18n.global.t('store.workloadNotFound')) }
    const revs = await fetchWorkloadRevisions(wl.type, name, ns)
    const target = (revs || []).find(r => r.rev === revNumber)
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
    queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'revisions' })
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

  // === Workload 族 Watch：多路复用单通道(网关 /api/k8s-watch)增量写 Vue Query canonical key ===
  // spec §5.3:deployments/statefulsets/daemonsets 三流 merge 进同一 'workloads' key;
  // 断线由 createWatchController 退避重连/410 relist/降级轮询接管。
  // 下面的 controllerFor 直连流仅供旧手动开关(startPodWatch 等)使用,family 主路走 familyChannel。
  const WATCH_CONFIGS = [
    { key: 'pods', queryKey: 'pods', watchPath: '/api/v1/pods', mapFn: mapPod },
    { key: 'events', queryKey: 'events', watchPath: '/api/v1/events', mapFn: mapEvent },
    { key: 'deployments', queryKey: 'workloads', watchPath: '/apis/apps/v1/deployments', mapFn: i => mapWorkload(i, 'Deployment') },
    { key: 'statefulsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/statefulsets', mapFn: i => mapWorkload(i, 'StatefulSet') },
    { key: 'daemonsets', queryKey: 'workloads', watchPath: '/apis/apps/v1/daemonsets', mapFn: i => mapWorkload(i, 'DaemonSet') },
    { key: 'services', queryKey: 'services', watchPath: '/api/v1/services', mapFn: mapService },
    { key: 'ingresses', queryKey: 'ingresses', watchPath: '/apis/networking.k8s.io/v1/ingresses', mapFn: mapIngress },
  ]
  const watchStates = reactive(Object.fromEntries(WATCH_CONFIGS.map(c => [c.key, 'off'])))
  const watchControllers = new Map()

  function relistQueryKey(queryKey) {
    return queryClient.refetchQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === queryKey })
  }

  function controllerFor(cfg) {
    if (watchControllers.has(cfg.key)) return watchControllers.get(cfg.key)
    const ctl = createWatchController({
      connect: ({ onOpen, onError, onClose }) => {
        const rv = getListRv(cfg.watchPath)
        return k8sStream(`${cfg.watchPath}?watch=true${rv ? `&resourceVersion=${encodeURIComponent(rv)}` : ''}`, {
          onOpen,
          onClose,
          onError,
          onMessage: line => {
            try {
              const evt = JSON.parse(line)
              if (evt.object?.metadata?.resourceVersion) recordListRv(cfg.watchPath, evt.object.metadata.resourceVersion)
              const _cid = currentCluster.value || 'cluster'
              queryClient.setQueryData(['cluster', _cid, cfg.queryKey], old => applyWatchEvent(old || [], evt.type, cfg.mapFn(evt.object)))
            } catch { /* 忽略非 JSON 心跳行 */ }
          },
        })
      },
      relist: () => relistQueryKey(cfg.queryKey),
      onState: s => {
        watchStates[cfg.key] = s
        if (cfg.key === 'pods') podWatchLive.value = s === 'live'
        if (cfg.key === 'events') eventWatchLive.value = s === 'live'
      },
    })
    watchControllers.set(cfg.key, ctl)
    return ctl
  }

  // === 多路复用单通道:7 watch 归 1 连接(根治浏览器 HTTP/1.1 同源 6 连接上限饿死) ===
  // 网关 /api/k8s-watch 聚合 7 路上游为单条 NDJSON;每行 {r,t,o} 或 {r,err}。
  // 任一路 {r,err}(含 RV 失效 410)时网关整条关闭 → 这里 relist 该资源拿新 RV 再重连。
  let familyChannelHandle = null
  let familyChannelEnded = false   // err 行已触发 abort 后防重复处理
  let familyChannelNotify = null   // connect 注入的 { onError, onClose },err 行 abort 后显式通知控制器

  function handleChannelLine(line) {
    if (familyChannelEnded) return
    let evt
    try { evt = JSON.parse(line) } catch { return /* 心跳/非 JSON 行 */ }
    if (!evt || !evt.r) return
    const cfg = WATCH_CONFIGS.find(c => c.key === evt.r)
    if (evt.err) {
      // 上游失败(含 410 RV 失效):relist 该资源拿新 RV,再关掉通道交给控制器重连。
      // 注意:k8sChannel 的 abort 是静默的(不会回调 onClose),控制器必须被显式通知,
      // 否则 err 行后永不重连。410 走 onError({status:410}) 的不计失败 relist 路径
      // (RV 过期是正常生命周期,计失败会在 churn 下误降级);其余 err 走 onClose 计失败退避。
      if (!cfg) return
      familyChannelEnded = true
      relistQueryKey(cfg.queryKey)          // fire-and-forget:refetch 刷新注册表 RV,重连即可续接
      familyChannelHandle?.abort()
      if (evt.err === 410) familyChannelNotify?.onError?.({ status: 410 })
      else familyChannelNotify?.onClose?.()
      return
    }
    if (!cfg || !evt.t) return
    recordListRv(cfg.watchPath, evt.o?.metadata?.resourceVersion)
    const _cid = currentCluster.value || 'cluster'
    queryClient.setQueryData(['cluster', _cid, cfg.queryKey], old => applyWatchEvent(old || [], evt.t, cfg.mapFn(evt.o)))
  }

  const familyChannel = createWatchController({
    connect: ({ onOpen, onError, onClose }) => {
      familyChannelEnded = false
      familyChannelNotify = { onError, onClose }
      const rvParams = WATCH_CONFIGS
        .map(c => { const rv = getListRv(c.watchPath); return rv ? `&rv_${c.key}=${encodeURIComponent(rv)}` : '' })
        .join('')
      familyChannelHandle = k8sChannel(`/api/k8s-watch?resources=${WATCH_CONFIGS.map(c => c.key).join(',')}${rvParams}`, {
        onOpen,
        onError,
        onClose,
        onMessage: handleChannelLine,
      })
      return familyChannelHandle
    },
    // HTTP 410(整条通道层)→ 全家族 relist
    relist: () => Promise.all([...new Set(WATCH_CONFIGS.map(c => c.queryKey))].map(relistQueryKey)),
    // mux 下 7 资源同生共死:状态联动写全 7 key + pods/events live refs
    onState: s => {
      for (const cfg of WATCH_CONFIGS) {
        watchStates[cfg.key] = s
        if (cfg.key === 'pods') podWatchLive.value = s === 'live'
        if (cfg.key === 'events') eventWatchLive.value = s === 'live'
      }
    },
  })

  // 多路 watch 总开关(默认开):watchFamily 现走多路复用单连接(网关 /api/k8s-watch),
  // 浏览器只占 1 条常驻连接,无 6 连接上限风险。'0' 为 kill-switch:强制回落轮询世界(60s 兜底)。
  function watchFamilyEnabled() {
    try { return localStorage.getItem('aliangboard.watchFamily') !== '0' } catch { return true }
  }
  function startWorkloadFamilyWatch() {
    if (!watchFamilyEnabled()) return
    familyChannel.start()
  }
  function stopWorkloadFamilyWatch() {
    familyChannel.stop()
    familyChannelHandle = null
    for (const ctl of watchControllers.values()) ctl.stop()
    clearWatchRegistry()
  }
  // canonical queryKey 聚合态:全 live 才 live;任一 degraded 即 degraded
  function watchStateOf(queryKey) {
    const ss = WATCH_CONFIGS.filter(c => c.queryKey === queryKey).map(c => watchStates[c.key])
    if (!ss.length || ss.every(s => s === 'off')) return 'off'
    if (ss.some(s => s === 'degraded')) return 'degraded'
    if (ss.some(s => s === 'reconnecting')) return 'reconnecting'
    if (ss.every(s => s === 'live')) return 'live'
    return 'off'
  }
  // 旧入口兼容(NsPods toggleLive / NsEvents / AuditLogs / MonitoringCenter 既存调用点)
  // 注意:family 通道已携带这些资源的事件,这些手动开关只控制「额外」的单资源直连流。
  function startPodWatch() { controllerFor(WATCH_CONFIGS[0]).start() }
  function stopPodWatch() { controllerFor(WATCH_CONFIGS[0]).stop() }
  function startEventWatch() { controllerFor(WATCH_CONFIGS[1]).start() }
  function stopEventWatch() { controllerFor(WATCH_CONFIGS[1]).stop() }
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
      try { stopWorkloadFamilyWatch() } catch { /* 未启动时忽略 */ }
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
      startWorkloadFamilyWatch()
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
    // 先停旧 watch:换集群不灭旧流会留 7 条僵尸连接(与 switchCluster 对称)
    try { stopWorkloadFamilyWatch() } catch { /* noop */ }
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
    startWorkloadFamilyWatch()
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
    recordListRv('/api/v1/pods', podData?.metadata?.resourceVersion)
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
  async function fetchEvents() { const d = await api.k8s('/api/v1/events?limit=1000'); recordListRv('/api/v1/events', d?.metadata?.resourceVersion); return ((d?.items || []).map(mapEvent)).sort((a, b) => (b._ts || 0) - (a._ts || 0)) }

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
    fetchPDBs, fetchLimitRanges, fetchResourceQuotas, fetchHPAs, fetchEndpoints, fetchWorkloads, fetchWorkloadRevisions, fetchPVCs, fetchRuntimeClasses, fetchIngressClasses, fetchPriorityClasses, fetchPriorityClass,
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
    watchStates, watchStateOf, startWorkloadFamilyWatch, stopWorkloadFamilyWatch,
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
