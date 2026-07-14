import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  clusterInfo, nodes, workloads, pods, namespaces, events,
  services, ingresses, configMaps, secrets, persistentVolumes,
  pvcs, storageClasses, roles, serviceAccounts, podLogs,
  networkPolicies, hpas, resourceQuotas, limitRanges, roleBindings,
  clusters, auditLogs, customResourceDefinitions, clusterRoleBindings,
  podDisruptionBudgets, priorityClasses
} from '@/mock/cluster'

export const useClusterStore = defineStore('cluster', () => {
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
  const secretList = ref(secrets)
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
    secretList.value.push({ ...sec, age: 'Just now' })
  }

  function updateSecret(name, ns, updates) {
    const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) secretList.value[idx] = { ...secretList.value[idx], ...updates }
  }

  function deleteSecret(name, ns) {
    const idx = secretList.value.findIndex(s => s.name === name && s.namespace === ns)
    if (idx !== -1) secretList.value.splice(idx, 1)
  }

  // === CRUD: PVCs ===
  function addPVC(pvc) {
    pvcList.value.push({ ...pvc, age: 'Just now' })
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
  function addClusterRoleBinding(crb) {
    clusterRoleBindingList.value.push({ ...crb, age: 'Just now' })
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

    if (type === 'service') {
      return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${resource.selector?.app || name}
spec:
  type: ${resource.type || 'ClusterIP'}
  selector:
    app: ${resource.selector?.app || name}
  ports:
    - port: ${resource.ports?.split(':')[0] || 80}
      targetPort: ${resource.ports?.split(/[:/]/)[1] || 8080}
      protocol: TCP
  ${resource.type === 'LoadBalancer' ? 'externalTrafficPolicy: Cluster\n  allocateLoadBalancerNodePorts: true' : ''}`
    }

    if (type === 'ingress') {
      return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${ns}
  annotations:
    kubernetes.io/ingress.class: nginx
    ${resource.tls ? 'cert-manager.io/cluster-issuer: letsencrypt-prod' : ''}
spec:
  ${resource.tls ? `tls:
  - hosts:
    - ${resource.hosts}
    secretName: ${name}-tls` : ''}
  rules:
  - host: ${resource.hosts}
    http:
      paths:
      - path: ${resource.path || '/'}
        pathType: Prefix
        backend:
          service:
            name: ${resource.backend?.split(':')[0] || name + '-svc'}
            port:
              number: ${resource.backend?.split(':')[1] || 80}`
    }

    if (type === 'configmap') {
      const scalar = v => {
        const s = String(v ?? '')
        if (s.includes('\n')) return '|-\n' + s.split('\n').map(l => '      ' + l).join('\n')
        if (s === '' || /^\s|\s$/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s)) {
          return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
        }
        return s
      }
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
        .map(([k, v]) => `  ${k}: "${v}"`).join('\n') : ''
      return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${ns}${metaExtra ? '\n' + metaExtra : ''}
data:
${dataEntries || '  {}'}`
    }

    if (type === 'secret') {
      return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${ns}
type: ${resource.type || 'Opaque'}
data:
  # Base64-encoded values (hidden for security)
  ${resource.data ? Object.keys(resource.data).map(k => k + ': "***"').join('\n  ') : '{}'}`
    }

    if (type === 'pvc') {
      return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}
  namespace: ${ns}
spec:
  accessModes:
    - ${resource.accessModes || 'ReadWriteOnce'}
  resources:
    requests:
      storage: ${resource.capacity || '10Gi'}
  storageClassName: ${resource.storageClass || 'standard'}`
    }

    if (type === 'deployment') {
      return `apiVersion: apps/v1
kind: ${resource.type || 'Deployment'}
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
spec:
  replicas: ${resource.replicas?.split('/')[1] || 1}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: ${resource.name}
        image: ${resource.image || 'nginx:latest'}
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi`
    }

    if (type === 'networkpolicy') {
      const ingressRules = resource.ingressRules?.length
        ? resource.ingressRules.map(r => `    - from:
${(r.from || []).map(f => `      - ${f.type || 'podSelector'}:
${f.matchLabels ? `          matchLabels:\n${Object.entries(f.matchLabels).map(([k,v]) => `            ${k}: ${v}`).join('\n')}` : `{}`}`).join('\n')}`).join('\n')
        : '    []'
      const egressRules = resource.egressRules?.length
        ? resource.egressRules.map(r => `    - to:
${(r.to || []).map(f => `      - ${f.type || 'podSelector'}:
${f.matchLabels ? `          matchLabels:\n${Object.entries(f.matchLabels).map(([k,v]) => `            ${k}: ${v}`).join('\n')}` : `{}`}`).join('\n')}`).join('\n')
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
        averageUtilization: ${resource.cpuTarget || 80}`
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
      memory: "${resource.maxMemory || '4Gi'}"`
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
    // CRUD: PVCs
    addPVC, deletePVC,
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
    addRole, updateRole, deleteRole, addServiceAccount, deleteServiceAccount,
    addRoleBinding, deleteRoleBinding,
    // CRUD: ClusterRoleBindings
    addClusterRoleBinding, deleteClusterRoleBinding,
    // CRUD: PDB
    getPDBByName, addPDB, updatePDB, deletePDB,
    // CRUD: PriorityClass
    getPriorityClassByName, addPriorityClass, deletePriorityClass,
    // CRUD: Nodes
    cordonNode, uncordonNode, drainNode,
    // CRUD: Namespaces
    addNamespace, deleteNamespace,
    // 多集群
    switchCluster, getCurrentCluster,
    // CRD
    getCRDByName,
    // 审计
    logAudit,
    // YAML generation
    generateYAML, generateExtraYAML,
  }
})
