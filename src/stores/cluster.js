import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  clusterInfo, nodes, workloads, pods, namespaces, events,
  services, ingresses, configMaps, secrets, persistentVolumes,
  pvcs, storageClasses, roles, serviceAccounts, podLogs
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

  // === 当前选中的 Namespace ===
  const currentNamespace = ref('')

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
    return roleList.value.filter(r => r.namespace === currentNamespace.value || r.scope === 'Cluster')
  })

  const nsServiceAccounts = computed(() => {
    if (!currentNamespace.value) return []
    return saList.value.filter(s => s.namespace === currentNamespace.value)
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

  // === Actions ===
  function setNamespace(ns) {
    currentNamespace.value = ns
  }

  function getWorkloadByName(name) {
    return workloadList.value.find(w => w.name === name)
  }

  function getPodByName(name) {
    return podList.value.find(p => p.name === name)
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
      const dataEntries = resource.data ? Object.entries(resource.data)
        .map(([k, v]) => `  ${k}: "${v}"`).join('\n') : ''
      return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${name}
  namespace: ${ns}
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

    return `# YAML for ${type}/${name}`
  }

  return {
    // 基础数据
    cluster, nodeList, workloadList, podList, namespaceList, eventList,
    serviceList, ingressList, configMapList, secretList, pvList, pvcList,
    scList, roleList, saList, logEntries, currentNamespace,
    // 全局计算
    runningPods, pendingPods, failedPods, healthyNodes, totalNodes,
    // Namespace 作用域计算
    nsWorkloads, nsPods, nsServices, nsIngress, nsConfigMaps, nsSecrets,
    nsPVCs, nsRoles, nsServiceAccounts, nsEvents, nsStats,
    // Actions
    setNamespace, getWorkloadByName, getPodByName, getNodeByName, getNamespaceByName,
    getServiceByName, getIngressByName, getConfigMapByName, getSecretByName, getPVCByName,
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
    addWorkload, deleteWorkload,
    // YAML generation
    generateYAML,
  }
})
