// 资源映射器（K8s API 对象 → 前端扁平结构）。从 cluster.js 抽出的纯函数。
import { classifyResource } from '@/composables/useLayering'
import { cpuToMilli, memToKi } from '@/composables/useResourceFormat'
import { extractNodeExtra } from '@/composables/useNodeFields'

export function encodeBase64(str) {
  try { return btoa(unescape(encodeURIComponent(String(str ?? '')))) }
  catch { return String(str ?? '') }
}
export function decodeBase64(str) {
  try { return decodeURIComponent(escape(atob(String(str ?? '')))) }
  catch { return String(str ?? '') }
}
export const encodeSecretData = (data) => {
  if (!data) return {}
  const out = {}
  for (const k in data) out[k] = encodeBase64(data[k])
  return out
}

export const ageOf = timestamp => {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function mapNode(item, metric) {
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

export function mapPod(item, metric) {
  const statuses = item.status?.containerStatuses || []
  const containers = item.spec?.containers || []
  // request/limit 取自容器 resources（分母候选），用量取自 metrics.k8s.io（分子）
  const reqCpu = containers.reduce((s, c) => s + cpuToMilli(c.resources?.requests?.cpu), 0)
  const reqMem = containers.reduce((s, c) => s + memToKi(c.resources?.requests?.memory), 0)
  const limCpu = containers.reduce((s, c) => s + cpuToMilli(c.resources?.limits?.cpu), 0)
  const limMem = containers.reduce((s, c) => s + memToKi(c.resources?.limits?.memory), 0)
  const usedCpu = metric ? metric.cpuMilli : null
  const usedMem = metric ? metric.memKi : null
  // 用量分母 = 容器上限：全部容器都设了 limits 才用 limits 总和（超限 throttle/OOMKill，是用量条的自然满格），
  // 否则（limits 未设/部分容器未设=无可信上限）回退 requests 承诺量。
  // 2026-09-01 修复：此前恒用 requests——req 512Mi / limit 2048Mi 用到 1024Mi 时 200% 封顶满格标红。
  const hasLimits = containers.length > 0 && containers.every(c => c.resources?.limits)
  const cpuTotal = hasLimits ? limCpu : reqCpu
  const memTotal = hasLimits ? limMem : reqMem
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
    containers: containers.map(c => c.name),
    image: item.spec?.containers?.[0]?.image || '',
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
    cpu: ratio(usedCpu, cpuTotal, m => Math.round(m) + 'm'),
    memory: ratio(usedMem, memTotal, k => Math.round(k / 1024) + 'Mi'),
    usedCpu, usedMem, reqCpu, reqMem, limCpu, limMem,
    // 保留原始对象：详情页需要 ownerReferences（关联 ReplicaSet/版本）、
    // status.conditions（生命周期）、status.containerStatuses（容器状态/重启/启动时间）
    raw: item,
  }
}

export function mapWorkload(item, type) {
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

// ReplicaSet(拓扑 RS 层,2026-09-01):ownerReferences 判定与「新/旧」排序走 raw。
export const mapReplicaSet = item => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace,
  desired: item.spec?.replicas ?? 0,
  ready: item.status?.readyReplicas || 0,
  hash: item.metadata?.labels?.['pod-template-hash'] || '',
  age: ageOf(item.metadata?.creationTimestamp),
  raw: item,
})

// === 远端资源映射（K8s API 对象 → 前端扁平结构，字段与 mock 保持一致）===
// 视图按 mock 形状渲染，这里把真实集群返回的对象映射成相同结构，
// 这样所有列表/详情页在远端模式下都能正确展示。
export const AM = { ReadWriteOnce: 'RWO', ReadWriteMany: 'RWM', ReadOnlyMany: 'ROM', ReadWriteOncePod: 'RWOP' }

// Event 规范化：统一 type(小写)/time/icon/color，并从 involvedObject 抽出关联资源，供详情页按对象过滤与跳转
export function eventIconColor(type, reason) {
  const t = String(type || '').toLowerCase()
  if (t === 'warning') return { icon: 'warning', color: 'tertiary' }
  if (/fail|error|backoff|evict|unhealthy|deadline|exceed/i.test(reason || '')) return { icon: 'error', color: 'error' }
  if (/pull|creat|schedul|scal|start|bound|issu|updat|delet|read/i.test(reason || '')) return { icon: 'check_circle', color: 'primary' }
  return { icon: 'info', color: 'surface' }
}
export function mapEvent(item) {
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
export const mapConfigMap = item => {
  const data = item.data || {}
  return {
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    keys: Object.keys(data).length,
    data,
    binaryKeys: Object.keys(item.binaryData || {}),   // 卷挂载键全集用(data∪binaryData)
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
    age: ageOf(item.metadata?.creationTimestamp),
  }
}
export const mapSecret = item => {
  const data = item.data || {}
  return {
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    type: item.type || 'Opaque',
    keys: Object.keys(data).length,
    // K8s 返回的 data 已是 base64，与 store 内 Secret 语义一致（reveal 时再解码）
    data,
    binaryKeys: Object.keys(item.binaryData || {}),   // 卷挂载键全集用(data∪binaryData)
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
    age: ageOf(item.metadata?.creationTimestamp),
  }
}
export const mapPVC = item => ({
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
export const mapPV = item => {
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
export const mapStorageClass = item => {
  const ann = item.metadata?.annotations || {}
  const isDefault = ann['storageclass.kubernetes.io/is-default-class'] === 'true'
    || ann['storageclass.beta.kubernetes.io/is-default-class'] === 'true'
  return {
    name: item.metadata?.name,
    provisioner: item.provisioner || '',
    parameters: Object.entries(item.parameters || {}).map(([k, v]) => `${k}=${v}`).join(','),
    reclaimPolicy: item.reclaimPolicy || 'Delete',
    volumeBindingMode: item.volumeBindingMode || 'WaitForFirstConsumer',
    default: isDefault,
    labels: item.metadata?.labels || {},
    annotations: ann,
    age: ageOf(item.metadata?.creationTimestamp),
  }
}
// 从 Endpoints subsets 提取地址/端口/目标 Pod。addresses / notReadyAddresses 保留为 IP 字符串
// （兼容列表展示与 YAML 导出）；targets 额外记录 ip→{podName,podNs}（来自 targetRef），
// 供 Service 详情按名匹配 backing pod（比 IP 更可靠，避免 pod 未水合/格式差异时回退到手写卡片）。
export function extractEndpointSubsets(subsets) {
  const addresses = [], notReadyAddresses = [], ports = [], targets = {}
  ;(subsets || []).forEach(s => {
    const addTarget = a => { if (a.targetRef?.kind === 'Pod' && a.ip) targets[a.ip] = { podName: a.targetRef.name, podNs: a.targetRef.namespace } }
    ;(s.addresses || []).forEach(a => { if (!a.ip) return; addresses.push(a.ip); addTarget(a) })
    ;(s.notReadyAddresses || []).forEach(a => { if (!a.ip) return; notReadyAddresses.push(a.ip); addTarget(a) })
    ;(s.ports || []).forEach(p => ports.push({ name: p.name || '', port: p.port, protocol: p.protocol || 'TCP' }))
  })
  return { addresses, notReadyAddresses, ports, targets }
}
export const mapEndpoints = item => {
  const { addresses, notReadyAddresses, ports, targets } = extractEndpointSubsets(item.subsets)
  return {
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    addresses, notReadyAddresses, ports, targets,
    age: ageOf(item.metadata?.creationTimestamp),
  }
}
export const mapIngressClass = item => ({
  name: item.metadata?.name,
  controller: item.spec?.controller || '',
  isDefault: item.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapRuntimeClass = item => ({
  name: item.metadata?.name,
  handler: item.spec?.handler || '',
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapPriorityClass = item => ({
  name: item.metadata?.name,
  value: item.value,
  globalDefault: Boolean(item.globalDefault),
  description: item.description || '',
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapService = item => {
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
export const mapIngress = item => {
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
export const peerFromSpec = p => {
  if (p.ipBlock) return { type: 'ipBlock', cidr: p.ipBlock.cidr }
  if (p.namespaceSelector) return { type: 'namespaceSelector', matchLabels: p.namespaceSelector.matchLabels || {} }
  if (p.podSelector) return { type: 'podSelector', matchLabels: p.podSelector.matchLabels || {} }
  return { type: 'podSelector', matchLabels: {} }
}
export const mapNetworkPolicy = item => {
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
export const mapHPA = item => {
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
export const mapResourceQuota = item => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace,
  hard: item.spec?.hard || {},
  used: item.status?.used || {},
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapLimitRange = item => {
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
export const mapRole = (item, scope) => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace || '',
  scope,
  rules: item.rules || [],
  bindings: 0,
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapServiceAccount = item => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace,
  age: ageOf(item.metadata?.creationTimestamp),
  labels: item.metadata?.labels || {},
  annotations: item.metadata?.annotations || {},
})
export const mapRoleBinding = item => ({
  name: item.metadata?.name,
  namespace: item.metadata?.namespace,
  roleName: item.roleRef?.name || '',
  roleKind: item.roleRef?.kind || 'Role',
  subjects: item.subjects || [],
  age: ageOf(item.metadata?.creationTimestamp),
})
export const mapPDB = item => {
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

// CRD 定义映射（抽自 hydrateCRDs；保留 _plural 供实例路径用）
export function mapCRD(item) {
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
}
// CR 实例映射（抽自 hydrateCRDs）
export function mapCRInstance(it) {
  return {
    name: it.metadata?.name,
    namespace: it.metadata?.namespace || '',
    status: it.status?.phase || it.status?.conditions?.find(x => x.type === 'Ready')?.status || 'Ready',
    age: ageOf(it.metadata?.creationTimestamp),
    spec: it.spec,
    labels: it.metadata?.labels || {},
    annotations: it.metadata?.annotations || {},
  }
}
