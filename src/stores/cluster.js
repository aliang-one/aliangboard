import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { load as yamlLoad, loadAll as yamlLoadAll } from 'js-yaml'
import { api, k8sStream, portForwardApi, getSavedClusters, addSavedCluster, removeSavedCluster, setActiveToken, activeApiServer, getSessionToken } from '@/api/client'
import { notify } from '@/composables/useToast'
import { yamlScalar } from '@/composables/useYaml'
import { classifyResource, LAYER_TAXONOMY } from '@/composables/useLayering'
import { extractContainerPorts, extractContainerPortsGrouped } from '@/composables/usePorts'
import { computeClusterHealth } from '@/composables/useClusterHealth'
import { buildIngressRulesPatch } from '@/composables/useIngressRules'
import { extractNodeExtra } from '@/composables/useNodeFields'
import { buildPVPatch, buildStorageClassPatch } from '@/composables/useStoragePatch'
import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'
import { queryClient } from '@/queryClient'
import { i18n } from '@/i18n'
import {
  clusterInfo, nodes, workloads, pods, namespaces, events,
  services, ingresses, endpoints, configMaps, secrets, persistentVolumes,
  pvcs, storageClasses, ingressClasses, runtimeClasses, roles, serviceAccounts, podLogs,
  networkPolicies, hpas, resourceQuotas, limitRanges, roleBindings,
  clusters, auditLogs, customResourceDefinitions, clusterRoleBindings,
  podDisruptionBudgets, priorityClasses
} from '@/mock/cluster'

export { formatCpu, formatMem } from '@/composables/useResourceFormat'

// 失效某资源的所有 cluster query（跨 cid，匹配 key[2]），让读 query 的列表/详情页在 CRUD 后自动刷新。
// key[2] = 资源名（如 'configmaps'）；详情页 key ['cluster',cid,'configmaps',name] 也被匹配。
function invalidateResource(resource) {
  queryClient.invalidateQueries({
    predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === resource,
  })
}

export const useClusterStore = defineStore('cluster', () => {
  // === Base64（Secret data 编解码，UTF-8 安全）===
  // K8s 的 Secret.data 一律 base64 编码；mock 里以明文（stringData）书写，
  // 这里在存储层统一编码、展示层（详情页 reveal / 编辑）再解码，
  // 保持与真实 K8s 语义一致。
  function encodeBase64(str) {
    try { return btoa(unescape(encodeURIComponent(String(str ?? '')))) }
    catch { return String(str ?? '') }
  }
  function decodeBase64(str) {
    try { return decodeURIComponent(escape(atob(String(str ?? '')))) }
    catch { return String(str ?? '') }
  }
  const encodeSecretData = (data) => {
    if (!data) return {}
    const out = {}
    for (const k in data) out[k] = encodeBase64(data[k])
    return out
  }

  // === 基础数据 ===
  const cluster = ref(clusterInfo)
  const nodeList = ref(nodes)
  const workloadList = ref(workloads)
  // 为每个工作负载播种「滚动发布历史」（revision history），支持一键回滚（kubectl rollout undo 语义）
  function bumpImageTag(img, delta) {
    const m = String(img || '').match(/^(.*:v?)(\d+)\.(\d+)\.(\d+)$/)
    if (!m) return img
    const patch = Math.max(0, Number(m[4]) + delta)
    return `${m[1]}${m[2]}.${m[3]}.${patch}`
  }
  const randSha = () => 'sha:' + Math.random().toString(16).substring(2, 9)
  workloadList.value.forEach(wl => {
    if (wl.revisions && wl.revisions.length) return
    wl.revisions = [
      { rev: 3, image: wl.image, sha: wl.sha || randSha(), age: wl.age || 'Just now', current: true, reason: i18n.global.t('store.initialDeployment') },
      { rev: 2, image: bumpImageTag(wl.image, -1), sha: randSha(), age: '2h ago', reason: i18n.global.t('store.imageUpdate') },
      { rev: 1, image: bumpImageTag(wl.image, -2), sha: randSha(), age: '1d ago', reason: i18n.global.t('store.imageUpdate') },
    ]
  })
  const podList = ref(pods)
  const namespaceList = ref(namespaces)
  const eventList = ref(events)
  const serviceList = ref(services)
  const ingressList = ref(ingresses)
  const endpointsList = ref(endpoints)
  const configMapList = ref(configMaps)
  const secretList = ref(secrets.map(s => ({ ...s, data: encodeSecretData(s.data) })))
  const pvList = ref(persistentVolumes)
  const pvcList = ref(pvcs)
  const scList = ref(storageClasses)
  const ingressClassList = ref(ingressClasses)
  const runtimeClassList = ref(runtimeClasses)
  const roleList = ref(roles)
  const saList = ref(serviceAccounts)
  const logEntries = ref(podLogs)
  const networkPolicyList = ref(networkPolicies)
  const hpaList = ref(hpas)
  const resourceQuotaList = ref(resourceQuotas)
  const limitRangeList = ref(limitRanges)
  const roleBindingList = ref(roleBindings)
  const clusterRoleBindingList = ref(clusterRoleBindings)
  const pdbList = ref(podDisruptionBudgets)
  const priorityClassList = ref(priorityClasses)
  // 多集群：已保存集群来自 localStorage；clusterList 为其映射（无已保存时回退演示数据）
  const savedClusters = ref(getSavedClusters())
  const activeApiServerRef = ref(activeApiServer())
  const clusterList = computed(() => savedClusters.value.length
    ? savedClusters.value.map(c => ({ name: c.name, apiServer: c.apiServer, version: c.version, status: c.status || 'Healthy', distribution: c.distribution || 'Kubernetes', context: c.name, current: c.apiServer === activeApiServerRef.value }))
    : clusters)
  const auditLogList = ref(auditLogs)
  const crdList = ref(customResourceDefinitions)
  const currentCluster = ref(clusters.find(c => c.current)?.name || clusters[0]?.name || '')
  const remoteMode = ref(false)
  const connectionState = ref('mock')
  // 上一次水合的集群级 CPU/内存百分比，用于计算趋势（首次为 null → 趋势显示「—」）
  let prevClusterMetrics = { cpu: null, mem: null }
  // Pod Watch（实时监听）的资源版本续接点 + 句柄；断开/出错即停，避免重连风暴
  let podWatchRv = null
  let podWatchHandle = null
  const podWatchLive = ref(false)

  // === 当前选中的 Namespace（持久化：刷新不丢，与集群选择同模式）===
  const currentNamespace = ref(localStorage.getItem('aliangboard.namespace') || '')

  // === 微服务分层定义（对标 Kuboard tier）===
  const TIER_META = {
    web: { label: i18n.global.t('store.presentationLayer'), en: 'Web', icon: 'web', color: 'primary', order: 0 },
    gateway: { label: i18n.global.t('store.gatewayLayer'), en: 'Gateway', icon: 'dns', color: 'secondary', order: 1 },
    svc: { label: i18n.global.t('store.serviceLayer'), en: 'Service', icon: 'apps', color: 'tertiary', order: 2 },
    cloud: { label: i18n.global.t('store.middlewareLayer'), en: 'Middleware', icon: 'cloud', color: 'tertiary', order: 3 },
    db: { label: i18n.global.t('store.persistenceLayer'), en: 'Database', icon: 'database', color: 'error', order: 4 },
    monitor: { label: i18n.global.t('store.monitorLayer'), en: 'Monitor', icon: 'monitoring', color: 'secondary', order: 5 },
    default: { label: i18n.global.t('store.defaultLayer'), en: 'Default', icon: 'workspaces', color: 'surface', order: 6 },
  }

  // === 全局计算属性 ===
  const runningPods = computed(() => podList.value.filter(p => p.status === 'Running').length)
  const pendingPods = computed(() => podList.value.filter(p => p.status === 'Pending').length)
  const failedPods = computed(() => podList.value.filter(p => p.status === 'Failed').length)
  const healthyNodes = computed(() => nodeList.value.filter(n => n.status === 'Ready').length)
  const totalNodes = computed(() => nodeList.value.length)
  const apiReachable = ref(true)
  const clusterHealth = computed(() => computeClusterHealth({
    nodeList: nodeList.value, apiReachable: apiReachable.value, remoteMode: remoteMode.value,
  }))

  // === Namespace 作用域的计算属性 ===
  const nsWorkloads = computed(() => {
    if (!currentNamespace.value) return []
    return workloadList.value.filter(w => w.namespace === currentNamespace.value)
  })

  const nsPods = computed(() => {
    if (!currentNamespace.value) return []
    return podList.value.filter(p => p.namespace === currentNamespace.value)
  })

  const nsServices = computed(() => {
    if (!currentNamespace.value) return []
    return serviceList.value.filter(s => s.namespace === currentNamespace.value)
  })

  // 当前 ns 下所有工作负载暴露的容器端口（去重升序），供 Service targetPort 下拉选择
  const nsContainerPorts = computed(() => extractContainerPorts(nsWorkloads.value))
  // 按 workload 聚合的容器端口（保留来源），供 PortSelect 分组展示 + 优先匹配绑定工作负载
  const nsContainerPortGroups = computed(() => extractContainerPortsGrouped(nsWorkloads.value))

  const nsIngress = computed(() => {
    if (!currentNamespace.value) return []
    return ingressList.value.filter(s => s.namespace === currentNamespace.value)
  })

  const nsEndpoints = computed(() => {
    if (!currentNamespace.value) return []
    return endpointsList.value.filter(e => e.namespace === currentNamespace.value)
  })

  const nsConfigMaps = computed(() => {
    if (!currentNamespace.value) return []
    return configMapList.value.filter(c => c.namespace === currentNamespace.value)
  })

  const nsSecrets = computed(() => {
    if (!currentNamespace.value) return []
    return secretList.value.filter(s => s.namespace === currentNamespace.value)
  })

  const nsPVCs = computed(() => {
    if (!currentNamespace.value) return []
    return pvcList.value.filter(p => p.namespace === currentNamespace.value)
  })

  const nsRoles = computed(() => {
    if (!currentNamespace.value) return []
    return roleList.value.filter(r => r.namespace === currentNamespace.value && r.scope !== 'Cluster')
  })

  const nsServiceAccounts = computed(() => {
    if (!currentNamespace.value) return []
    return saList.value.filter(s => s.namespace === currentNamespace.value)
  })

  const nsNetworkPolicies = computed(() => {
    if (!currentNamespace.value) return []
    return networkPolicyList.value.filter(n => n.namespace === currentNamespace.value)
  })

  const nsHPAs = computed(() => {
    if (!currentNamespace.value) return []
    return hpaList.value.filter(h => h.namespace === currentNamespace.value)
  })

  const nsResourceQuotas = computed(() => {
    if (!currentNamespace.value) return []
    return resourceQuotaList.value.filter(r => r.namespace === currentNamespace.value)
  })

  const nsLimitRanges = computed(() => {
    if (!currentNamespace.value) return []
    return limitRangeList.value.filter(l => l.namespace === currentNamespace.value)
  })

  const nsRoleBindings = computed(() => {
    if (!currentNamespace.value) return []
    return roleBindingList.value.filter(r => r.namespace === currentNamespace.value)
  })

  // 集群级角色（全局，不按 namespace 过滤）
  const clusterRoles = computed(() => roleList.value.filter(r => r.scope === 'Cluster'))

  // 命名空间级 PDB
  const nsPDBs = computed(() => {
    if (!currentNamespace.value) return []
    return pdbList.value.filter(p => p.namespace === currentNamespace.value)
  })

  const nsEvents = computed(() => {
    if (!currentNamespace.value) return eventList.value
    return eventList.value.filter(e => e.namespace === currentNamespace.value)
  })

  // Namespace 统计
  const nsStats = computed(() => {
    if (!currentNamespace.value) return {}
    const ns = currentNamespace.value
    return {
      deployments: workloadList.value.filter(w => w.namespace === ns && w.type === 'Deployment').length,
      statefulSets: workloadList.value.filter(w => w.namespace === ns && w.type === 'StatefulSet').length,
      daemonSets: workloadList.value.filter(w => w.namespace === ns && w.type === 'DaemonSet').length,
      jobs: workloadList.value.filter(w => w.namespace === ns && (w.type === 'Job' || w.type === 'CronJob')).length,
      pods: podList.value.filter(p => p.namespace === ns).length,
      runningPods: podList.value.filter(p => p.namespace === ns && p.status === 'Running').length,
      services: serviceList.value.filter(s => s.namespace === ns).length,
      ingress: ingressList.value.filter(i => i.namespace === ns).length,
      configMaps: configMapList.value.filter(c => c.namespace === ns).length,
      secrets: secretList.value.filter(s => s.namespace === ns).length,
      pvcs: pvcList.value.filter(p => p.namespace === ns).length,
    }
  })

  // 微服务分层拓扑：按 classifyResource(w) 分组（与 NsLayers 同源），输出 LAYER_TAXONOMY 扁平层。
  // meta 带 color/en/icon/label，供 NamespaceOverview 的 tierBg/Text/Chip 直接复用。
  const nsTieredWorkloads = computed(() => {
    if (!currentNamespace.value) return []
    const groups = {}
    nsWorkloads.value.forEach(w => {
      const key = classifyResource(w) || 'unclassified'
      ;(groups[key] ||= []).push(w)
    })
    const flat = []
    for (const node of LAYER_TAXONOMY) {
      if (node.children) flat.push(...node.children); else flat.push(node)
    }
    return flat.filter(n => groups[n.key]?.length).map(n => ({ tier: n.key, meta: n, workloads: groups[n.key] }))
  })

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

  function getWorkloadByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return workloadList.value.find(w => w.name === name && (!namespace || w.namespace === namespace))
  }

  // 按需拉取单个工作负载并 upsert 进 workloadList。
  // Job/CronJob 不在 hydrateCoreResources 的批量拉取里；从 Pod 详情跳转或直接链接进入时用此补齐。
  async function fetchWorkload(type, name, ns) {
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs' }[type]
    if (!plural) throw new Error(i18n.global.t('store.unsupportedWorkloadType', { type }))
    const gv = type === 'Job' || type === 'CronJob' ? '/apis/batch/v1' : '/apis/apps/v1'
    const data = await api.k8s(`${gv}/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`)
    const wl = mapWorkload(data, type)
    const idx = workloadList.value.findIndex(w => w.name === name && w.namespace === ns && w.type === type)
    if (idx >= 0) workloadList.value[idx] = wl
    else workloadList.value.push(wl)
    return wl
  }

  function getPodByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return podList.value.find(p => p.name === name && (!namespace || p.namespace === namespace))
  }

  function getNodeByName(name) {
    return nodeList.value.find(n => n.name === name)
  }

  function getNamespaceByName(name) {
    return namespaceList.value.find(n => n.name === name)
  }

  function getServiceByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return serviceList.value.find(s => s.name === name && s.namespace === namespace)
  }

  function getIngressByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return ingressList.value.find(i => i.name === name && i.namespace === namespace)
  }

  function getConfigMapByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return configMapList.value.find(c => c.name === name && c.namespace === namespace)
  }

  function getSecretByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return secretList.value.find(s => s.name === name && s.namespace === namespace)
  }

  function getPVCByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return pvcList.value.find(p => p.name === name && p.namespace === namespace)
  }

  function getNetworkPolicyByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return networkPolicyList.value.find(n => n.name === name && n.namespace === namespace)
  }

  function getHPAByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return hpaList.value.find(h => h.name === name && h.namespace === namespace)
  }

  function getResourceQuotaByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return resourceQuotaList.value.find(r => r.name === name && r.namespace === namespace)
  }

  function getLimitRangeByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return limitRangeList.value.find(l => l.name === name && l.namespace === namespace)
  }

  function getRoleByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return roleList.value.find(r => r.name === name && (r.scope === 'Cluster' || r.namespace === namespace))
  }

  function getServiceAccountByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return saList.value.find(s => s.name === name && s.namespace === namespace)
  }

  function getRoleBindingByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return roleBindingList.value.find(r => r.name === name && r.namespace === namespace)
  }

  function getWorkloadPods(workloadName, ns) {
    const namespace = ns || currentNamespace.value
    const wl = workloadList.value.find(w => w.name === workloadName && w.namespace === namespace)
    if (!wl) return []
    // 优先用 spec.selector.matchLabels（K8s 官方 Pod 选择器，最准确）
    const tpl = wl.raw?.spec?.template || wl.raw?.spec?.jobTemplate?.spec?.template
    const selector = wl.raw?.spec?.selector?.matchLabels
    if (selector && Object.keys(selector).length) {
      return podList.value.filter(p => p.namespace === namespace &&
        Object.entries(selector).every(([k, v]) => p.labels?.[k] === v))
    }
    // 回退 1：用 pod template labels（pods 继承的是 template labels，不是 metadata labels）
    const tplApp = tpl?.metadata?.labels?.app
    if (tplApp) return podList.value.filter(p => p.namespace === namespace && p.labels?.app === tplApp)
    // 回退 2：用 workload metadata labels.app
    const appLabel = wl.labels?.app
    if (appLabel) return podList.value.filter(p => p.namespace === namespace && p.labels?.app === appLabel)
    // 回退 3：名称前缀匹配
    return podList.value.filter(p => p.namespace === namespace && p.name.startsWith(workloadName))
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

  // 反查：哪些 workload 引用了指定的 ConfigMap / Secret
  // 返回 [{ workload, reference }]，按引用方式分组
  function getResourceReferences(kind, name, ns) {
    const namespace = ns || currentNamespace.value
    const results = []
    workloadList.value.forEach(w => {
      if (w.namespace !== namespace) return
      const refs = extractWorkloadReferences(w.raw, w.type)
      refs.filter(r => r.kind === kind && r.name === name).forEach(reference => results.push({ workload: w, reference }))
    })
    return results
  }

  // 正查：某个 workload 引用了哪些 ConfigMap / Secret
  function getWorkloadReferences(workloadName, ns) {
    const namespace = ns || currentNamespace.value
    const wl = workloadList.value.find(w => w.name === workloadName && w.namespace === namespace)
    return wl ? extractWorkloadReferences(wl.raw, wl.type) : []
  }

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
  async function remoteUpdate(yamlStr, label, rollbackFn) {
    try {
      await api.applyYaml(yamlStr)
      notify('success', `${label}${i18n.global.t('common.save')}`)
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrConflict')}`)
      if (rollbackFn) rollbackFn()
    }
  }
  // 远端定点 PATCH（application/merge-patch+json），失败回滚本地并提示
  async function remotePatch(path, patch, label, rollbackFn) {
    try {
      await api.k8s(path, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch) })
      notify('success', `${label}${i18n.global.t('common.save')}`)
    } catch (e) {
      notify('error', `${label}${i18n.global.t('store.saveFailed')}：${e.message || i18n.global.t('store.permissionDeniedOrNotExist')}`)
      if (rollbackFn) rollbackFn()
    }
  }

  // roleList 同时承载 Role 与 ClusterRole，刷新时需合并两类
  async function refetchRoles() {
    try {
      const [r, cr] = await Promise.all([
        api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
        api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
      ])
      roleList.value = [
        ...((r.items) || []).map(x => mapRole(x, 'Namespace')),
        ...((cr.items) || []).map(x => mapRole(x, 'Cluster')),
      ]
    } catch { /* 忽略 */ }
  }

  // === CRUD: Services ===
  async function addService(svc) {
    if (remoteMode.value) {
      await remoteCreate(generateYAML('service', svc), `Service/${svc.name}`, () => refetch('/api/v1/services', serviceList, mapService))
    } else {
      serviceList.value.push({ ...svc, age: 'Just now' })
      // Update namespace service count
      const ns = namespaceList.value.find(n => n.name === svc.namespace)
      if (ns) ns.services++
    }
    invalidateResource('services')
  }

  async function updateService(name, ns, updates) {
    const idx = serviceList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(serviceList.value[idx]))
    serviceList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('service', serviceList.value[idx]), 'Service', () => { serviceList.value[idx] = before })
    invalidateResource('services')
  }

  async function deleteService(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/services/${encodeURIComponent(name)}`, serviceList, s => s.name === name && s.namespace === ns)
    } else {
      const idx = serviceList.value.findIndex(s => s.name === name && s.namespace === ns)
      if (idx !== -1) serviceList.value.splice(idx, 1)
      const nsObj = namespaceList.value.find(n => n.name === ns)
      if (nsObj) nsObj.services = Math.max(0, nsObj.services - 1)
    }
    invalidateResource('services')
  }

  // === CRUD: Ingress ===
  async function addIngress(ing) {
    if (remoteMode.value) await remoteCreate(generateYAML('ingress', ing), `Ingress/${ing.name}`, () => refetch('/apis/networking.k8s.io/v1/ingresses', ingressList, mapIngress))
    else ingressList.value.push({ ...ing, age: 'Just now' })
    invalidateResource('ingresses')
  }

  async function updateIngress(name, ns, updates) {
    const idx = ingressList.value.findIndex(i => i.name === name && i.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(ingressList.value[idx]))
    ingressList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('ingress', ingressList.value[idx]), 'Ingress', () => { ingressList.value[idx] = before })
    invalidateResource('ingresses')
  }

  // 结构化编辑 Ingress 路由规则：入参 flatRules + defaultBackend，
  // 用 buildIngressRulesPatch 构造 PATCH body（rules + defaultBackend 一次提交）；
  // defaultBackend===null 时 merge-patch 删除该字段。本地合并 rules/defaultBackend/hosts。
  async function updateIngressRules(name, ns, flatRules, defaultBackend = null) {
    const patch = buildIngressRulesPatch(flatRules, defaultBackend)
    const rules = patch.spec.rules
    const db = patch.spec.defaultBackend
    if (remoteMode.value) {
      await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(patch),
      })
    }
    updateIngress(name, ns, { rules, defaultBackend: db, hosts: rules.map(r => r.host).filter(Boolean).join(',') })
  }

  async function deleteIngress(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`, ingressList, i => i.name === name && i.namespace === ns)
    } else {
      const idx = ingressList.value.findIndex(i => i.name === name && i.namespace === ns)
      if (idx !== -1) ingressList.value.splice(idx, 1)
    }
    invalidateResource('ingresses')
  }

  // === CRUD: ConfigMaps ===
  async function addConfigMap(cm) {
    if (remoteMode.value) await remoteCreate(generateYAML('configmap', cm), `ConfigMap/${cm.name}`, () => refetch('/api/v1/configmaps', configMapList, mapConfigMap))
    else configMapList.value.push({ ...cm, age: 'Just now' })
    invalidateResource('configmaps')
  }

  async function updateConfigMap(name, ns, updates) {
    const idx = configMapList.value.findIndex(c => c.name === name && c.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(configMapList.value[idx]))
    configMapList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('configmap', configMapList.value[idx]), 'ConfigMap', () => { configMapList.value[idx] = before })
    invalidateResource('configmaps')
  }

  async function deleteConfigMap(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps/${encodeURIComponent(name)}`, configMapList, c => c.name === name && c.namespace === ns)
    } else {
      const idx = configMapList.value.findIndex(c => c.name === name && c.namespace === ns)
      if (idx !== -1) configMapList.value.splice(idx, 1)
    }
    invalidateResource('configmaps')
  }

  // === CRUD: Secrets ===
  async function addSecret(sec) {
    if (remoteMode.value) {
      // 表单 data 为明文；先 base64 编码再交给 generateYAML，其内部 decodeBase64 会还原为 stringData 明文
      await remoteCreate(generateYAML('secret', { ...sec, data: encodeSecretData(sec.data) }), `Secret/${sec.name}`, () => refetch('/api/v1/secrets', secretList, mapSecret))
    } else {
      secretList.value.push({ ...sec, data: encodeSecretData(sec.data), age: 'Just now' })
    }
    invalidateResource('secrets')
  }

  async function updateSecret(name, ns, updates) {
    const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(secretList.value[idx]))
    // data 来自表单（明文），统一编码后再入库
    const next = { ...updates }
    if (next.data) next.data = encodeSecretData(next.data)
    secretList.value[idx] = { ...before, ...next }
    if (remoteMode.value) await remoteUpdate(generateYAML('secret', secretList.value[idx]), 'Secret', () => { secretList.value[idx] = before })
    invalidateResource('secrets')
  }

  async function deleteSecret(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`, secretList, s => s.name === name && s.namespace === ns)
    } else {
      const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
      if (idx !== -1) secretList.value.splice(idx, 1)
    }
    invalidateResource('secrets')
  }

  // === CRUD: PVCs ===
  async function addPVC(pvc) {
    if (remoteMode.value) await remoteCreate(generateYAML('pvc', pvc), `PVC/${pvc.name}`, () => refetch('/api/v1/persistentvolumeclaims', pvcList, mapPVC))
    else pvcList.value.push({ ...pvc, age: 'Just now' })
    invalidateResource('pvcs')
  }

  async function updatePVC(name, ns, updates) {
    const idx = pvcList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(pvcList.value[idx]))
    pvcList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('pvc', pvcList.value[idx]), 'PVC', () => { pvcList.value[idx] = before })
    invalidateResource('pvcs')
  }

  async function deletePVC(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims/${encodeURIComponent(name)}`, pvcList, p => p.name === name && p.namespace === ns)
    } else {
      const idx = pvcList.value.findIndex(p => p.name === name && p.namespace === ns)
      if (idx !== -1) pvcList.value.splice(idx, 1)
    }
    invalidateResource('pvcs')
  }

  // === CRUD: PersistentVolumes（集群级）===
  function getPVByName(name) {
    return pvList.value.find(p => p.name === name)
  }
  async function addPV(pv) {
    if (remoteMode.value) return remoteCreate(generateYAML('pv', pv), `PersistentVolume/${pv.name}`, () => refetch('/api/v1/persistentvolumes', pvList, mapPV))
    pvList.value.push({ status: 'Available', age: 'Just now', ...pv })
  }
  async function updatePV(name, updates) {
    const idx = pvList.value.findIndex(p => p.name === name)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(pvList.value[idx]))
    const patch = buildPVPatch(before, updates)
    if (!patch) return
    if (remoteMode.value) {
      await remotePatch(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, patch, 'PersistentVolume', () => { pvList.value[idx] = before })
    }
    pvList.value[idx] = {
      ...before,
      ...(updates.reclaimPolicy ? { reclaimPolicy: updates.reclaimPolicy } : {}),
      ...(updates.labels ? { labels: updates.labels } : {}),
      ...(updates.annotations ? { annotations: updates.annotations } : {}),
    }
  }
  async function deletePV(name) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, pvList, p => p.name === name)
      return
    }
    const idx = pvList.value.findIndex(p => p.name === name)
    if (idx !== -1) pvList.value.splice(idx, 1)
  }

  // === CRUD: StorageClasses（集群级）===
  function getSCByName(name) {
    return scList.value.find(s => s.name === name)
  }
  async function addStorageClass(sc) {
    if (remoteMode.value) return remoteCreate(generateYAML('storageclass', sc), `StorageClass/${sc.name}`, () => refetch('/apis/storage.k8s.io/v1/storageclasses', scList, mapStorageClass))
    scList.value.push({ age: 'Just now', ...sc })
  }
  async function updateStorageClass(name, updates) {
    const idx = scList.value.findIndex(s => s.name === name)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(scList.value[idx]))
    const patch = buildStorageClassPatch(before, updates)
    if (!patch) return
    if (remoteMode.value) {
      await remotePatch(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, patch, 'StorageClass', () => { scList.value[idx] = before })
    }
    const DEFAULT_KEY = 'storageclass.kubernetes.io/is-default-class'
    const newAnns = { ...(updates.annotations || before.annotations || {}) }
    if (updates.isDefault != null) {
      if (updates.isDefault) newAnns[DEFAULT_KEY] = 'true'
      else delete newAnns[DEFAULT_KEY]
    }
    scList.value[idx] = {
      ...before,
      default: updates.isDefault != null ? !!updates.isDefault : before.default,
      ...(updates.labels ? { labels: updates.labels } : {}),
      annotations: newAnns,
    }
  }
  async function deleteStorageClass(name) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(name)}`, scList, s => s.name === name)
      return
    }
    const idx = scList.value.findIndex(s => s.name === name)
    if (idx !== -1) scList.value.splice(idx, 1)
  }

  // === CRUD: Endpoints ===
  function getEndpointsByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return endpointsList.value.find(e => e.name === name && e.namespace === namespace)
  }
  function updateEndpoints(name, ns, updates) {
    const idx = endpointsList.value.findIndex(e => e.name === name && e.namespace === ns)
    if (idx !== -1) endpointsList.value[idx] = { ...endpointsList.value[idx], ...updates }
  }

  // === CRUD: IngressClass / RuntimeClass（集群级）===
  function getIngressClassByName(name) {
    return ingressClassList.value.find(c => c.name === name)
  }
  async function addIngressClass(ic) {
    if (remoteMode.value) return remoteCreate(generateYAML('ingressclass', ic), `IngressClass/${ic.name}`, () => refetch('/apis/networking.k8s.io/v1/ingressclasses', ingressClassList, mapIngressClass))
    ingressClassList.value.push({ age: 'Just now', ...ic })
  }
  function updateIngressClass(name, updates) {
    const idx = ingressClassList.value.findIndex(c => c.name === name)
    if (idx !== -1) ingressClassList.value[idx] = { ...ingressClassList.value[idx], ...updates }
  }
  async function deleteIngressClass(name) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(name)}`, ingressClassList, c => c.name === name)
      return
    }
    const idx = ingressClassList.value.findIndex(c => c.name === name)
    if (idx !== -1) ingressClassList.value.splice(idx, 1)
  }
  function getRuntimeClassByName(name) {
    return runtimeClassList.value.find(r => r.name === name)
  }
  async function addRuntimeClass(rc) {
    if (remoteMode.value) return remoteCreate(generateYAML('runtimeclass', rc), `RuntimeClass/${rc.name}`, () => refetch('/apis/node.k8s.io/v1/runtimeclasses', runtimeClassList, mapRuntimeClass))
    runtimeClassList.value.push({ age: 'Just now', ...rc })
  }
  function updateRuntimeClass(name, updates) {
    const idx = runtimeClassList.value.findIndex(r => r.name === name)
    if (idx !== -1) runtimeClassList.value[idx] = { ...runtimeClassList.value[idx], ...updates }
  }
  async function deleteRuntimeClass(name) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/node.k8s.io/v1/runtimeclasses/${encodeURIComponent(name)}`, runtimeClassList, r => r.name === name)
      return
    }
    const idx = runtimeClassList.value.findIndex(r => r.name === name)
    if (idx !== -1) runtimeClassList.value.splice(idx, 1)
  }

  // === CRUD: Workloads (for Deploy) ===
  function addWorkload(wl) {
    workloadList.value.push({ ...wl, age: 'Just now' })
    const ns = namespaceList.value.find(n => n.name === wl.namespace)
    if (ns) ns.pods += parseInt(wl.replicas?.split('/')[1] || '1')
  }

  async function deleteWorkload(name, ns) {
    const matchFn = w => w.name === name && w.namespace === ns
    if (remoteMode.value) {
      const workload = workloadList.value.find(matchFn)
      const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[workload?.type]
      if (!plural) { notify('error', i18n.global.t('store.deleteNotSupported', { type: workload?.type || i18n.global.t('store.thisWorkload') })); return }
      // 与其它资源一致：乐观删除 + 失败回滚 + 全局提示
      await remoteDelete(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, workloadList, matchFn, i18n.global.t('store.workload'))
      return
    }
    const idx = workloadList.value.findIndex(matchFn)
    if (idx !== -1) workloadList.value.splice(idx, 1)
  }

  async function updateWorkload(name, ns, updates) {
    const idx = workloadList.value.findIndex(w => w.name === name && w.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(workloadList.value[idx]))
    workloadList.value[idx] = { ...before, ...updates }
    const wl = workloadList.value[idx]
    // tier 以 layer.aliangboard.io label 为权威：本地即时写入 labels，classifyResource 无需刷新即可重算
    if (updates.tier != null) {
      wl.labels = { ...(wl.labels || {}), 'layer.aliangboard.io': updates.tier }
      wl.tier = updates.tier
    }
    if (remoteMode.value) {
      const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
      // 定点 merge-patch：仅改动字段，避免 regenerate 丢失深模板（env/probes/卷）。Job/CronJob 等不支持定点编辑，回退仅本地。
      if (plural) {
        const patch = {}
        // labels：合并 tier→layer.aliangboard.io，保留既有 labels（merge-patch 全量回写，故取并集）
        if (updates.labels || updates.tier != null) {
          const labels = { ...(updates.labels || before.labels || {}) }
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
          const tpl = wl.raw?.spec?.template || { spec: { containers: [{ name: wl.name, image: wl.image }] } }
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
          await remotePatch(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, patch, i18n.global.t('store.workload'), () => { workloadList.value[idx] = before })
          // 本地镜像远端 spec（策略/历史上限）以便 UI 立即反映
          if (spec.strategy) wl.raw.spec.strategy = spec.strategy
          if (spec.revisionHistoryLimit != null) wl.raw.spec.revisionHistoryLimit = spec.revisionHistoryLimit
        }
      }
    }
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
    if (!remoteMode.value) throw new Error(i18n.global.t('store.onlyAvailableAfterConnect'))
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
    // 本地即时反映：NsLayers 的 items 直接引用这些对象的 labels，改了即重算 classifyResource
    const list = res[2] === 'workload' ? workloadList : res[2] === 'service' ? serviceList : ingressList
    const it = list.value.find(x => x.name === name && x.namespace === ns)
    if (it) { it.labels = labels; if ('tier' in it) it.tier = layerKey }
  }

  async function applyWorkloadTemplate(name, ns, template) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (!wl) throw new Error(i18n.global.t('store.workloadNotFound'))
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (!plural) throw new Error(`${i18n.global.t('store.deepEditNotSupported', { type: wl.type || i18n.global.t('store.thisWorkload') })}`)
    if (remoteMode.value) {
      const tag = aliangTag()
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { template }, metadata: { labels: tag.labels, annotations: tag.annotations } }),
      })
    }
    wl.raw = { ...(wl.raw || {}), spec: { ...(wl.raw?.spec || {}), template } }
    const img = template?.spec?.containers?.[0]?.image
    if (img) wl.image = img
    wl.age = 'Just now'
  }

  // 业务元数据编辑：一次 merge-patch 同时写 Deployment.metadata.labels/annotations + Pod 模板 labels（与创建一致）。
  // - labels/annotations：期望「全量 map」（视图已并入系统保留键的旧值）；removedLabels/removedAnnotations：需删除的键（merge-patch 用 null 删除）。
  // - templateLabels：期望的 Pod 模板 labels 全量（镜像业务/自定义标签，与创建落点一致）；null 则不触碰 Pod 模板。
  // 乐观更新本地状态，远端失败回滚。仅 Deployment/StatefulSet/DaemonSet。
  async function updateWorkloadMeta(name, ns, payload) {
    const idx = workloadList.value.findIndex(w => w.name === name && w.namespace === ns)
    if (idx === -1) throw new Error(i18n.global.t('store.workloadNotFound'))
    const wl = workloadList.value[idx]
    const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl.type]
    if (!plural) throw new Error(`${i18n.global.t('store.editMetadataNotSupported', { type: wl.type || i18n.global.t('store.thisWorkload') })}`)
    const { labels = {}, annotations = {}, removedLabels = [], removedAnnotations = [], templateLabels = null } = payload || {}
    const tag = aliangTag() // managed-by + last-edited 自动 tag
    const outLabels = { ...labels, ...tag.labels }
    removedLabels.forEach(k => { outLabels[k] = null })
    const outAnnotations = { ...annotations, ...tag.annotations }
    removedAnnotations.forEach(k => { outAnnotations[k] = null })
    const patch = { metadata: { labels: outLabels, annotations: outAnnotations } }
    if (templateLabels) patch.spec = { template: { metadata: { labels: templateLabels } } }

    const before = JSON.parse(JSON.stringify(wl))
    // 乐观本地更新（mock 模式亦生效）
    const liveLabels = { ...(wl.labels || {}) }
    Object.entries(labels).forEach(([k, v]) => { liveLabels[k] = v })
    removedLabels.forEach(k => { delete liveLabels[k] })
    const liveAnn = { ...(wl.annotations || {}), ...tag.annotations }
    Object.entries(annotations).forEach(([k, v]) => { liveAnn[k] = v })
    removedAnnotations.forEach(k => { delete liveAnn[k] })
    wl.labels = liveLabels
    wl.annotations = liveAnn
    const newLayer = liveLabels['aliangboard.io/layer'] || liveLabels['layer.aliangboard.io']
    if (newLayer) wl.tier = newLayer
    if (wl.raw) {
      wl.raw.metadata = wl.raw.metadata || {}
      wl.raw.metadata.labels = liveLabels
      wl.raw.metadata.annotations = liveAnn
      if (templateLabels && wl.raw.spec?.template) {
        wl.raw.spec.template.metadata = wl.raw.spec.template.metadata || {}
        wl.raw.spec.template.metadata.labels = { ...(wl.raw.spec.template.metadata.labels || {}), ...templateLabels }
      }
    }
    if (remoteMode.value) {
      await remotePatch(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, patch, i18n.global.t('store.metadata'), () => { workloadList.value[idx] = before })
    } else {
      notify('success', i18n.global.t('store.metadataSaved'))
    }
  }

  async function scaleWorkload(name, ns, replicas) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (remoteMode.value) {
      const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets' }[wl?.type]
      if (!plural) throw new Error(`${i18n.global.t('store.scaleNotSupported', { type: wl?.type || i18n.global.t('store.thisWorkload') })}`)
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}/scale`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { replicas: Number(replicas) } }),
      })
    }
    if (wl) {
      const current = parseInt(wl.replicas?.split('/')[1] || '1')
      wl.replicas = `${Math.min(replicas, current)}/${replicas}`
    }
  }

  async function restartWorkload(name, ns) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (remoteMode.value) {
      const plural = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[wl?.type]
      if (!plural) throw new Error(`${i18n.global.t('store.restartNotSupported', { type: wl?.type || i18n.global.t('store.thisWorkload') })}`)
      await api.k8s(`/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } }),
      })
    }
    if (wl) {
      wl.age = 'Just now'
      // Simulate restart by updating SHA
      const hash = Math.random().toString(16).substring(2, 9)
      wl.sha = `sha:${hash}`
      // 滚动重启产生新版本
      if (Array.isArray(wl.revisions)) {
        wl.revisions.forEach(r => r.current = false)
        const nextRev = (wl.revisions[0]?.rev || 0) + 1
        wl.revisions = [{ rev: nextRev, image: wl.image, sha: wl.sha, age: 'Just now', current: true, reason: i18n.global.t('store.rollingRestart') }, ...wl.revisions]
      }
    }
  }

  // 一键回滚到指定 revision（kubectl rollout undo --to-revision=N 语义）
  async function rollbackWorkload(name, ns, revNumber) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (!wl) throw new Error(i18n.global.t('store.workloadNotFound'))
    const target = (wl.revisions || []).find(r => r.rev === revNumber)
    if (!target) throw new Error(i18n.global.t('store.revisionNotFound', { rev: revNumber }))
    if (remoteMode.value) {
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
    }
    // 本地反映：标记旧版本非当前，追加一条「回滚到 revN」的当前版本（携带目标 template 以便连续回滚）
    wl.revisions.forEach(r => r.current = false)
    const nextRev = Math.max(0, ...(wl.revisions.map(r => r.rev))) + 1
    wl.image = target.image
    wl.sha = target.sha
    wl.age = 'Just now'
    wl.revisions = [{ rev: nextRev, image: target.image, sha: target.sha, age: 'Just now', current: true, reason: i18n.global.t('store.rollbackTo', { rev: revNumber }), _template: target._template }, ...wl.revisions]
  }

  // === CRUD: Pods ===
  function addPod(pod) {
    podList.value.push({
      status: 'Pending',
      node: '',
      ip: '',
      cpu: '0/0',
      memory: '0/0',
      restarts: 0,
      age: 'Just now',
      containers: [pod.name],
      labels: { app: pod.name },
      annotations: {},
      ...pod,
    })
    const ns = namespaceList.value.find(n => n.name === pod.namespace)
    if (ns) ns.pods = (ns.pods || 0) + 1
  }

  async function deletePod(name, ns) {
    if (remoteMode.value) {
      await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`, { method: 'DELETE' })
    }
    const idx = podList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx !== -1) {
      const pod = podList.value[idx]
      podList.value.splice(idx, 1)
      const nsObj = namespaceList.value.find(n => n.name === ns)
      if (nsObj) nsObj.pods = Math.max(0, (nsObj.pods || 0) - 1)
      return pod
    }
    return null
  }

  // 周期健康检查：轻量重拉 /api/v1/nodes → 就地更新 nodeList 的 Ready/NotReady + apiReachable。
  // 失败 → apiReachable=false（clusterHealth 转 Disconnected）。只更新现有节点状态，不碰 metrics/raw；节点增删由全量 hydrate 处理。
  let healthTimer = null
  async function refreshNodeHealth() {
    if (!remoteMode.value) return
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
    if (healthTimer || !remoteMode.value) return
    refreshNodeHealth()
    healthTimer = setInterval(refreshNodeHealth, 10000)
  }
  function stopHealthCheck() { if (healthTimer) clearInterval(healthTimer); healthTimer = null }

  // 轻量刷新 Pod 列表（仅重取 pods，不拉全套资源）：删 Pod 后控制器重建，延时调用即可看到新 Pod（重新拉镜像）
  async function refreshPods() {
    if (!remoteMode.value) return
    await refetch('/api/v1/pods', podList, item => mapPod(item))
  }

  // 拉取 events 快照（供实时页挂载时补初始数据，避免空表闪；同时刷新 eventWatchRv 供 watch 续接）
  async function refreshEvents() {
    if (!remoteMode.value) return
    try {
      const data = await api.k8s('/api/v1/events?limit=1000')
      if (data?.items) {
        eventList.value = data.items.map(mapEvent).sort((a, b) => (b._ts || 0) - (a._ts || 0))
        if (data.metadata?.resourceVersion) eventWatchRv = data.metadata.resourceVersion
      }
    } catch { /* 静默：保留上次 eventList，watch 继续推增量 */ }
  }

  // 节点列表拉取（自包含：nodes + node-metrics → mapNode）。供 Nodes 页 Vue Query 作 fetcher，不依赖 hydrate。
  async function fetchNodes() {
    const [nodeData, metricsData] = await Promise.all([
      api.k8s('/api/v1/nodes'),
      api.k8s('/apis/metrics.k8s.io/v1beta1/nodes').catch(() => null),
    ])
    const metricMap = new Map()
    for (const it of (metricsData?.items || [])) {
      metricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
    }
    const metricFor = name => (metricMap.has(name) ? metricMap.get(name) : null)
    return (nodeData?.items || []).map(item => mapNode(item, metricFor(item.metadata?.name)))
  }

  // 单节点拉取（node + node-metrics 过滤）。供 NodeDetail useResourceDetail 作 fetcher。
  async function fetchNode(name) {
    const [nodeData, metricsData] = await Promise.all([
      api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`),
      api.k8s('/apis/metrics.k8s.io/v1beta1/nodes').catch(() => null),
    ])
    const m = (metricsData?.items || []).find(it => it.metadata?.name === name)
    const metric = m ? { cpuMilli: cpuToMilli(m.usage?.cpu), memKi: memToKi(m.usage?.memory) } : null
    return nodeData ? mapNode(nodeData, metric) : null
  }

  // 单类型资源列表拉取（自包含：单 endpoint + mapXxx，无 metrics 耦合）。供各 Ns* 列表页 Vue Query 作 fetcher。
  async function fetchServices() { const d = await api.k8s('/api/v1/services?limit=1000'); return (d?.items || []).map(mapService) }
  async function fetchService(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/services/${encodeURIComponent(name)}`); return d ? mapService(d) : null }
  async function fetchConfigMaps() { const d = await api.k8s('/api/v1/configmaps?limit=5000'); return (d?.items || []).map(mapConfigMap) }
  async function fetchConfigMap(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps/${encodeURIComponent(name)}`); return d ? mapConfigMap(d) : null }
  async function fetchSecrets() { const d = await api.k8s('/api/v1/secrets?limit=5000'); return (d?.items || []).map(mapSecret) }
  async function fetchSecret(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`); return d ? mapSecret(d) : null }
  async function fetchIngresses() { const d = await api.k8s('/apis/networking.k8s.io/v1/ingresses?limit=1000'); return (d?.items || []).map(mapIngress) }
  async function fetchIngress(name, ns) { const d = await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`); return d ? mapIngress(d) : null }
  async function fetchNetworkPolicies() { const d = await api.k8s('/apis/networking.k8s.io/v1/networkpolicies?limit=5000'); return (d?.items || []).map(mapNetworkPolicy) }
  async function fetchNetworkPolicy(name, ns) { const d = await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/networkpolicies/${encodeURIComponent(name)}`); return d ? mapNetworkPolicy(d) : null }
  async function fetchPDBs() { const d = await api.k8s('/apis/policy/v1/poddisruptionbudgets?limit=5000'); return (d?.items || []).map(mapPDB) }
  async function fetchPDB(name, ns) { const d = await api.k8s(`/apis/policy/v1/namespaces/${encodeURIComponent(ns)}/poddisruptionbudgets/${encodeURIComponent(name)}`); return d ? mapPDB(d) : null }
  async function fetchLimitRanges() { const d = await api.k8s('/api/v1/limitranges?limit=5000'); return (d?.items || []).map(mapLimitRange) }
  async function fetchLimitRange(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/limitranges/${encodeURIComponent(name)}`); return d ? mapLimitRange(d) : null }
  async function fetchResourceQuotas() { const d = await api.k8s('/api/v1/resourcequotas?limit=5000'); return (d?.items || []).map(mapResourceQuota) }
  async function fetchResourceQuota(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/resourcequotas/${encodeURIComponent(name)}`); return d ? mapResourceQuota(d) : null }
  async function fetchHPAs() { const d = await api.k8s('/apis/autoscaling/v2/horizontalpodautoscalers?limit=5000'); return (d?.items || []).map(mapHPA) }
  async function fetchHPA(name, ns) { const d = await api.k8s(`/apis/autoscaling/v2/namespaces/${encodeURIComponent(ns)}/horizontalpodautoscalers/${encodeURIComponent(name)}`); return d ? mapHPA(d) : null }
  async function fetchEndpoints() { const d = await api.k8s('/api/v1/endpoints?limit=5000'); return (d?.items || []).map(mapEndpoints) }
  // 工作负载列表（deploy+sts+ds 三类合一；remote 模式与 hydrate 一致不含 job/cronjob，那些按需在详情页补）
  async function fetchWorkloads() {
    const [dep, sts, ds] = await Promise.all([
      api.k8s('/apis/apps/v1/deployments?limit=1000'),
      api.k8s('/apis/apps/v1/statefulsets?limit=1000'),
      api.k8s('/apis/apps/v1/daemonsets?limit=1000'),
    ])
    return [
      ...((dep?.items || []).map(i => mapWorkload(i, 'Deployment'))),
      ...((sts?.items || []).map(i => mapWorkload(i, 'StatefulSet'))),
      ...((ds?.items || []).map(i => mapWorkload(i, 'DaemonSet'))),
    ]
  }
  async function fetchPVCs() { const d = await api.k8s('/api/v1/persistentvolumeclaims?limit=5000'); return (d?.items || []).map(mapPVC) }
  async function fetchPVC(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims/${encodeURIComponent(name)}`); return d ? mapPVC(d) : null }
  async function fetchRoles() {
    const [roles, clusterRoles] = await Promise.all([
      api.k8s('/apis/rbac.authorization.k8s.io/v1/roles?limit=5000'),
      api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterroles?limit=5000'),
    ])
    return [
      ...((roles?.items || []).map(r => mapRole(r, 'Namespace'))),
      ...((clusterRoles?.items || []).map(r => mapRole(r, 'Cluster'))),
    ]
  }
  async function fetchRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
  async function fetchClusterRoleBindings() { const d = await api.k8s('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings?limit=5000'); return (d?.items || []).map(mapRoleBinding) }
  async function fetchServiceAccounts() { const d = await api.k8s('/api/v1/serviceaccounts?limit=5000'); return (d?.items || []).map(mapServiceAccount) }
  async function fetchRole(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Namespace') : null }
  async function fetchRoleBinding(name, ns) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/rolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
  async function fetchServiceAccount(name, ns) { const d = await api.k8s(`/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}`); return d ? mapServiceAccount(d) : null }
  async function fetchClusterRole(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`); return d ? mapRole(d, 'Cluster') : null }
  async function fetchClusterRoleBinding(name) { const d = await api.k8s(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${encodeURIComponent(name)}`); return d ? mapRoleBinding(d) : null }
  async function fetchRuntimeClasses() { const d = await api.k8s('/apis/node.k8s.io/v1/runtimeclasses?limit=5000'); return (d?.items || []).map(mapRuntimeClass) }
  async function fetchIngressClasses() { const d = await api.k8s('/apis/networking.k8s.io/v1/ingressclasses?limit=5000'); return (d?.items || []).map(mapIngressClass) }
  async function fetchPriorityClasses() { const d = await api.k8s('/apis/scheduling.k8s.io/v1/priorityclasses?limit=5000'); return (d?.items || []).map(mapPriorityClass) }
  async function fetchPriorityClass(name) { const d = await api.k8s(`/apis/scheduling.k8s.io/v1/priorityclasses/${encodeURIComponent(name)}`); return d ? mapPriorityClass(d) : null }

  // 轻量 metrics 刷新：只重拉 metrics.k8s.io nodes+pods → 就地更新现有 nodeList/podList 指标字段 → 重算集群汇总。
  // 供监控中心高频轮询；不重拉 nodes/pods 列表（结构不变）。失败静默（保留上次 metricsAvailable，下次全量 hydrate 纠正）。
  async function refreshMetrics() {
    if (!remoteMode.value) return
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
      for (const p of podList.value) {
        const m = metricsAvailable ? (podMetricMap.get(`${p.namespace}/${p.name}`) || null) : null
        p.usedCpu = m ? m.cpuMilli : null
        p.usedMem = m ? m.memKi : null
        p.cpu = p.usedCpu != null ? `${Math.round(p.usedCpu)}m/${Math.round(p.reqCpu)}m` : null
        p.memory = p.usedMem != null ? `${Math.round(p.usedMem / 1024)}Mi/${Math.round(p.reqMem / 1024)}Mi` : null
      }
      computeClusterMetrics(metricsAvailable)
    } catch { /* 静默：保留上次 metricsAvailable */ }
  }

  // === CRUD: NetworkPolicies ===
  async function addNetworkPolicy(np) {
    if (remoteMode.value) await remoteCreate(generateYAML('networkpolicy', np), `NetworkPolicy/${np.name}`, () => refetch('/apis/networking.k8s.io/v1/networkpolicies', networkPolicyList, mapNetworkPolicy))
    else networkPolicyList.value.push({ ...np, age: 'Just now' })
    invalidateResource('networkpolicies')
  }

  async function updateNetworkPolicy(name, ns, updates) {
    const idx = networkPolicyList.value.findIndex(n => n.name === name && n.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(networkPolicyList.value[idx]))
    networkPolicyList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('networkpolicy', networkPolicyList.value[idx]), 'NetworkPolicy', () => { networkPolicyList.value[idx] = before })
    invalidateResource('networkpolicies')
  }

  async function deleteNetworkPolicy(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/networkpolicies/${encodeURIComponent(name)}`, networkPolicyList, n => n.name === name && n.namespace === ns)
    } else {
      const idx = networkPolicyList.value.findIndex(n => n.name === name && n.namespace === ns)
      if (idx !== -1) networkPolicyList.value.splice(idx, 1)
    }
    invalidateResource('networkpolicies')
  }

  // === CRUD: HPAs ===
  async function addHPA(hpa) {
    if (remoteMode.value) await remoteCreate(generateYAML('hpa', hpa), `HPA/${hpa.name}`, () => refetch('/apis/autoscaling/v2/horizontalpodautoscalers', hpaList, mapHPA))
    else hpaList.value.push({ ...hpa, age: 'Just now' })
    invalidateResource('hpas')
  }

  async function updateHPA(name, ns, updates) {
    const idx = hpaList.value.findIndex(h => h.name === name && h.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(hpaList.value[idx]))
    hpaList.value[idx] = { ...before, ...updates }
    const patch = { spec: {
      minReplicas: updates.minReplicas ?? before.minReplicas,
      maxReplicas: updates.maxReplicas ?? before.maxReplicas,
      metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: updates.cpuTarget ?? before.cpuTarget } } },
        { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: updates.memoryTarget ?? before.memoryTarget } } },
      ],
    } }
    if (remoteMode.value) await remotePatch(`/apis/autoscaling/v2/namespaces/${encodeURIComponent(ns)}/horizontalpodautoscalers/${encodeURIComponent(name)}`, patch, 'HPA', () => { hpaList.value[idx] = before })
    invalidateResource('hpas')
  }

  async function deleteHPA(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/autoscaling/v2/namespaces/${encodeURIComponent(ns)}/horizontalpodautoscalers/${encodeURIComponent(name)}`, hpaList, h => h.name === name && h.namespace === ns)
    } else {
      const idx = hpaList.value.findIndex(h => h.name === name && h.namespace === ns)
      if (idx !== -1) hpaList.value.splice(idx, 1)
    }
    invalidateResource('hpas')
  }

  // === CRUD: ResourceQuotas ===
  async function addResourceQuota(rq) {
    if (remoteMode.value) await remoteCreate(generateYAML('resourcequota', rq), `ResourceQuota/${rq.name}`, () => refetch('/api/v1/resourcequotas', resourceQuotaList, mapResourceQuota))
    else resourceQuotaList.value.push({ ...rq, age: 'Just now' })
    invalidateResource('resourcequotas')
  }

  async function updateResourceQuota(name, ns, updates) {
    const idx = resourceQuotaList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(resourceQuotaList.value[idx]))
    resourceQuotaList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('resourcequota', resourceQuotaList.value[idx]), 'ResourceQuota', () => { resourceQuotaList.value[idx] = before })
    invalidateResource('resourcequotas')
  }

  async function deleteResourceQuota(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/resourcequotas/${encodeURIComponent(name)}`, resourceQuotaList, r => r.name === name && r.namespace === ns)
    } else {
      const idx = resourceQuotaList.value.findIndex(r => r.name === name && r.namespace === ns)
      if (idx !== -1) resourceQuotaList.value.splice(idx, 1)
    }
    invalidateResource('resourcequotas')
  }

  // === CRUD: LimitRanges ===
  async function addLimitRange(lr) {
    if (remoteMode.value) await remoteCreate(generateYAML('limitrange', lr), `LimitRange/${lr.name}`, () => refetch('/api/v1/limitranges', limitRangeList, mapLimitRange))
    else limitRangeList.value.push({ ...lr, age: 'Just now' })
    invalidateResource('limitranges')
  }

  async function updateLimitRange(name, ns, updates) {
    const idx = limitRangeList.value.findIndex(l => l.name === name && l.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(limitRangeList.value[idx]))
    limitRangeList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('limitrange', limitRangeList.value[idx]), 'LimitRange', () => { limitRangeList.value[idx] = before })
    invalidateResource('limitranges')
  }

  async function deleteLimitRange(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/limitranges/${encodeURIComponent(name)}`, limitRangeList, l => l.name === name && l.namespace === ns)
    } else {
      const idx = limitRangeList.value.findIndex(l => l.name === name && l.namespace === ns)
      if (idx !== -1) limitRangeList.value.splice(idx, 1)
    }
    invalidateResource('limitranges')
  }

  // === CRUD: RBAC ===
  async function addRole(role) {
    if (remoteMode.value) return remoteCreate(generateYAML('role', role), `${role.scope === 'Cluster' ? 'ClusterRole' : 'Role'}/${role.name}`, refetchRoles)
    roleList.value.push({ ...role, age: 'Just now' })
  }

  async function updateRole(name, ns, updates) {
    const idx = roleList.value.findIndex(r => r.name === name && (r.scope === 'Cluster' || r.namespace === ns))
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(roleList.value[idx]))
    roleList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('role', roleList.value[idx]), 'Role', () => { roleList.value[idx] = before })
  }

  async function deleteRole(name, ns) {
    const matchFn = r => r.name === name && (r.scope === 'Cluster' || r.namespace === ns)
    if (remoteMode.value) {
      const role = roleList.value.find(matchFn)
      const path = role?.scope === 'Cluster'
        ? `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`
        : `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles/${encodeURIComponent(name)}`
      await remoteDelete(path, roleList, matchFn)
      return
    }
    const idx = roleList.value.findIndex(matchFn)
    if (idx !== -1) roleList.value.splice(idx, 1)
  }

  async function addServiceAccount(sa) {
    if (remoteMode.value) return remoteCreate(generateYAML('serviceaccount', sa), `ServiceAccount/${sa.name}`, () => refetch('/api/v1/serviceaccounts', saList, mapServiceAccount))
    saList.value.push({ ...sa, age: 'Just now' })
  }

  async function updateServiceAccount(name, ns, updates) {
    const idx = saList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(saList.value[idx]))
    saList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('serviceaccount', saList.value[idx]), 'ServiceAccount', () => { saList.value[idx] = before })
  }

  async function deleteServiceAccount(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}`, saList, s => s.name === name && s.namespace === ns)
      return
    }
    const idx = saList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) saList.value.splice(idx, 1)
  }

  async function addRoleBinding(rb) {
    if (remoteMode.value) return remoteCreate(generateYAML('rolebinding', rb), `RoleBinding/${rb.name}`, () => refetch('/apis/rbac.authorization.k8s.io/v1/rolebindings', roleBindingList, mapRoleBinding))
    roleBindingList.value.push({ ...rb, age: 'Just now' })
    // Increment role bindings count
    const role = roleList.value.find(r => r.name === rb.roleName)
    if (role) role.bindings = (role.bindings || 0) + 1
  }

  async function updateRoleBinding(name, ns, updates) {
    const idx = roleBindingList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(roleBindingList.value[idx]))
    roleBindingList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('rolebinding', roleBindingList.value[idx]), 'RoleBinding', () => { roleBindingList.value[idx] = before })
  }

  async function deleteRoleBinding(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/rolebindings/${encodeURIComponent(name)}`, roleBindingList, r => r.name === name && r.namespace === ns)
      return
    }
    const rb = roleBindingList.value.find(r => r.name === name && r.namespace === ns)
    if (rb) {
      const role = roleList.value.find(r => r.name === rb.roleName)
      if (role) role.bindings = Math.max(0, (role.bindings || 0) - 1)
    }
    const idx = roleBindingList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx !== -1) roleBindingList.value.splice(idx, 1)
  }

  // === CRUD: ClusterRoleBindings（集群级）===
  function getClusterRoleByName(name) {
    return roleList.value.find(r => r.name === name && r.scope === 'Cluster')
  }
  function getClusterRoleBindingByName(name) {
    return clusterRoleBindingList.value.find(r => r.name === name)
  }

  async function addClusterRoleBinding(crb) {
    if (remoteMode.value) return remoteCreate(generateYAML('clusterrolebinding', crb), `ClusterRoleBinding/${crb.name}`, () => refetch('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', clusterRoleBindingList, mapRoleBinding))
    clusterRoleBindingList.value.push({ ...crb, age: 'Just now' })
  }

  function updateClusterRoleBinding(name, updates) {
    const idx = clusterRoleBindingList.value.findIndex(r => r.name === name)
    if (idx !== -1) clusterRoleBindingList.value[idx] = { ...clusterRoleBindingList.value[idx], ...updates }
  }

  async function deleteClusterRoleBinding(name) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${encodeURIComponent(name)}`, clusterRoleBindingList, r => r.name === name)
      return
    }
    const idx = clusterRoleBindingList.value.findIndex(r => r.name === name)
    if (idx !== -1) clusterRoleBindingList.value.splice(idx, 1)
  }

  // === CRUD: PodDisruptionBudget ===
  function getPDBByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return pdbList.value.find(p => p.name === name && p.namespace === namespace)
  }
  async function addPDB(pdb) {
    if (remoteMode.value) await remoteCreate(generateExtraYAML('pdb', pdb), `PDB/${pdb.name}`, () => refetch('/apis/policy/v1/poddisruptionbudgets', pdbList, mapPDB))
    else pdbList.value.push({ allowedDisruptions: 0, currentHealthy: 0, desiredHealthy: 0, ...pdb, age: 'Just now' })
    invalidateResource('pdbs')
  }
  async function updatePDB(name, ns, updates) {
    const idx = pdbList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx === -1) return
    const before = JSON.parse(JSON.stringify(pdbList.value[idx]))
    pdbList.value[idx] = { ...before, ...updates }
    if (remoteMode.value) await remoteUpdate(generateYAML('pdb', pdbList.value[idx]), 'PDB', () => { pdbList.value[idx] = before })
    invalidateResource('pdbs')
  }
  async function deletePDB(name, ns) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/policy/v1/namespaces/${encodeURIComponent(ns)}/poddisruptionbudgets/${encodeURIComponent(name)}`, pdbList, p => p.name === name && p.namespace === ns)
    } else {
      const idx = pdbList.value.findIndex(p => p.name === name && p.namespace === ns)
      if (idx !== -1) pdbList.value.splice(idx, 1)
    }
    invalidateResource('pdbs')
  }

  // === CRUD: PriorityClass（集群级）===
  function getPriorityClassByName(name) {
    return priorityClassList.value.find(p => p.name === name)
  }
  async function addPriorityClass(pc) {
    if (remoteMode.value) return remoteCreate(generateExtraYAML('priorityclass', pc), `PriorityClass/${pc.name}`, () => refetch('/apis/scheduling.k8s.io/v1/priorityclasses', priorityClassList, mapPriorityClass))
    priorityClassList.value.push({ ...pc, age: 'Just now' })
  }
  function updatePriorityClass(name, updates) {
    const idx = priorityClassList.value.findIndex(p => p.name === name)
    if (idx !== -1) priorityClassList.value[idx] = { ...priorityClassList.value[idx], ...updates }
  }
  async function deletePriorityClass(name) {
    if (remoteMode.value) {
      await remoteDelete(`/apis/scheduling.k8s.io/v1/priorityclasses/${encodeURIComponent(name)}`, priorityClassList, p => p.name === name)
      return
    }
    const idx = priorityClassList.value.findIndex(p => p.name === name)
    if (idx !== -1) priorityClassList.value.splice(idx, 1)
  }

  // === CRUD: Nodes ===
  async function cordonNode(name) {
    if (remoteMode.value) {
      await api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { unschedulable: true } }),
      })
    }
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = true
    invalidateResource('nodes')
  }

  async function uncordonNode(name) {
    if (remoteMode.value) {
      await api.k8s(`/api/v1/nodes/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ spec: { unschedulable: false } }),
      })
    }
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = false
    invalidateResource('nodes')
  }

  // Drain：cordon + 驱逐该节点上的业务 Pod（mock 模拟，保留系统命名空间 Pod）
  async function drainNode(name) {
    await cordonNode(name)
    if (remoteMode.value) {
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
      await hydrateCoreResources()
      return evictable.length
    }
    const systemNs = ['kube-system', 'kube-node-lease', 'kube-public']
    let count = 0
    for (let i = podList.value.length - 1; i >= 0; i--) {
      const p = podList.value[i]
      if (p.node === name && !systemNs.includes(p.namespace)) {
        podList.value.splice(i, 1)
        count++
      }
    }
    // 同步节点 pod 计数（podCount 由 recountNodePods 统一回填）
    recountNodePods()
    return count
  }

  // === CRUD: Namespaces ===
  async function addNamespace(ns) {
    if (typeof ns === 'string') ns = { name: ns, labels: {} }
    if (remoteMode.value) {
      const labelsYaml = ns.labels && Object.keys(ns.labels).length
        ? '\n  labels:\n' + Object.entries(ns.labels).map(([k, v]) => `    ${k}: ${yamlScalar(v)}`).join('\n')
        : ''
      const yaml = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns.name}${labelsYaml}`
      const refresh = () => refetch('/api/v1/namespaces', namespaceList, item => ({
        name: item.metadata?.name,
        status: item.status?.phase || 'Unknown',
        pods: podList.value.filter(p => p.namespace === item.metadata?.name).length,
        services: serviceList.value.filter(s => s.namespace === item.metadata?.name).length,
        age: ageOf(item.metadata?.creationTimestamp),
        labels: item.metadata?.labels || {},
      }))
      return remoteCreate(yaml, `Namespace/${ns.name}`, refresh)
    }
    if (!namespaceList.value.find(n => n.name === ns.name)) {
      namespaceList.value.push({ status: 'Active', pods: 0, services: 0, age: 'Just now', labels: {}, ...ns })
    }
  }

  async function deleteNamespace(name) {
    if (remoteMode.value) {
      await remoteDelete(`/api/v1/namespaces/${encodeURIComponent(name)}`, namespaceList, n => n.name === name)
      return
    }
    const idx = namespaceList.value.findIndex(n => n.name === name)
    if (idx !== -1) namespaceList.value.splice(idx, 1)
  }

  function updateNamespace(name, updates) {
    const idx = namespaceList.value.findIndex(n => n.name === name)
    if (idx !== -1) namespaceList.value[idx] = { ...namespaceList.value[idx], ...updates }
  }

  // === 多集群 ===
  // 切换活跃集群：写入该集群 token 为活跃 → 重新水合（后端 session 仍在内存中即可直接复用）
  async function switchCluster(apiServer) {
    const c = savedClusters.value.find(x => x.apiServer === apiServer)
    if (!c) return
    // 切集群前停止旧集群的实时监听并清空命名空间作用域，避免旧 ns 残留 / 旧 watch 带失效 token 报错
    try { stopPodWatch() } catch { /* 未启动时忽略 */ }
    try { stopEventWatch() } catch { /* 未启动时忽略 */ }
    currentNamespace.value = ''
    setActiveToken(c.token)
    activeApiServerRef.value = c.apiServer
    currentCluster.value = c.name
    cluster.value = { ...cluster.value, name: c.name, apiServer: c.apiServer, version: c.version, status: c.status || 'Healthy' }
    remoteMode.value = true
    connectionState.value = 'loading'
    clearMockSeeds()
    try { await hydrateCoreResources() } catch { connectionState.value = 'error' }
    apiReachable.value = true
    startHealthCheck()
  }
  // 移除已保存集群
  function removeSavedClusterStore(apiServer) {
    removeSavedCluster(apiServer)
    savedClusters.value = getSavedClusters()
  }

  // 远端连接时清空所有资源列表（mock 种子），随后由水合用真实集群数据回填
  function clearMockSeeds() {
    nodeList.value = []
    podList.value = []
    namespaceList.value = []
    workloadList.value = []
    serviceList.value = []
    ingressList.value = []
    eventList.value = []
    configMapList.value = []
    secretList.value = []
    pvcList.value = []
    pvList.value = []
    scList.value = []
    endpointsList.value = []
    ingressClassList.value = []
    runtimeClassList.value = []
    roleList.value = []
    saList.value = []
    roleBindingList.value = []
    clusterRoleBindingList.value = []
    networkPolicyList.value = []
    hpaList.value = []
    resourceQuotaList.value = []
    limitRangeList.value = []
    pdbList.value = []
    priorityClassList.value = []
    crdList.value = []
    stopEventWatch()
    eventWatchRv = ''
  }

  function setConnectedCluster(info) {
    remoteMode.value = true
    connectionState.value = 'loading'
    // 远端模式下清空 mock 种子：水合会用真实数据回填，避免失败时仍展示假数据
    clearMockSeeds()
    let name = info.name
    try { name = name || new URL(info.apiServer).hostname } catch { name = name || info.apiServer }
    // 持久化到「已保存集群」（多集群）：token 取当前活跃会话
    addSavedCluster({ name, apiServer: info.apiServer, token: getSessionToken(), version: info.version, authMethod: info.authMethod })
    savedClusters.value = getSavedClusters()
    activeApiServerRef.value = info.apiServer
    currentCluster.value = name
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

  const ageOf = timestamp => {
    if (!timestamp) return '—'
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
    return `${Math.floor(seconds / 86400)}d`
  }

  function mapNode(item, metric) {
    const ready = item.status?.conditions?.find(c => c.type === 'Ready')
    // allocatable 作为分母、metrics.k8s.io 用量作为分子；无 metric 时百分比返回 null，由视图降级展示「—」
    const allocCpu = cpuToMilli(item.status?.allocatable?.cpu)
    const allocMem = memToKi(item.status?.allocatable?.memory)
    const usedCpu = metric ? metric.cpuMilli : null
    const usedMem = metric ? metric.memKi : null
    const pct = (used, alloc) => (used != null && alloc > 0 ? Math.min(100, Math.round((used / alloc) * 100)) : null)
    const roleList = Object.keys(item.metadata?.labels || {}).filter(k => k.startsWith('node-role.kubernetes.io/')).map(k => k.split('/')[1])
    return {
      name: item.metadata?.name,
      status: ready?.status === 'True' ? 'Ready' : 'NotReady',
      roles: roleList.join(',') || 'worker',
      isControlPlane: roleList.some(r => r === 'control-plane' || r === 'master'),
      version: item.status?.nodeInfo?.kubeletVersion || '—',
      os: item.status?.nodeInfo?.osImage || '—',
      kernel: item.status?.nodeInfo?.kernelVersion || '—',
      ip: item.status?.addresses?.find(a => a.type === 'InternalIP')?.address || '—',
      age: ageOf(item.metadata?.creationTimestamp),
      unschedulable: Boolean(item.spec?.unschedulable),
      conditions: Object.fromEntries((item.status?.conditions || []).map(c => [c.type, c.status === 'True'])),
      cpu: pct(usedCpu, allocCpu),
      memory: pct(usedMem, allocMem),
      usedCpu, usedMem, allocCpu, allocMem,
      ...extractNodeExtra(item),
    }
  }

  // 按 pod.node 统计每个节点上的 Pod 数，回填到 nodeList（mock 种子与真实水合后都调用）
  function recountNodePods() {
    const counts = {}
    for (const p of podList.value) {
      const n = p.node
      if (n) counts[n] = (counts[n] || 0) + 1
    }
    nodeList.value = nodeList.value.map(n => ({ ...n, podCount: counts[n.name] || 0 }))
  }

  function mapPod(item, metric) {
    const statuses = item.status?.containerStatuses || []
    // request 取自容器 resources.requests（分母），用量取自 metrics.k8s.io（分子）
    const reqCpu = (item.spec?.containers || []).reduce((s, c) => s + cpuToMilli(c.resources?.requests?.cpu), 0)
    const reqMem = (item.spec?.containers || []).reduce((s, c) => s + memToKi(c.resources?.requests?.memory), 0)
    const usedCpu = metric ? metric.cpuMilli : null
    const usedMem = metric ? metric.memKi : null
    // 与 mock 保持一致格式 "124m/500m" / "182Mi/512Mi"；无用量时返回 null，视图降级展示
    const ratio = (used, total, fmt) => (used != null ? `${fmt(used)}/${fmt(total)}` : null)
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      status: item.status?.phase || 'Unknown',
      node: item.spec?.nodeName || '',
      ip: item.status?.podIP || '',
      restarts: statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0),
      age: ageOf(item.metadata?.creationTimestamp),
      containers: (item.spec?.containers || []).map(c => c.name),
      image: item.spec?.containers?.[0]?.image || '',
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      cpu: ratio(usedCpu, reqCpu, m => Math.round(m) + 'm'),
      memory: ratio(usedMem, reqMem, k => Math.round(k / 1024) + 'Mi'),
      usedCpu, usedMem, reqCpu, reqMem,
      // 保留原始对象：详情页需要 ownerReferences（关联 ReplicaSet/版本）、
      // status.conditions（生命周期）、status.containerStatuses（容器状态/重启/启动时间）
      raw: item,
    }
  }

  function mapWorkload(item, type) {
    const desired = item.spec?.replicas ?? (type === 'DaemonSet' ? item.status?.desiredNumberScheduled : 1)
    const ready = item.status?.readyReplicas ?? item.status?.numberReady ?? item.status?.availableReplicas ?? 0
    const image = item.spec?.template?.spec?.containers?.[0]?.image || ''
    const labels = item.metadata?.labels || {}
    const annotations = item.metadata?.annotations || {}
    // tier 由 layer.aliangboard.io label（权威）+ 名称/镜像启发式统一推导，与 useLayering 完全一致
    const tier = classifyResource({ name: item.metadata?.name, image, labels, annotations, type, kind: type })
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      type,
      tier,
      status: ready >= desired ? 'Running' : ready > 0 ? 'Degraded' : 'Pending',
      replicas: `${ready}/${desired}`,
      image,
      age: ageOf(item.metadata?.creationTimestamp),
      createdAt: item.metadata?.creationTimestamp,
      labels,
      annotations,
      raw: item,
    }
  }

  // 还原 Deployment 的滚动发布历史：每个 ReplicaSet 携带 deployment.kubernetes.io/revision 注解，
  // 其 pod template 即该 revision 的镜像/配置；当前 revision 取 Deployment 自身注解。
  // _template 保留完整模板，供 rollbackWorkload 执行真正的 rollout undo PATCH。
  function attachRolloutHistory(workloads, deploymentData, replicaSetData) {
    const rsByDeploy = new Map()
    for (const rs of (replicaSetData?.items || [])) {
      const owner = (rs.metadata?.ownerReferences || []).find(o => o.kind === 'Deployment' && o.controller)
      if (!owner) continue
      const key = `${rs.metadata.namespace}/${owner.name}`
      if (!rsByDeploy.has(key)) rsByDeploy.set(key, [])
      rsByDeploy.get(key).push(rs)
    }
    const findDeploy = (name, ns) => (deploymentData?.items || []).find(d => d.metadata?.name === name && d.metadata?.namespace === ns)
    for (const wl of workloads) {
      if (wl.type !== 'Deployment') {
        // StatefulSet/DaemonSet 历史走 ControllerRevision（暂未接入），仅展示当前版本
        wl.revisions = [{ rev: 1, image: wl.image, sha: wl.sha || '—', age: wl.age, current: true, reason: i18n.global.t('store.currentVersion') }]
        continue
      }
      const deploy = findDeploy(wl.name, wl.namespace)
      const curRev = deploy?.metadata?.annotations?.['deployment.kubernetes.io/revision'] || ''
      const rss = rsByDeploy.get(`${wl.namespace}/${wl.name}`) || []
      const revs = rss.map(rs => {
        const rev = Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision']) || 0
        return {
          rev,
          image: rs.spec?.template?.spec?.containers?.[0]?.image || wl.image,
          sha: String(rs.metadata?.uid || '').slice(0, 7) || String(rs.metadata?.name || '').split('-').pop() || '—',
          age: ageOf(rs.metadata?.creationTimestamp),
          reason: rs.metadata?.annotations?.['kubernetes.io/change-cause'] || (rev ? `revision ${rev}` : '—'),
          current: curRev ? String(rev) === String(curRev) : false,
          replicas: rs.status?.replicas ?? rs.spec?.replicas ?? 0,
          readyReplicas: rs.status?.readyReplicas ?? 0,
          desiredReplicas: rs.spec?.replicas ?? rs.status?.replicas ?? 0,
          rsName: rs.metadata?.name,
          rsUid: rs.metadata?.uid,
          _template: rs.spec?.template,
        }
      }).filter(r => r.rev > 0).sort((a, b) => b.rev - a.rev)
      wl.revisions = revs.length
        ? revs
        : [{ rev: Number(curRev) || 1, image: wl.image, sha: wl.sha || '—', age: wl.age, current: true, reason: i18n.global.t('store.currentVersion') }]
    }
  }

  // === Pod Watch：实时监听 Pod 变化（ADDED/MODIFIED/DELETED 增量更新 podList）===
  // 安全策略：从水合时的 resourceVersion 续接，只收变更事件；流断开或出错（含 RV 失效 410）即停，
  // 由 UI 提示用户手动恢复——不做自动重连，避免在不可控网络下产生重连风暴。
  function applyPodWatchEvent(evt) {
    if (!evt?.object) return
    const mapped = mapPod(evt.object, null)
    const list = podList.value
    const idx = list.findIndex(p => p.name === mapped.name && p.namespace === mapped.namespace)
    if (evt.type === 'DELETED') { if (idx !== -1) list.splice(idx, 1) }
    else if (idx !== -1) list[idx] = { ...list[idx], ...mapped }
    else list.push(mapped)
  }
  function startPodWatch() {
    if (!remoteMode.value || podWatchHandle) return
    const rv = podWatchRv || ''
    const path = `/api/v1/pods?watch=true${rv ? `&resourceVersion=${encodeURIComponent(rv)}` : ''}`
    podWatchLive.value = true
    podWatchHandle = k8sStream(path, {
      onMessage: line => {
        try {
          const evt = JSON.parse(line)
          if (evt.object?.metadata?.resourceVersion) podWatchRv = evt.object.metadata.resourceVersion
          applyPodWatchEvent(evt)
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

  // === Events 实时监听（watch）+ 按对象过滤 ===
  let eventWatchHandle = null
  let eventWatchRv = ''
  const eventWatchLive = ref(false)
  function applyEventWatchEvent(evt) {
    const mapped = mapEvent(evt.object)
    if (!mapped.uid) return
    const idx = eventList.value.findIndex(e => e.uid === mapped.uid)
    if (evt.type === 'DELETED') { if (idx !== -1) eventList.value.splice(idx, 1) }
    else if (idx !== -1) eventList.value[idx] = mapped
    else { eventList.value.unshift(mapped); if (eventList.value.length > 1000) eventList.value.length = 1000 }
  }
  function startEventWatch() {
    if (!remoteMode.value || eventWatchHandle) return
    const path = `/api/v1/events?watch=true${eventWatchRv ? `&resourceVersion=${encodeURIComponent(eventWatchRv)}` : ''}`
    eventWatchLive.value = true
    eventWatchHandle = k8sStream(path, {
      onMessage: line => {
        try {
          const evt = JSON.parse(line)
          if (evt.object?.metadata?.resourceVersion) eventWatchRv = evt.object.metadata.resourceVersion
          applyEventWatchEvent(evt)
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
  // 详情页用：返回关联到指定资源（involvedObject）的事件
  function eventsFor(kind, name, namespace) {
    return eventList.value.filter(e => e.relatedKind === kind && e.relatedName === name && (!namespace || e.relatedNamespace === namespace))
  }

  // === 远端资源映射（K8s API 对象 → 前端扁平结构，字段与 mock 保持一致）===
  // 视图按 mock 形状渲染，这里把真实集群返回的对象映射成相同结构，
  // 这样所有列表/详情页在远端模式下都能正确展示。
  const AM = { ReadWriteOnce: 'RWO', ReadWriteMany: 'RWM', ReadOnlyMany: 'ROM', ReadWriteOncePod: 'RWOP' }

  // Event 规范化：统一 type(小写)/time/icon/color，并从 involvedObject 抽出关联资源，供详情页按对象过滤与跳转
  function eventIconColor(type, reason) {
    const t = String(type || '').toLowerCase()
    if (t === 'warning') return { icon: 'warning', color: 'tertiary' }
    if (/fail|error|backoff|evict|unhealthy|deadline|exceed/i.test(reason || '')) return { icon: 'error', color: 'error' }
    if (/pull|creat|schedul|scal|start|bound|issu|updat|delet|read/i.test(reason || '')) return { icon: 'check_circle', color: 'primary' }
    return { icon: 'info', color: 'surface' }
  }
  function mapEvent(item) {
    const io = item.involvedObject || {}
    const ts = item.lastTimestamp || item.eventTime || item.metadata?.creationTimestamp
    const { icon, color } = eventIconColor(item.type, item.reason)
    return {
      uid: item.metadata?.uid || '',
      type: String(item.type || 'Normal').toLowerCase(),   // normal | warning
      reason: item.reason || '',
      message: item.message || '',
      count: item.count || 1,
      namespace: item.metadata?.namespace || io.namespace || '',
      time: ageOf(ts),
      age: ageOf(ts),
      icon, color,
      relatedKind: io.kind || '',
      relatedName: io.name || '',
      relatedNamespace: io.namespace || '',
      _ts: ts ? new Date(ts).getTime() : 0,
    }
  }
  const mapConfigMap = item => {
    const data = item.data || {}
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      keys: Object.keys(data).length,
      data,
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapSecret = item => {
    const data = item.data || {}
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      type: item.type || 'Opaque',
      keys: Object.keys(data).length,
      // K8s 返回的 data 已是 base64，与 store 内 Secret 语义一致（reveal 时再解码）
      data,
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapPVC = item => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    status: item.status?.phase || 'Pending',
    capacity: item.spec?.resources?.requests?.storage || item.status?.capacity?.storage || '—',
    accessModes: AM[item.spec?.accessModes?.[0]] || item.spec?.accessModes?.[0] || 'RWO',
    storageClass: item.spec?.storageClassName || '',
    volume: item.spec?.volumeName || '',
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapPV = item => {
    const claim = item.spec?.claimRef
    return {
      name: item.metadata?.name,
      capacity: item.spec?.capacity?.storage || '—',
      accessModes: AM[item.spec?.accessModes?.[0]] || item.spec?.accessModes?.[0] || 'RWO',
      reclaimPolicy: item.spec?.persistentVolumeReclaimPolicy || 'Retain',
      status: item.status?.phase || 'Available',
      claim: claim ? `${claim.namespace || 'default'}/${claim.name}` : '',
      storageClass: item.spec?.storageClassName || '',
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapStorageClass = item => {
    const ann = item.metadata?.annotations || {}
    const isDefault = ann['storageclass.kubernetes.io/is-default-class'] === 'true'
      || ann['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
    return {
      name: item.metadata?.name,
      provisioner: item.provisioner || '',
      parameters: Object.entries(item.parameters || {}).map(([k, v]) => `${k}=${v}`).join(','),
      reclaimPolicy: item.reclaimPolicy || 'Delete',
      default: isDefault,
      labels: item.metadata?.labels || {},
      annotations: ann,
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  // 从 Endpoints subsets 提取地址/端口/目标 Pod。addresses / notReadyAddresses 保留为 IP 字符串
  // （兼容列表展示与 YAML 导出）；targets 额外记录 ip→{podName,podNs}（来自 targetRef），
  // 供 Service 详情按名匹配 backing pod（比 IP 更可靠，避免 pod 未水合/格式差异时回退到手写卡片）。
  function extractEndpointSubsets(subsets) {
    const addresses = [], notReadyAddresses = [], ports = [], targets = {}
    ;(subsets || []).forEach(s => {
      const addTarget = a => { if (a.targetRef?.kind === 'Pod' && a.ip) targets[a.ip] = { podName: a.targetRef.name, podNs: a.targetRef.namespace } }
      ;(s.addresses || []).forEach(a => { if (!a.ip) return; addresses.push(a.ip); addTarget(a) })
      ;(s.notReadyAddresses || []).forEach(a => { if (!a.ip) return; notReadyAddresses.push(a.ip); addTarget(a) })
      ;(s.ports || []).forEach(p => ports.push({ port: p.port, protocol: p.protocol || 'TCP' }))
    })
    return { addresses, notReadyAddresses, ports, targets }
  }
  const mapEndpoints = item => {
    const { addresses, notReadyAddresses, ports, targets } = extractEndpointSubsets(item.subsets)
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      addresses, notReadyAddresses, ports, targets,
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapIngressClass = item => ({
    name: item.metadata?.name,
    controller: item.spec?.controller || '',
    isDefault: item.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapRuntimeClass = item => ({
    name: item.metadata?.name,
    handler: item.spec?.handler || '',
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapPriorityClass = item => ({
    name: item.metadata?.name,
    value: item.value,
    globalDefault: Boolean(item.globalDefault),
    description: item.description || '',
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapService = item => {
    const spec = item.spec || {}, status = item.status || {}
    const ports = spec.ports || []
    const lbIngress = (status.loadBalancer?.ingress || []).map(i => ({ ip: i.ip || '', hostname: i.hostname || '', ports: i.ports || [] })).filter(i => i.ip || i.hostname)
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      type: spec.type || 'ClusterIP',
      clusterIP: spec.clusterIP || 'None',
      clusterIPs: spec.clusterIPs || (spec.clusterIP ? [spec.clusterIP] : []),
      externalIP: lbIngress.length ? lbIngress.map(i => i.ip || i.hostname).join(',') : ((spec.externalIPs || []).join(',') || '-'),
      externalIPs: spec.externalIPs || [],
      externalName: spec.externalName || '',
      // 扁平端口字符串（generateYAML 无损回写仍读此字段，保持兼容）
      ports: ports.map(p => `${p.port}:${p.targetPort ?? p.port}/${p.protocol || 'TCP'}`).join(','),
      // 结构化端口（详情页表格用，含 nodePort / 名称，扁平字符串会丢失这些）
      portList: ports.map(p => ({ name: p.name || '', port: p.port, targetPort: p.targetPort ?? p.port, protocol: p.protocol || 'TCP', nodePort: p.nodePort || null, appProtocol: p.appProtocol || '' })),
      selector: spec.selector || {},
      sessionAffinity: spec.sessionAffinity || 'None',
      sessionAffinityTimeout: spec.sessionAffinityConfig?.clientIP?.timeoutSeconds,
      externalTrafficPolicy: spec.externalTrafficPolicy || '',
      internalTrafficPolicy: spec.internalTrafficPolicy || 'Cluster',
      ipFamilyPolicy: spec.ipFamilyPolicy || '',
      ipFamilies: spec.ipFamilies || [],
      publishNotReadyAddresses: !!spec.publishNotReadyAddresses,
      allocateLoadBalancerNodePorts: spec.allocateLoadBalancerNodePorts,
      loadBalancerClass: spec.loadBalancerClass || '',
      healthCheckNodePort: spec.healthCheckNodePort || null,
      lbIngress,
      lbIngressReady: lbIngress.length > 0,
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      // 保留原始对象：详情页 YAML 需完整 server 对象（clusterIP/labels 等），避免 SSA force apply 丢字段
      raw: item,
    }
  }
  const mapIngress = item => {
    const spec = item.spec || {}
    const dbs = spec.defaultBackend?.service
    const defaultBackend = dbs ? { serviceName: dbs.name || '', servicePort: String(dbs.port?.number ?? dbs.port?.name ?? '') } : null
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      className: spec.ingressClassName || '',
      hosts: (spec.rules || []).map(r => r.host).filter(Boolean).join(','),
      rules: spec.rules || [],
      defaultBackend,
      tls: Boolean(spec.tls?.length),
      tlsSecret: spec.tls?.[0]?.secretName || '',
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
    }
  }
  // canonical peer → mock peer（NetworkPolicy ingress/egress 的对端）
  const peerFromSpec = p => {
    if (p.ipBlock) return { type: 'ipBlock', cidr: p.ipBlock.cidr }
    if (p.namespaceSelector) return { type: 'namespaceSelector', matchLabels: p.namespaceSelector.matchLabels || {} }
    if (p.podSelector) return { type: 'podSelector', matchLabels: p.podSelector.matchLabels || {} }
    return { type: 'podSelector', matchLabels: {} }
  }
  const mapNetworkPolicy = item => {
    const spec = item.spec || {}
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      podSelector: spec.podSelector?.matchLabels || {},
      policyTypes: spec.policyTypes || [],
      ingressRules: (spec.ingress || []).map(r => ({ from: (r.from || []).map(peerFromSpec), ports: r.ports || [] })),
      egressRules: (spec.egress || []).map(r => ({ to: (r.to || []).map(peerFromSpec), ports: r.ports || [] })),
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapHPA = item => {
    const spec = item.spec || {}, status = item.status || {}
    const metrics = spec.metrics || []
    const cpu = metrics.find(m => m.resource?.name === 'cpu')
    const mem = metrics.find(m => m.resource?.name === 'memory')
    const curCpu = (status.currentMetrics || []).find(m => m.resource?.name === 'cpu')
    const curMem = (status.currentMetrics || []).find(m => m.resource?.name === 'memory')
    const limited = (status.conditions || []).some(c => c.type === 'ScalingLimited' && c.status === 'True')
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      targetName: spec.scaleTargetRef?.name || '',
      targetKind: spec.scaleTargetRef?.kind || 'Deployment',
      minReplicas: spec.minReplicas ?? 1,
      maxReplicas: spec.maxReplicas ?? 1,
      currentReplicas: status.currentReplicas ?? spec.minReplicas ?? 0,
      cpuTarget: cpu?.resource?.target?.averageUtilization,
      memoryTarget: mem?.resource?.target?.averageUtilization,
      currentCPU: curCpu?.resource?.current?.averageUtilization,
      currentMemory: curMem?.resource?.current?.averageUtilization,
      status: limited ? 'Limited' : (status.currentReplicas > (spec.minReplicas ?? 1) ? 'Scaling' : 'Ok'),
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapResourceQuota = item => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    hard: item.spec?.hard || {},
    used: item.status?.used || {},
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapLimitRange = item => {
    const l = (item.spec?.limits || []).find(x => x.type === 'Container') || item.spec?.limits?.[0] || {}
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      defaultCPU: l.default?.cpu,
      defaultMemory: l.default?.memory,
      defaultRequestCPU: l.defaultRequest?.cpu,
      defaultRequestMemory: l.defaultRequest?.memory,
      maxCPU: l.max?.cpu,
      maxMemory: l.max?.memory,
      minCPU: l.min?.cpu,
      minMemory: l.min?.memory,
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }
  const mapRole = (item, scope) => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace || '',
    scope,
    rules: item.rules || [],
    bindings: 0,
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapServiceAccount = item => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    age: ageOf(item.metadata?.creationTimestamp),
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
  })
  const mapRoleBinding = item => ({
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    roleName: item.roleRef?.name || '',
    roleKind: item.roleRef?.kind || 'Role',
    subjects: item.subjects || [],
    age: ageOf(item.metadata?.creationTimestamp),
  })
  const mapPDB = item => {
    const spec = item.spec || {}, status = item.status || {}
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      minAvailable: spec.minAvailable != null ? String(spec.minAvailable) : '',
      maxUnavailable: spec.maxUnavailable != null ? String(spec.maxUnavailable) : '',
      selector: spec.selector?.matchLabels || {},
      allowedDisruptions: status.disruptionsAllowed ?? 0,
      currentHealthy: status.currentHealthy ?? 0,
      desiredHealthy: status.desiredHealthy ?? 0,
      age: ageOf(item.metadata?.creationTimestamp),
    }
  }

  // 集群级 CPU/内存汇总（按 nodeList 的 used/alloc）+ 与上次对比的趋势 + cluster.value 更新。
  // 入参 metricsAvailable：调用前 nodeList/podList 的 metric 字段须已就绪
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
    cluster.value = {
      ...cluster.value,
      nodeCount: nodeList.value.length,
      podCount: podList.value.length,
      activeEvents: eventList.value.length,
      metricsAvailable,
      cpuUsage, memoryUsage,
      cpuTrend: cpuT.trend, cpuTrendUp: cpuT.up,
      memoryTrend: memT.trend, memoryTrendUp: memT.up,
    }
  }

  async function hydrateCoreResources(opts = {}) {
    if (!remoteMode.value) return
    if (!opts.silent) connectionState.value = 'loading'
    const requests = await Promise.allSettled([
      api.k8s('/api/v1/nodes'),
      api.k8s('/api/v1/pods?limit=1000'),
      api.k8s('/api/v1/namespaces'),
      api.k8s('/apis/apps/v1/deployments?limit=1000'),
      api.k8s('/apis/apps/v1/statefulsets?limit=1000'),
      api.k8s('/apis/apps/v1/daemonsets?limit=1000'),
      api.k8s('/apis/apps/v1/replicasets?limit=5000'),                    // 回滚历史：revision 注解
      api.k8s('/api/v1/services?limit=1000'),
      api.k8s('/apis/networking.k8s.io/v1/ingresses?limit=1000'),
      api.k8s('/api/v1/events?limit=1000'),
      api.k8s('/apis/metrics.k8s.io/v1beta1/nodes'),                      // 真实节点用量
      api.k8s('/apis/metrics.k8s.io/v1beta1/pods'),                       // 真实 Pod 用量
    ])
    const valueAt = index => requests[index].status === 'fulfilled' ? requests[index].value : null
    const nodeData = valueAt(0)
    if (!nodeData && remoteMode.value) notify('error', i18n.global.t('store.nodeFetchFailed'))
    const podData = valueAt(1)
    const namespaceData = valueAt(2)
    const deploymentData = valueAt(3)
    const statefulSetData = valueAt(4)
    const daemonSetData = valueAt(5)
    const replicaSetData = valueAt(6)
    const serviceData = valueAt(7)
    const ingressData = valueAt(8)
    const eventData = valueAt(9)
    const nodeMetricsData = valueAt(10)
    const podMetricsData = valueAt(11)

    // 指标（metrics-server）可能未安装或无 RBAC 权限——任一失败即整体降级为「不可用」
    const metricsAvailable = Boolean(nodeMetricsData && podMetricsData)
    const nodeMetricMap = new Map()
    for (const it of (nodeMetricsData?.items || [])) {
      nodeMetricMap.set(it.metadata?.name, { cpuMilli: cpuToMilli(it.usage?.cpu), memKi: memToKi(it.usage?.memory) })
    }
    const podMetricMap = new Map()
    for (const it of (podMetricsData?.items || [])) {
      let cpuMilli = 0, memKi = 0
      for (const c of (it.containers || [])) { cpuMilli += cpuToMilli(c.usage?.cpu); memKi += memToKi(c.usage?.memory) }
      podMetricMap.set(`${it.metadata?.namespace}/${it.metadata?.name}`, { cpuMilli, memKi })
    }
    const nodeMetric = name => (metricsAvailable ? (nodeMetricMap.get(name) || null) : null)
    const podMetric = (ns, name) => (metricsAvailable ? (podMetricMap.get(`${ns}/${name}`) || null) : null)

    if (!namespaceData) {
      if (!opts.silent) connectionState.value = 'error'
      const failure = requests[2].status === 'rejected' ? requests[2].reason : null
      throw new Error(failure?.message || i18n.global.t('store.namespaceReadFailed'))
    }
    if (nodeData?.items) nodeList.value = nodeData.items.map(item => mapNode(item, nodeMetric(item.metadata?.name)))
    if (podData?.items) {
      podList.value = podData.items.map(item => mapPod(item, podMetric(item.metadata?.namespace, item.metadata?.name)))
      // 记录 list 的 resourceVersion，供 Pod Watch 续接（只收此后变更）
      if (podData.metadata?.resourceVersion) podWatchRv = podData.metadata.resourceVersion
    }
    if (namespaceData?.items) namespaceList.value = namespaceData.items.map(item => ({
      name: item.metadata?.name,
      status: item.status?.phase || 'Unknown',
      pods: podList.value.filter(p => p.namespace === item.metadata?.name).length,
      services: serviceData?.items?.filter(s => s.metadata?.namespace === item.metadata?.name).length || 0,
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
    }))
    // 校验持久化的 currentNamespace：集群侧已删则回退到第一个存在的，避免空列表无提示
    if (currentNamespace.value && namespaceList.value.length
        && !namespaceList.value.some(n => n.name === currentNamespace.value)) {
      setNamespace(namespaceList.value[0].name)
    }
    if (deploymentData || statefulSetData || daemonSetData) {
      workloadList.value = [
        ...(deploymentData?.items || []).map(item => mapWorkload(item, 'Deployment')),
        ...(statefulSetData?.items || []).map(item => mapWorkload(item, 'StatefulSet')),
        ...(daemonSetData?.items || []).map(item => mapWorkload(item, 'DaemonSet')),
      ]
      // 真实回滚历史：按 ReplicaSet 的 revision 注解还原
      attachRolloutHistory(workloadList.value, deploymentData, replicaSetData)
    }
    if (serviceData?.items) serviceList.value = serviceData.items.map(mapService)
    if (ingressData?.items) ingressList.value = ingressData.items.map(mapIngress)
    if (eventData?.items) {
      eventList.value = eventData.items.map(mapEvent).sort((a, b) => (b._ts || 0) - (a._ts || 0))
      if (eventData.metadata?.resourceVersion) eventWatchRv = eventData.metadata.resourceVersion
    }
    // 集群级 CPU/内存：按节点用量 / allocatable 汇总；与上次水合对比得出趋势
    computeClusterMetrics(metricsAvailable)
    // 扩展资源（ConfigMap/Secret/PVC/PV/SC/RBAC/NetworkPolicy/HPA 等）拉取失败不应阻断登录
    // lite 模式（滚动发布自动刷新）：跳过较重的扩展资源（ConfigMap/Secret/RBAC 等），只更新运行态
    if (!opts.lite) {
      try { await hydrateExtendedResources() } catch (e) { console.warn('[hydrate] 扩展资源部分失败:', e?.message || e) }
    }
    if (!opts.silent) connectionState.value = 'connected'
    // CRD 及其实例可能较多，异步拉取不阻塞首屏
    hydrateCRDs().catch(e => console.warn('[hydrate] CRD 拉取失败:', e?.message || e))
    // nodeList 与 podList 均已水合，按 pod.node 回填 podCount
    recountNodePods()
    return { failed: requests.filter(r => r.status === 'rejected').length }
  }

  // 拉取所有非核心资源（集群范围 list，容忍 RBAC 403）。对应列表会被真实数据覆盖。
  // hydrate 后把已拉取的 store 列表预填进 Vue Query 缓存（canonical 列表 key），
  // 让迁移页挂载时命中缓存、不重复请求 hydrate 已拉过的数据（消除「hydrate 一遍 + query 一遍」双取）。
  function prefillQueryCache() {
    const cid = remoteMode.value ? (currentCluster.value || 'cluster') : 'demo'
    const map = {
      nodes: nodeList, workloads: workloadList, services: serviceList, ingresses: ingressList,
      configmaps: configMapList, secrets: secretList, networkpolicies: networkPolicyList,
      pvcs: pvcList, hpas: hpaList, pdbs: pdbList, limitranges: limitRangeList,
      resourcequotas: resourceQuotaList, endpoints: endpointsList,
    }
    for (const [res, listRef] of Object.entries(map)) {
      const list = listRef.value
      if (list && list.length) queryClient.setQueryData(['cluster', cid, res], list)
    }
  }

  async function hydrateExtendedResources() {
    if (!remoteMode.value) return
    const fetchers = {
      configmaps: () => api.k8s('/api/v1/configmaps?limit=5000'),
      secrets: () => api.k8s('/api/v1/secrets?limit=5000'),
      persistentvolumeclaims: () => api.k8s('/api/v1/persistentvolumeclaims?limit=5000'),
      endpoints: () => api.k8s('/api/v1/endpoints?limit=5000'),
      resourcequotas: () => api.k8s('/api/v1/resourcequotas?limit=5000'),
      limitranges: () => api.k8s('/api/v1/limitranges?limit=5000'),
      persistentvolumes: () => api.k8s('/api/v1/persistentvolumes?limit=5000'),
      networkpolicies: () => api.k8s('/apis/networking.k8s.io/v1/networkpolicies?limit=5000'),
      horizontalpodautoscalers: () => api.k8s('/apis/autoscaling/v2/horizontalpodautoscalers?limit=5000'),
      poddisruptionbudgets: () => api.k8s('/apis/policy/v1/poddisruptionbudgets?limit=5000'),
      storageclasses: () => api.k8s('/apis/storage.k8s.io/v1/storageclasses?limit=5000'),
    }
    const out = {}
    let failed = 0
    await Promise.all(Object.entries(fetchers).map(async ([k, fn]) => {
      try { out[k] = (await fn())?.items || [] } catch { out[k] = []; failed++ }
    }))
    configMapList.value = out.configmaps.map(mapConfigMap)
    secretList.value = out.secrets.map(mapSecret)
    pvcList.value = out.persistentvolumeclaims.map(mapPVC)
    endpointsList.value = out.endpoints.map(mapEndpoints)
    resourceQuotaList.value = out.resourcequotas.map(mapResourceQuota)
    limitRangeList.value = out.limitranges.map(mapLimitRange)
    pvList.value = out.persistentvolumes.map(mapPV)
    networkPolicyList.value = out.networkpolicies.map(mapNetworkPolicy)
    hpaList.value = out.horizontalpodautoscalers.map(mapHPA)
    pdbList.value = out.poddisruptionbudgets.map(mapPDB)
    scList.value = out.storageclasses.map(mapStorageClass)
    return { failed }
  }

  // 拉取 CRD 列表，并对每个 CRD 并发拉取其实例（容忍失败）
  async function hydrateCRDs() {
    if (!remoteMode.value) return
    let crdData
    try {
      crdData = await api.k8s('/apis/apiextensions.k8s.io/v1/customresourcedefinitions?limit=500')
    } catch {
      crdList.value = []
      return
    }
    const crds = (crdData.items || []).map(item => {
      const names = item.spec?.names || {}
      const versions = item.spec?.versions || []
      const served = versions.find(v => v.served && v.storage) || versions.find(v => v.served) || versions[0]
      return {
        name: item.metadata?.name,
        group: item.spec?.group || '',
        version: served?.name || '',
        kind: names.kind || '',
        scope: item.spec?.scope || 'Namespaced',
        namespaced: item.spec?.scope === 'Namespaced',
        description: names.list || names.kind || '',
        instances: [],
        _plural: names.plural || item.metadata?.name?.split('.')[0] || '',
      }
    })
    const results = await Promise.allSettled(crds.map(c => api.k8s(`/apis/${c.group}/${c.version}/${c._plural}?limit=500`)))
    crds.forEach((c, i) => {
      if (results[i].status === 'fulfilled') {
        c.instances = (results[i].value?.items || []).map(it => ({
          name: it.metadata?.name,
          namespace: it.metadata?.namespace || '',
          status: it.status?.phase || it.status?.conditions?.find(x => x.type === 'Ready')?.status || 'Ready',
          age: ageOf(it.metadata?.creationTimestamp),
          spec: it.spec,
          labels: it.metadata?.labels || {},
          annotations: it.metadata?.annotations || {},
        }))
      }
      delete c._plural
    })
    crdList.value = crds
  }

  function getCurrentCluster() {
    return clusterList.value.find(c => c.name === currentCluster.value) || clusterList.value[0]
  }

  // === CRD ===
  function getCRDByName(name) {
    return crdList.value.find(c => c.name === name)
  }

  // === 审计日志（按用户操作记录）===
  function logAudit(user, verb, resource, ns) {
    auditLogList.value.unshift({
      user, verb, resource, namespace: ns || '',
      time: 'Just now', timestamp: new Date().toISOString(),
      ip: '10.0.0.5', code: verb === 'delete' ? 204 : verb === 'create' ? 201 : 200,
    })
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
      const portSrc = (!isExtName && resource.portList?.length)
        ? resource.portList
        : (!isExtName ? String(resource.ports || '80:80/TCP').split(',').filter(Boolean).map(p => {
            const m = String(p).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/) || [, 80, 80, 'TCP']
            return { name: '', port: Number(m[1]) || 80, targetPort: isNaN(m[2]) ? m[2] : Number(m[2]), protocol: m[3] || 'TCP', nodePort: null, appProtocol: '' }
          }) : [])
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
        : (!isExtName ? `    app: ${name}` : '')
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
  name: ${name}
  namespace: ${ns}
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
      const tlsBlock = resource.tls ? `\n  tls:\n  - hosts:\n    - ${firstHost}\n    secretName: ${resource.tlsSecret || name + '-tls'}` : ''
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
  name: ${name}
  namespace: ${ns}${labelsYaml}${annYaml}
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
  name: ${name}
  namespace: ${ns}${metaExtra ? '\n' + metaExtra : ''}
data:
${dataEntries || '  {}'}`
    }

    if (type === 'secret') {
      // 展示为 stringData（明文）以便直接编辑；回写时由 applyResourceYaml 重新 base64 编码
      const dataEntries = resource.data
        ? Object.entries(resource.data).map(([k, v]) => `  ${k}: ${scalar(decodeBase64(v))}`).join('\n')
        : ''
      return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${ns}
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
  name: ${name}
  namespace: ${ns}
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
  name: ${name}
spec:
  capacity:
    storage: ${resource.capacity || '10Gi'}
  accessModes:
    - ${accessMode}
  persistentVolumeReclaimPolicy: ${resource.reclaimPolicy || 'Retain'}
  storageClassName: ${resource.storageClass || 'standard'}${claimRef}`
    }

    if (type === 'storageclass') {
      const paramMap = Object.fromEntries(
        String(resource.parameters || '').split(',').map(kv => kv.split('=')).filter(([k]) => k).map(([k, v]) => [k.trim(), (v || '').trim()])
      )
      const paramsYaml = Object.keys(paramMap).length
        ? Object.entries(paramMap).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : '    {}'
      return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${name}
provisioner: ${resource.provisioner || 'kubernetes.io/no-provisioner'}
reclaimPolicy: ${resource.reclaimPolicy || 'Delete'}
volumeBindingMode: WaitForFirstConsumer
parameters:
${paramsYaml}`
    }

    if (type === 'deployment') {
      const kind = resource.type || 'Deployment'
      const img = resource.image || 'nginx:latest'
      const desired = resource.replicas?.split('/')[1] || 1
      // Pod 模板（各工作负载共用）
      const podTemplate = `    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${resource.name}
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
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
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
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
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
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
spec:
  selector:
    matchLabels:
      app: ${name}
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
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
spec:
  replicas: ${desired}
  selector:
    matchLabels:
      app: ${name}
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
  name: ${name}
  namespace: ${ns}
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
  name: ${name}
  namespace: ${ns}
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
      const hardEntries = resource.hard ? Object.entries(resource.hard)
        .map(([k, v]) => `  ${k}: ${scalar(v)}`).join('\n') : ''
      const usedEntries = resource.used ? Object.entries(resource.used)
        .map(([k, v]) => `  ${k}: ${scalar(v)}`).join('\n') : ''
      return `apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${name}
  namespace: ${ns}
spec:
  hard:
${hardEntries || '  {}'}
status:
  hard:
${hardEntries || '  {}'}
  used:
${usedEntries || '  {}'}`
    }

    if (type === 'limitrange') {
      return `apiVersion: v1
kind: LimitRange
metadata:
  name: ${name}
  namespace: ${ns}
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
  name: ${name}
${resource.scope !== 'Cluster' ? `  namespace: ${ns}` : ''}
rules:
${resource.rules?.map(r => `- apiGroups: [${(r.apiGroups || ['']).map(g => `"${g}"`).join(', ')}]
  resources: [${(r.resources || []).map(r => `"${r}"`).join(', ')}]
  verbs: [${(r.verbs || []).map(v => `"${v}"`).join(', ')}]`).join('\n') || '- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]'}`
    }

    if (type === 'serviceaccount') {
      return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${name}
  namespace: ${ns}`
    }

    if (type === 'rolebinding') {
      return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${name}
  namespace: ${ns}
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
  name: ${name}
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
  name: ${name}${def}
spec:
  controller: ${resource.controller || 'k8s.io/ingress-nginx'}`
    }

    if (type === 'runtimeclass') {
      return `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: ${name}
spec:
  handler: ${resource.handler || 'runc'}`
    }

    if (type === 'endpoints') {
      const addresses = resource.addresses || []
      const notReady = resource.notReadyAddresses || []
      const ports = resource.ports || []
      const addrYaml = addresses.length ? addresses.map(a => `  - ip: ${a}`).join('\n') : '  []'
      const notReadyYaml = notReady.length ? `\n  notReadyAddresses:\n${notReady.map(a => `  - ip: ${a}`).join('\n')}` : ''
      const portsYaml = ports.length ? ports.map(p => `  - port: ${p.port}\n    protocol: ${p.protocol || 'TCP'}`).join('\n') : '  []'
      return `apiVersion: v1
kind: Endpoints
metadata:
  name: ${name}
  namespace: ${ns}
subsets:
- addresses:
${addrYaml}${notReadyYaml}
  ports:
${portsYaml}`
    }

    if (type === 'node') {
      return `apiVersion: v1
kind: Node
metadata:
  name: ${name}
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

    return `# YAML for ${type}/${name}`
  }

  // 单独的 YAML 生成（PDB / PriorityClass），避免破坏上面的逻辑
  function generateExtraYAML(type, resource) {
    if (!resource) return ''
    if (type === 'pdb') {
      const sel = resource.selector ? Object.entries(resource.selector).map(([k, v]) => `      ${k}: ${v}`).join('\n') : '      {}'
      return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${resource.name}
  namespace: ${resource.namespace}
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
  name: ${resource.name}
value: ${resource.value}
globalDefault: ${resource.globalDefault}
description: "${resource.description || ''}"`
    }
    return ''
  }

  // === 通用 YAML 应用（kubectl edit / apply 语义）===
  // 解析编辑后的 YAML → 按 kind 转换为 mock 扁平字段 → 调用对应 updateXxx。
  // 这样所有资源都具备与真实 K8s 一致的「编辑 YAML 即生效」能力。
  const ACCESS_MODE_TO_CODE = { ReadWriteOnce: 'RWO', ReadWriteMany: 'RWM', ReadOnlyMany: 'ROM', ReadWriteOncePod: 'RWOP' }
  const CODE_TO_ACCESS_MODE = { RWO: 'ReadWriteOnce', RWM: 'ReadWriteMany', ROM: 'ReadOnlyMany', RWOP: 'ReadWriteOncePod' }

  // canonical NetworkPolicy peer → mock peer 结构
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
    const c = crdList.value.find(x => x.name === crdName)
    if (!c) return
    const plural = c.name.split('.')[0]
    try {
      const data = await api.k8s(`/apis/${c.group}/${c.version}/${plural}?limit=500`)
      c.instances = (data.items || []).map(it => ({
        name: it.metadata?.name,
        namespace: it.metadata?.namespace || '',
        status: it.status?.phase || it.status?.conditions?.find(x => x.type === 'Ready')?.status || 'Ready',
        age: ageOf(it.metadata?.creationTimestamp),
        spec: it.spec,
        labels: it.metadata?.labels || {},
        annotations: it.metadata?.annotations || {},
      }))
    } catch { /* 无权限或不存在时静默 */ }
  }

  // 通用 CR apply（server-side apply，适用于任意 CRD kind）+ 局部刷新
  async function applyCRYaml(crdName, yamlStr) {
    if (!remoteMode.value) return { ok: false, error: i18n.global.t('store.onlyAvailableAfterConnect') }
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
    if (!remoteMode.value) return { ok: false, error: i18n.global.t('store.onlyAvailableAfterConnect') }
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
    if (remoteMode.value) {
      try {
        let object = null
        yamlLoadAll(yamlStr, document => { if (!object && document) object = document })
        const result = await api.applyYaml(yamlStr)
        const resource = result?.resources?.[0]
        await hydrateCoreResources()
        return {
          ok: true,
          kind: resource?.kind || object?.kind,
          name: resource?.metadata?.name || object?.metadata?.name,
          namespace: resource?.metadata?.namespace || object?.metadata?.namespace || '',
        }
      } catch (error) {
        return { ok: false, error: error.message || i18n.global.t('store.applyYamlFailed') }
      }
    }
    let obj
    try {
      obj = yamlLoad(yamlStr)
    } catch (e) {
      return { ok: false, error: i18n.global.t('store.yamlParseFailed', { msg: e.message || String(e) }) }
    }
    if (!obj || !obj.kind || !obj.metadata?.name) {
      return { ok: false, error: i18n.global.t('store.invalidYaml') }
    }
    const kind = obj.kind
    const name = obj.metadata.name
    const ns = obj.metadata.namespace || currentNamespace.value
    const labels = obj.metadata.labels
    const annotations = obj.metadata.annotations
    const spec = obj.spec || {}
    const updates = {}
    const set = (k, v) => { if (v !== undefined && v !== null) updates[k] = v }

    switch (kind) {
      case 'ConfigMap':
        if (obj.data !== undefined) { updates.data = obj.data || {}; updates.keys = Object.keys(updates.data).length }
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateConfigMap(name, ns, updates)
        break
      case 'Secret':
        // 优先 stringData（明文）；否则 data 为 base64，先解码再交给 updateSecret 重新编码，避免双重编码
        if (obj.stringData) updates.data = obj.stringData
        else if (obj.data) { const dec = {}; for (const k in obj.data) dec[k] = decodeBase64(obj.data[k]); updates.data = dec }
        set('type', obj.type)
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateSecret(name, ns, updates)
        break
      case 'Service':
        set('type', spec.type)
        if (spec.selector) updates.selector = spec.selector
        if (Array.isArray(spec.ports)) {
          updates.ports = spec.ports.map(p => {
            const port = p.port ?? ''
            const target = p.targetPort ?? p.port ?? ''
            const proto = p.protocol || 'TCP'
            return `${port}:${target}/${proto}`
          }).join(',')
        }
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateService(name, ns, updates)
        break
      case 'Ingress': {
        const rules = Array.isArray(spec.rules) ? spec.rules : []
        if (rules.length) {
          updates.rules = rules
          updates.hosts = rules.map(r => r.host).filter(Boolean).join(',')
          const first = rules[0]?.http?.paths?.[0]
          if (first) {
            set('path', first.path || '/')
            const be = first.backend?.service || first.backend
            if (be) set('backend', `${be.name}:${be.port?.number ?? be.port?.name ?? ''}`)
          }
        }
        if (Array.isArray(spec.tls)) { updates.tls = spec.tls.length > 0; updates.tlsSecret = spec.tls[0]?.secretName || '' }
        else if (spec.tls !== undefined) { updates.tls = false; updates.tlsSecret = '' }
        set('className', spec.ingressClassName)
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateIngress(name, ns, updates)
        break
      }
      case 'PersistentVolumeClaim':
        if (Array.isArray(spec.accessModes) && spec.accessModes.length) updates.accessModes = ACCESS_MODE_TO_CODE[spec.accessModes[0]] || spec.accessModes[0]
        set('capacity', spec.resources?.requests?.storage)
        if (spec.storageClassName !== undefined) updates.storageClass = spec.storageClassName || ''
        set('volume', spec.volumeName)
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updatePVC(name, ns, updates)
        break
      case 'NetworkPolicy':
        updates.podSelector = spec.podSelector?.matchLabels || {}
        if (Array.isArray(spec.policyTypes)) updates.policyTypes = spec.policyTypes
        updates.ingressRules = (spec.ingress || []).map(r => ({ from: (r.from || []).map(toPeer), ports: r.ports || [] }))
        updates.egressRules = (spec.egress || []).map(r => ({ to: (r.to || []).map(toPeer), ports: r.ports || [] }))
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateNetworkPolicy(name, ns, updates)
        break
      case 'HorizontalPodAutoscaler': {
        set('minReplicas', spec.minReplicas)
        set('maxReplicas', spec.maxReplicas)
        const metrics = spec.metrics || []
        const cpu = metrics.find(m => m.resource?.name === 'cpu')
        const mem = metrics.find(m => m.resource?.name === 'memory')
        if (cpu) set('cpuTarget', cpu.resource?.target?.averageUtilization)
        if (mem) set('memoryTarget', mem.resource?.target?.averageUtilization)
        updateHPA(name, ns, updates)
        break
      }
      case 'ResourceQuota':
        if (spec.hard) updateResourceQuota(name, ns, { hard: spec.hard })
        break
      case 'LimitRange': {
        const l = (spec.limits || []).find(x => x.type === 'Container') || spec.limits?.[0]
        if (l) {
          const pick = {
            defaultCPU: l.default?.cpu, defaultMemory: l.default?.memory,
            defaultRequestCPU: l.defaultRequest?.cpu, defaultRequestMemory: l.defaultRequest?.memory,
            maxCPU: l.max?.cpu, maxMemory: l.max?.memory,
            minCPU: l.min?.cpu, minMemory: l.min?.memory,
          }
          Object.keys(pick).forEach(k => pick[k] === undefined && delete pick[k])
          if (Object.keys(pick).length) updateLimitRange(name, ns, pick)
        }
        break
      }
      case 'Role':
      case 'ClusterRole':
        if (Array.isArray(obj.rules)) updateRole(name, ns, { rules: obj.rules })
        break
      case 'RoleBinding':
        if (obj.roleRef) { updates.roleName = obj.roleRef.name; updates.roleKind = obj.roleRef.kind }
        if (Array.isArray(obj.subjects)) updates.subjects = obj.subjects
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateRoleBinding(name, ns, updates)
        break
      case 'ClusterRoleBinding':
        if (obj.roleRef) { updates.roleName = obj.roleRef.name; updates.roleKind = obj.roleRef.kind }
        if (Array.isArray(obj.subjects)) updates.subjects = obj.subjects
        updateClusterRoleBinding(name, updates)
        break
      case 'ServiceAccount':
        if (Array.isArray(obj.imagePullSecrets)) updates.imagePullSecrets = obj.imagePullSecrets
        set('automountServiceAccountToken', obj.automountServiceAccountToken)
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateServiceAccount(name, ns, updates)
        break
      case 'Deployment':
      case 'StatefulSet':
      case 'DaemonSet':
      case 'Job':
      case 'CronJob': {
        const c = spec.template?.spec?.containers?.[0]
        if (c?.image) updates.image = c.image
        if (spec.replicas !== undefined) {
          const desired = parseInt(spec.replicas) || 1
          updates.replicas = `${desired}/${desired}`
        }
        if (kind === 'CronJob' && spec.schedule !== undefined) updates.schedule = spec.schedule
        if (labels) updates.labels = labels
        if (annotations) updates.annotations = annotations
        updateWorkload(name, ns, updates)
        break
      }
      case 'Namespace':
        if (labels) updateNamespace(name, { labels })
        break
      case 'PodDisruptionBudget': {
        const u = {}
        if (spec.minAvailable !== undefined) u.minAvailable = String(spec.minAvailable)
        if (spec.maxUnavailable !== undefined) u.maxUnavailable = String(spec.maxUnavailable)
        if (spec.selector?.matchLabels) u.selector = spec.selector.matchLabels
        if (Object.keys(u).length) updatePDB(name, ns, u)
        break
      }
      case 'PersistentVolume': {
        if (spec.capacity?.storage) updates.capacity = spec.capacity.storage
        if (Array.isArray(spec.accessModes) && spec.accessModes.length) updates.accessModes = ACCESS_MODE_TO_CODE[spec.accessModes[0]] || spec.accessModes[0]
        set('reclaimPolicy', spec.persistentVolumeReclaimPolicy)
        if (spec.storageClassName !== undefined) updates.storageClass = spec.storageClassName || ''
        if (spec.claimRef?.name) updates.claim = `${spec.claimRef.namespace || 'default'}/${spec.claimRef.name}`
        if (Object.keys(updates).length) updatePV(name, updates)
        break
      }
      case 'StorageClass': {
        set('provisioner', obj.provisioner)
        set('reclaimPolicy', obj.reclaimPolicy)
        if (obj.parameters) updates.parameters = Object.entries(obj.parameters).map(([k, v]) => `${k}=${v}`).join(',')
        if (Object.keys(updates).length) updateStorageClass(name, updates)
        break
      }
      case 'PriorityClass': {
        set('value', obj.value)
        set('globalDefault', obj.globalDefault)
        set('description', obj.description)
        if (Object.keys(updates).length) updatePriorityClass(name, updates)
        break
      }
      case 'Endpoints': {
        const { addresses, notReadyAddresses, ports, targets } = extractEndpointSubsets(Array.isArray(obj.subsets) ? obj.subsets : [])
        if (addresses.length) updates.addresses = addresses
        if (notReadyAddresses.length) updates.notReadyAddresses = notReadyAddresses
        if (ports.length) updates.ports = ports
        if (Object.keys(targets).length) updates.targets = targets
        if (labels) updates.labels = labels
        if (Object.keys(updates).length) updateEndpoints(name, ns, updates)
        break
      }
      case 'IngressClass': {
        set('controller', spec.controller)
        if (obj.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true') updates.isDefault = true
        if (Object.keys(updates).length) updateIngressClass(name, updates)
        break
      }
      case 'RuntimeClass': {
        set('handler', spec.handler)
        if (Object.keys(updates).length) updateRuntimeClass(name, updates)
        break
      }
      default: {
        // 自定义资源（CR）：按 kind 匹配 CRD，更新对应实例的 spec/labels/annotations
        const crd = crdList.value.find(c => c.kind === kind)
        if (crd) {
          const inst = (crd.instances || []).find(i => i.name === name && (!crd.namespaced || i.namespace === ns))
          if (inst) {
            if (obj.spec) inst.spec = obj.spec
            if (labels) inst.labels = labels
            if (annotations) inst.annotations = annotations
            return { ok: true, kind, name, namespace: ns }
          }
          return { ok: false, error: i18n.global.t('store.resourceNotFound', { kind, name }) }
        }
        return { ok: false, error: i18n.global.t('store.unsupportedYamlEdit', { kind }) }
      }
    }
    return { ok: true, kind, name, namespace: ns }
  }

  // === 端口转发（kubectl port-forward 语义）===
  // 远端：在网关主机开本地 TCP 监听转发到 Pod；演示数据模式：纯前端 mock。
  const portForwards = ref([])
  let pfIdSeq = 1
  async function addPortForward({ kind, name, namespace, port, localPort }) {
    if (remoteMode.value) {
      const fwd = await portForwardApi.create({ kind, name, namespace, port, localPort })
      const pf = { id: fwd.id, kind, name, namespace, port, pod: fwd.pod, targetPort: fwd.targetPort, localPort: fwd.localPort, host: fwd.host, status: 'Forwarding' }
      portForwards.value.push(pf)
      return pf
    }
    const lf = localPort || (7000 + portForwards.value.length * 7)
    const pf = { id: `mock-${pfIdSeq++}`, kind, name, namespace, port, localPort: lf, status: 'Forwarding' }
    portForwards.value.push(pf)
    return pf
  }
  async function removePortForward(id) {
    if (remoteMode.value && !String(id).startsWith('mock-')) {
      try { await portForwardApi.remove(id) } catch { /* 已停止或会话过期 */ }
    }
    const idx = portForwards.value.findIndex(p => p.id === id)
    if (idx !== -1) portForwards.value.splice(idx, 1)
  }
  async function refreshPortForwards() {
    if (!remoteMode.value) return
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
  // 判断该 subject 能否对指定 resource 执行指定 verb。纯前端基于 mock 数据推演。
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
    // 命名空间级 RoleBinding 仅在所属 ns 生效；ClusterRoleBinding 全局生效
    const bindings = [
      ...roleBindingList.value.filter(b => !namespace || b.namespace === namespace).map(b => ({ ...b, bindingKind: 'RoleBinding' })),
      ...clusterRoleBindingList.value.map(b => ({ ...b, bindingKind: 'ClusterRoleBinding' })),
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
      const role = roleList.value.find(r => r.name === b.roleName)
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

  // mock 种子：按 pod.node 回填 podCount（真实水合在 hydrateCoreResources 末尾再调一次）
  recountNodePods()

  return {
    // 基础数据
    cluster, nodeList, workloadList, podList, namespaceList, eventList,
    serviceList, ingressList, endpointsList, configMapList, secretList, pvList, pvcList,
    scList, ingressClassList, runtimeClassList, roleList, saList, logEntries, currentNamespace,
    networkPolicyList, hpaList, resourceQuotaList, limitRangeList, roleBindingList,
    clusterRoleBindingList, pdbList, priorityClassList,
    clusterList, savedClusters, auditLogList, crdList, currentCluster, remoteMode, connectionState,
    // 全局计算
    runningPods, pendingPods, failedPods, healthyNodes, totalNodes, clusterHealth, apiReachable,
    // Namespace 作用域计算
    nsWorkloads, nsPods, nsServices, nsIngress, nsEndpoints, nsConfigMaps, nsSecrets, nsContainerPorts, nsContainerPortGroups,
    nsPVCs, nsRoles, nsServiceAccounts, nsEvents, nsStats,
    nsTieredWorkloads, TIER_META, clusterRoles, nsPDBs,
    nsNetworkPolicies, nsHPAs, nsResourceQuotas, nsLimitRanges, nsRoleBindings,
    // Actions
    setNamespace, getWorkloadByName, fetchWorkload, getPodByName, getNodeByName, getNamespaceByName,
    getServiceByName, getIngressByName, getConfigMapByName, getSecretByName, getPVCByName,
    getNetworkPolicyByName, getHPAByName, getResourceQuotaByName, getLimitRangeByName,
    getRoleByName, getServiceAccountByName, getRoleBindingByName, getWorkloadPods,
    getResourceReferences, getWorkloadReferences,
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
    getPVByName, addPV, updatePV, deletePV, getSCByName, addStorageClass, updateStorageClass, deleteStorageClass,
    // CRUD: Endpoints
    getEndpointsByName, updateEndpoints,
    // CRUD: IngressClass / RuntimeClass（集群级）
    getIngressClassByName, addIngressClass, updateIngressClass, deleteIngressClass, getRuntimeClassByName, addRuntimeClass, updateRuntimeClass, deleteRuntimeClass,
    // CRUD: Workloads
    addWorkload, deleteWorkload, updateWorkload, applyWorkloadTemplate, updateWorkloadMeta, scaleWorkload, restartWorkload, rollbackWorkload, reassignLayer,
    // CRUD: Pods
    addPod, deletePod,
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
    getClusterRoleByName, getClusterRoleBindingByName, addClusterRoleBinding, updateClusterRoleBinding, deleteClusterRoleBinding,
    // CRUD: PDB
    getPDBByName, addPDB, updatePDB, deletePDB,
    // CRUD: PriorityClass
    getPriorityClassByName, addPriorityClass, updatePriorityClass, deletePriorityClass,
    // CRUD: Nodes
    cordonNode, uncordonNode, drainNode,
    // CRUD: Namespaces
    addNamespace, updateNamespace, deleteNamespace,
    // 多集群
    switchCluster, getCurrentCluster, setConnectedCluster, removeSavedClusterStore, hydrateCoreResources,
    // Pod 列表轻量刷新（删 Pod 后看重建）
    refreshPods,
    refreshEvents,
    fetchNodes,
    fetchServices, fetchConfigMaps, fetchSecrets, fetchIngresses, fetchNetworkPolicies,
    fetchConfigMap,
    fetchSecret,
    fetchService,
    fetchIngress,
    fetchNetworkPolicy, fetchPVC,
    fetchHPA, fetchResourceQuota, fetchLimitRange, fetchPDB,
    fetchNode,
    prefillQueryCache,
    fetchPDBs, fetchLimitRanges, fetchResourceQuotas, fetchHPAs, fetchEndpoints, fetchWorkloads, fetchPVCs, fetchRuntimeClasses, fetchIngressClasses, fetchPriorityClasses, fetchPriorityClass,
    fetchRoles, fetchRoleBindings, fetchClusterRoleBindings, fetchServiceAccounts,
    fetchRole, fetchRoleBinding, fetchServiceAccount, fetchClusterRole, fetchClusterRoleBinding,
    refreshMetrics,
    // Pod Watch（实时监听）
    podWatchLive, startPodWatch, stopPodWatch,
    eventWatchLive, startEventWatch, stopEventWatch, eventsFor,
    // CRD
    getCRDByName, crInstancePath, refreshCRDInstances, applyCRYaml, deleteCRInstance,
    // 审计
    logAudit,
    // YAML generation
    generateYAML, generateExtraYAML, generateCRYaml, applyResourceYaml,
    // 端口转发
    portForwards, addPortForward, removePortForward, refreshPortForwards,
    // RBAC 权限模拟
    checkAccess, checkAccessServer,
  }
})
