import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { load as yamlLoad } from 'js-yaml'
import {
  clusterInfo, nodes, workloads, pods, namespaces, events,
  services, ingresses, configMaps, secrets, persistentVolumes,
  pvcs, storageClasses, roles, serviceAccounts, podLogs,
  networkPolicies, hpas, resourceQuotas, limitRanges, roleBindings,
  clusters, auditLogs, customResourceDefinitions, clusterRoleBindings,
  podDisruptionBudgets, priorityClasses
} from '@/mock/cluster'

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
  const podList = ref(pods)
  const namespaceList = ref(namespaces)
  const eventList = ref(events)
  const serviceList = ref(services)
  const ingressList = ref(ingresses)
  const configMapList = ref(configMaps)
  const secretList = ref(secrets.map(s => ({ ...s, data: encodeSecretData(s.data) })))
  const pvList = ref(persistentVolumes)
  const pvcList = ref(pvcs)
  const scList = ref(storageClasses)
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
  const clusterList = ref(clusters)
  const auditLogList = ref(auditLogs)
  const crdList = ref(customResourceDefinitions)
  const currentCluster = ref(clusters.find(c => c.current)?.name || clusters[0]?.name || '')

  // === 当前选中的 Namespace ===
  const currentNamespace = ref('')

  // === 微服务分层定义（对标 Kuboard tier）===
  const TIER_META = {
    web: { label: '表现层', en: 'Web', icon: 'web', color: 'primary', order: 0 },
    gateway: { label: '网关层', en: 'Gateway', icon: 'dns', color: 'secondary', order: 1 },
    svc: { label: '服务层', en: 'Service', icon: 'apps', color: 'tertiary', order: 2 },
    cloud: { label: '中间件层', en: 'Middleware', icon: 'cloud', color: 'tertiary', order: 3 },
    db: { label: '持久层', en: 'Database', icon: 'database', color: 'error', order: 4 },
    monitor: { label: '监控层', en: 'Monitor', icon: 'monitoring', color: 'secondary', order: 5 },
    default: { label: '默认层', en: 'Default', icon: 'workspaces', color: 'surface', order: 6 },
  }

  // === 全局计算属性 ===
  const runningPods = computed(() => podList.value.filter(p => p.status === 'Running').length)
  const pendingPods = computed(() => podList.value.filter(p => p.status === 'Pending').length)
  const failedPods = computed(() => podList.value.filter(p => p.status === 'Failed').length)
  const healthyNodes = computed(() => nodeList.value.filter(n => n.status === 'Ready').length)
  const totalNodes = computed(() => nodeList.value.length)

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

  const nsIngress = computed(() => {
    if (!currentNamespace.value) return []
    return ingressList.value.filter(s => s.namespace === currentNamespace.value)
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

  // 微服务分层拓扑：按 tier 分组当前 namespace 的 workloads
  const nsTieredWorkloads = computed(() => {
    if (!currentNamespace.value) return []
    const groups = {}
    nsWorkloads.value.forEach(w => {
      const tier = w.tier || 'default'
      if (!groups[tier]) groups[tier] = []
      groups[tier].push(w)
    })
    return Object.keys(TIER_META)
      .filter(t => groups[t] && groups[t].length)
      .sort((a, b) => TIER_META[a].order - TIER_META[b].order)
      .map(t => ({ tier: t, meta: TIER_META[t], workloads: groups[t] }))
  })

  // === Actions ===
  function setNamespace(ns) {
    currentNamespace.value = ns
  }

  function getWorkloadByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return workloadList.value.find(w => w.name === name && (!namespace || w.namespace === namespace))
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
    // Match pods by labels - find pods that share the workload's app label
    const appLabel = wl.labels?.app
    if (!appLabel) return podList.value.filter(p => p.namespace === namespace && p.name.startsWith(workloadName))
    return podList.value.filter(p => p.namespace === namespace && p.labels?.app === appLabel)
  }

  // 反查：哪些 workload 引用了指定的 ConfigMap / Secret
  // 返回 [{ workload, reference }]，按引用方式分组
  function getResourceReferences(kind, name, ns) {
    const namespace = ns || currentNamespace.value
    const results = []
    workloadList.value.forEach(w => {
      if (w.namespace !== namespace) return
      const matches = (w.references || []).filter(r => r.kind === kind && r.name === name)
      matches.forEach(reference => results.push({ workload: w, reference }))
    })
    return results
  }

  // 正查：某个 workload 引用了哪些 ConfigMap / Secret
  function getWorkloadReferences(workloadName, ns) {
    const namespace = ns || currentNamespace.value
    const wl = workloadList.value.find(w => w.name === workloadName && w.namespace === namespace)
    return wl?.references || []
  }

  // === CRUD: Services ===
  function addService(svc) {
    serviceList.value.push({ ...svc, age: 'Just now' })
    // Update namespace service count
    const ns = namespaceList.value.find(n => n.name === svc.namespace)
    if (ns) ns.services++
  }

  function updateService(name, ns, updates) {
    const idx = serviceList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) serviceList.value[idx] = { ...serviceList.value[idx], ...updates }
  }

  function deleteService(name, ns) {
    const idx = serviceList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) serviceList.value.splice(idx, 1)
    const nsObj = namespaceList.value.find(n => n.name === ns)
    if (nsObj) nsObj.services = Math.max(0, nsObj.services - 1)
  }

  // === CRUD: Ingress ===
  function addIngress(ing) {
    ingressList.value.push({ ...ing, age: 'Just now' })
  }

  function updateIngress(name, ns, updates) {
    const idx = ingressList.value.findIndex(i => i.name === name && i.namespace === ns)
    if (idx !== -1) ingressList.value[idx] = { ...ingressList.value[idx], ...updates }
  }

  function deleteIngress(name, ns) {
    const idx = ingressList.value.findIndex(i => i.name === name && i.namespace === ns)
    if (idx !== -1) ingressList.value.splice(idx, 1)
  }

  // === CRUD: ConfigMaps ===
  function addConfigMap(cm) {
    configMapList.value.push({ ...cm, age: 'Just now' })
  }

  function updateConfigMap(name, ns, updates) {
    const idx = configMapList.value.findIndex(c => c.name === name && c.namespace === ns)
    if (idx !== -1) configMapList.value[idx] = { ...configMapList.value[idx], ...updates }
  }

  function deleteConfigMap(name, ns) {
    const idx = configMapList.value.findIndex(c => c.name === name && c.namespace === ns)
    if (idx !== -1) configMapList.value.splice(idx, 1)
  }

  // === CRUD: Secrets ===
  function addSecret(sec) {
    secretList.value.push({ ...sec, data: encodeSecretData(sec.data), age: 'Just now' })
  }

  function updateSecret(name, ns, updates) {
    const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) {
      // data 来自表单（明文），统一编码后再入库
      const next = { ...updates }
      if (next.data) next.data = encodeSecretData(next.data)
      secretList.value[idx] = { ...secretList.value[idx], ...next }
    }
  }

  function deleteSecret(name, ns) {
    const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) secretList.value.splice(idx, 1)
  }

  // === CRUD: PVCs ===
  function addPVC(pvc) {
    pvcList.value.push({ ...pvc, age: 'Just now' })
  }

  function updatePVC(name, ns, updates) {
    const idx = pvcList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx !== -1) pvcList.value[idx] = { ...pvcList.value[idx], ...updates }
  }

  function deletePVC(name, ns) {
    const idx = pvcList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx !== -1) pvcList.value.splice(idx, 1)
  }

  // === CRUD: Workloads (for Deploy) ===
  function addWorkload(wl) {
    workloadList.value.push({ ...wl, age: 'Just now' })
    const ns = namespaceList.value.find(n => n.name === wl.namespace)
    if (ns) ns.pods += parseInt(wl.replicas?.split('/')[1] || '1')
  }

  function deleteWorkload(name, ns) {
    const idx = workloadList.value.findIndex(w => w.name === name && w.namespace === ns)
    if (idx !== -1) workloadList.value.splice(idx, 1)
  }

  function updateWorkload(name, ns, updates) {
    const idx = workloadList.value.findIndex(w => w.name === name && w.namespace === ns)
    if (idx !== -1) workloadList.value[idx] = { ...workloadList.value[idx], ...updates }
  }

  function scaleWorkload(name, ns, replicas) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (wl) {
      const current = parseInt(wl.replicas?.split('/')[1] || '1')
      wl.replicas = `${Math.min(replicas, current)}/${replicas}`
    }
  }

  function restartWorkload(name, ns) {
    const wl = workloadList.value.find(w => w.name === name && w.namespace === ns)
    if (wl) {
      wl.age = 'Just now'
      // Simulate restart by updating SHA
      const hash = Math.random().toString(16).substring(2, 9)
      wl.sha = `sha:${hash}`
    }
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

  function deletePod(name, ns) {
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

  // === CRUD: NetworkPolicies ===
  function addNetworkPolicy(np) {
    networkPolicyList.value.push({ ...np, age: 'Just now' })
  }

  function updateNetworkPolicy(name, ns, updates) {
    const idx = networkPolicyList.value.findIndex(n => n.name === name && n.namespace === ns)
    if (idx !== -1) networkPolicyList.value[idx] = { ...networkPolicyList.value[idx], ...updates }
  }

  function deleteNetworkPolicy(name, ns) {
    const idx = networkPolicyList.value.findIndex(n => n.name === name && n.namespace === ns)
    if (idx !== -1) networkPolicyList.value.splice(idx, 1)
  }

  // === CRUD: HPAs ===
  function addHPA(hpa) {
    hpaList.value.push({ ...hpa, age: 'Just now' })
  }

  function updateHPA(name, ns, updates) {
    const idx = hpaList.value.findIndex(h => h.name === name && h.namespace === ns)
    if (idx !== -1) hpaList.value[idx] = { ...hpaList.value[idx], ...updates }
  }

  function deleteHPA(name, ns) {
    const idx = hpaList.value.findIndex(h => h.name === name && h.namespace === ns)
    if (idx !== -1) hpaList.value.splice(idx, 1)
  }

  // === CRUD: ResourceQuotas ===
  function addResourceQuota(rq) {
    resourceQuotaList.value.push({ ...rq, age: 'Just now' })
  }

  function updateResourceQuota(name, ns, updates) {
    const idx = resourceQuotaList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx !== -1) resourceQuotaList.value[idx] = { ...resourceQuotaList.value[idx], ...updates }
  }

  function deleteResourceQuota(name, ns) {
    const idx = resourceQuotaList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx !== -1) resourceQuotaList.value.splice(idx, 1)
  }

  // === CRUD: LimitRanges ===
  function addLimitRange(lr) {
    limitRangeList.value.push({ ...lr, age: 'Just now' })
  }

  function updateLimitRange(name, ns, updates) {
    const idx = limitRangeList.value.findIndex(l => l.name === name && l.namespace === ns)
    if (idx !== -1) limitRangeList.value[idx] = { ...limitRangeList.value[idx], ...updates }
  }

  function deleteLimitRange(name, ns) {
    const idx = limitRangeList.value.findIndex(l => l.name === name && l.namespace === ns)
    if (idx !== -1) limitRangeList.value.splice(idx, 1)
  }

  // === CRUD: RBAC ===
  function addRole(role) {
    roleList.value.push({ ...role, age: 'Just now' })
  }

  function updateRole(name, ns, updates) {
    const idx = roleList.value.findIndex(r => r.name === name && (r.scope === 'Cluster' || r.namespace === ns))
    if (idx !== -1) roleList.value[idx] = { ...roleList.value[idx], ...updates }
  }

  function deleteRole(name, ns) {
    const idx = roleList.value.findIndex(r => r.name === name && (r.scope === 'Cluster' || r.namespace === ns))
    if (idx !== -1) roleList.value.splice(idx, 1)
  }

  function addServiceAccount(sa) {
    saList.value.push({ ...sa, age: 'Just now' })
  }

  function updateServiceAccount(name, ns, updates) {
    const idx = saList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) saList.value[idx] = { ...saList.value[idx], ...updates }
  }

  function deleteServiceAccount(name, ns) {
    const idx = saList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) saList.value.splice(idx, 1)
  }

  function addRoleBinding(rb) {
    roleBindingList.value.push({ ...rb, age: 'Just now' })
    // Increment role bindings count
    const role = roleList.value.find(r => r.name === rb.roleName)
    if (role) role.bindings = (role.bindings || 0) + 1
  }

  function updateRoleBinding(name, ns, updates) {
    const idx = roleBindingList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx !== -1) roleBindingList.value[idx] = { ...roleBindingList.value[idx], ...updates }
  }

  function deleteRoleBinding(name, ns) {
    const rb = roleBindingList.value.find(r => r.name === name && r.namespace === ns)
    if (rb) {
      const role = roleList.value.find(r => r.name === rb.roleName)
      if (role) role.bindings = Math.max(0, (role.bindings || 0) - 1)
    }
    const idx = roleBindingList.value.findIndex(r => r.name === name && r.namespace === ns)
    if (idx !== -1) roleBindingList.value.splice(idx, 1)
  }

  // === CRUD: ClusterRoleBindings（集群级）===
  function getClusterRoleBindingByName(name) {
    return clusterRoleBindingList.value.find(r => r.name === name)
  }

  function addClusterRoleBinding(crb) {
    clusterRoleBindingList.value.push({ ...crb, age: 'Just now' })
  }

  function updateClusterRoleBinding(name, updates) {
    const idx = clusterRoleBindingList.value.findIndex(r => r.name === name)
    if (idx !== -1) clusterRoleBindingList.value[idx] = { ...clusterRoleBindingList.value[idx], ...updates }
  }

  function deleteClusterRoleBinding(name) {
    const idx = clusterRoleBindingList.value.findIndex(r => r.name === name)
    if (idx !== -1) clusterRoleBindingList.value.splice(idx, 1)
  }

  // === CRUD: PodDisruptionBudget ===
  function getPDBByName(name, ns) {
    const namespace = ns || currentNamespace.value
    return pdbList.value.find(p => p.name === name && p.namespace === namespace)
  }
  function addPDB(pdb) {
    pdbList.value.push({ allowedDisruptions: 0, currentHealthy: 0, desiredHealthy: 0, ...pdb, age: 'Just now' })
  }
  function updatePDB(name, ns, updates) {
    const idx = pdbList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx !== -1) pdbList.value[idx] = { ...pdbList.value[idx], ...updates }
  }
  function deletePDB(name, ns) {
    const idx = pdbList.value.findIndex(p => p.name === name && p.namespace === ns)
    if (idx !== -1) pdbList.value.splice(idx, 1)
  }

  // === CRUD: PriorityClass（集群级）===
  function getPriorityClassByName(name) {
    return priorityClassList.value.find(p => p.name === name)
  }
  function addPriorityClass(pc) {
    priorityClassList.value.push({ ...pc, age: 'Just now' })
  }
  function updatePriorityClass(name, updates) {
    const idx = priorityClassList.value.findIndex(p => p.name === name)
    if (idx !== -1) priorityClassList.value[idx] = { ...priorityClassList.value[idx], ...updates }
  }
  function deletePriorityClass(name) {
    const idx = priorityClassList.value.findIndex(p => p.name === name)
    if (idx !== -1) priorityClassList.value.splice(idx, 1)
  }

  // === CRUD: Nodes ===
  function cordonNode(name) {
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = true
  }

  function uncordonNode(name) {
    const node = nodeList.value.find(n => n.name === name)
    if (node) node.unschedulable = false
  }

  // Drain：cordon + 驱逐该节点上的业务 Pod（mock 模拟，保留系统命名空间 Pod）
  function drainNode(name) {
    cordonNode(name)
    const systemNs = ['kube-system', 'kube-node-lease', 'kube-public']
    let count = 0
    for (let i = podList.value.length - 1; i >= 0; i--) {
      const p = podList.value[i]
      if (p.node === name && !systemNs.includes(p.namespace)) {
        podList.value.splice(i, 1)
        count++
      }
    }
    // 同步节点 pod 计数
    const node = nodeList.value.find(n => n.name === name)
    if (node && typeof node.pods === 'number') {
      node.pods = podList.value.filter(p => p.node === name).length
    }
    return count
  }

  // === CRUD: Namespaces ===
  function addNamespace(ns) {
    if (typeof ns === 'string') {
      ns = { name: ns, status: 'Active', pods: 0, services: 0, age: 'Just now', labels: {} }
    }
    if (!namespaceList.value.find(n => n.name === ns.name)) {
      namespaceList.value.push({ status: 'Active', pods: 0, services: 0, age: 'Just now', labels: {}, ...ns })
    }
  }

  function deleteNamespace(name) {
    const idx = namespaceList.value.findIndex(n => n.name === name)
    if (idx !== -1) namespaceList.value.splice(idx, 1)
  }

  function updateNamespace(name, updates) {
    const idx = namespaceList.value.findIndex(n => n.name === name)
    if (idx !== -1) namespaceList.value[idx] = { ...namespaceList.value[idx], ...updates }
  }

  // === 多集群 ===
  function switchCluster(name) {
    currentCluster.value = name
    const c = clusterList.value.find(c => c.name === name)
    if (c) {
      cluster.value = { ...cluster.value, name: c.name, version: c.version, apiServer: c.apiServer, status: c.status, nodeCount: c.nodeCount, podCount: c.podCount }
    }
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
    // ConfigMap data / Secret stringData 等任意用户值都应走它，避免 " 或换行破坏 YAML。
    const scalar = v => {
      const s = String(v ?? '')
      if (s.includes('\n')) return '|-\n' + s.split('\n').map(l => '      ' + l).join('\n')
      if (s === '' || /^\s|\s$/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s)) {
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      }
      return s
    }

    if (type === 'service') {
      // 从扁平 ports 字符串（如 "80:8080/TCP,443:8443/TCP"）还原多端口，保证回写无损
      const portsYaml = (resource.ports || '80:80/TCP').split(',').filter(Boolean).map(p => {
        const m = String(p).trim().match(/^(\d+)\s*:\s*([^/]+?)\s*\/?\s*(\w+)?$/) || [, 80, 80, 'TCP']
        const port = m[1]
        const target = m[2]
        const proto = m[3] || 'TCP'
        return `    - port: ${port}
      targetPort: ${isNaN(target) ? target : Number(target)}
      protocol: ${proto}`
      }).join('\n')
      const selEntries = resource.selector && Object.keys(resource.selector).length
        ? Object.entries(resource.selector).map(([k, v]) => `    ${k}: ${v}`).join('\n')
        : `    app: ${name}`
      const lbExtra = resource.type === 'LoadBalancer' ? '\n  externalTrafficPolicy: Cluster' : ''
      return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
spec:
  type: ${resource.type || 'ClusterIP'}
  selector:
${selEntries}
  ports:
${portsYaml}${lbExtra}`
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
        ? '\n  labels:\n' + Object.entries(resource.labels).map(([k, v]) => `    ${k}: "${v}"`).join('\n')
        : ''
      const annYaml = resource.annotations && Object.keys(resource.annotations).length
        ? '\n  annotations:\n' + Object.entries(resource.annotations).map(([k, v]) => `    ${k}: "${v}"`).join('\n')
        : ''
      return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${ns}${labelsYaml}${annYaml}
spec:
  ingressClassName: ${resource.className || 'nginx'}${tlsBlock}
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
        .map(([k, v]) => `  ${k}: "${v}"`).join('\n') : ''
      const usedEntries = resource.used ? Object.entries(resource.used)
        .map(([k, v]) => `  ${k}: "${v}"`).join('\n') : ''
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

  function applyResourceYaml(yamlStr) {
    let obj
    try {
      obj = yamlLoad(yamlStr)
    } catch (e) {
      return { ok: false, error: 'YAML 解析失败：' + (e.message || String(e)) }
    }
    if (!obj || !obj.kind || !obj.metadata?.name) {
      return { ok: false, error: '无效的 Kubernetes 资源 YAML（缺少 kind 或 metadata.name）' }
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
      default:
        return { ok: false, error: `暂不支持通过 YAML 编辑 ${kind}` }
    }
    return { ok: true, kind, name, namespace: ns }
  }

  return {
    // 基础数据
    cluster, nodeList, workloadList, podList, namespaceList, eventList,
    serviceList, ingressList, configMapList, secretList, pvList, pvcList,
    scList, roleList, saList, logEntries, currentNamespace,
    networkPolicyList, hpaList, resourceQuotaList, limitRangeList, roleBindingList,
    clusterRoleBindingList, pdbList, priorityClassList,
    clusterList, auditLogList, crdList, currentCluster,
    // 全局计算
    runningPods, pendingPods, failedPods, healthyNodes, totalNodes,
    // Namespace 作用域计算
    nsWorkloads, nsPods, nsServices, nsIngress, nsConfigMaps, nsSecrets,
    nsPVCs, nsRoles, nsServiceAccounts, nsEvents, nsStats,
    nsTieredWorkloads, TIER_META, clusterRoles, nsPDBs,
    nsNetworkPolicies, nsHPAs, nsResourceQuotas, nsLimitRanges, nsRoleBindings,
    // Actions
    setNamespace, getWorkloadByName, getPodByName, getNodeByName, getNamespaceByName,
    getServiceByName, getIngressByName, getConfigMapByName, getSecretByName, getPVCByName,
    getNetworkPolicyByName, getHPAByName, getResourceQuotaByName, getLimitRangeByName,
    getRoleByName, getServiceAccountByName, getRoleBindingByName, getWorkloadPods,
    getResourceReferences, getWorkloadReferences,
    // CRUD: Services
    addService, updateService, deleteService,
    // CRUD: Ingress
    addIngress, updateIngress, deleteIngress,
    // CRUD: ConfigMaps
    addConfigMap, updateConfigMap, deleteConfigMap,
    // CRUD: Secrets
    addSecret, updateSecret, deleteSecret,
    decodeBase64,
    // CRUD: PVCs
    addPVC, updatePVC, deletePVC,
    // CRUD: Workloads
    addWorkload, deleteWorkload, updateWorkload, scaleWorkload, restartWorkload,
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
    getClusterRoleBindingByName, addClusterRoleBinding, updateClusterRoleBinding, deleteClusterRoleBinding,
    // CRUD: PDB
    getPDBByName, addPDB, updatePDB, deletePDB,
    // CRUD: PriorityClass
    getPriorityClassByName, addPriorityClass, updatePriorityClass, deletePriorityClass,
    // CRUD: Nodes
    cordonNode, uncordonNode, drainNode,
    // CRUD: Namespaces
    addNamespace, updateNamespace, deleteNamespace,
    // 多集群
    switchCluster, getCurrentCluster,
    // CRD
    getCRDByName,
    // 审计
    logAudit,
    // YAML generation
    generateYAML, generateExtraYAML, applyResourceYaml,
  }
})
