// 拓扑域纯函数(2026-09-01 拓扑整修;零 Vue/Pinia 依赖,单测 topology.test.mjs node --test)。
// 判定语义与 spec docs/superpowers/specs/2026-09-01-workload-topology-overhaul-design.md §2 一致。

// backend 名/端口提取(兼容 networking.k8s.io/v1 backend.service 与旧 beta backend.serviceName)
const backendNameOf = p => p?.backend?.service?.name ?? p?.backend?.serviceName ?? ''
const backendPortOf = p => p?.backend?.service?.port?.number ?? p?.backend?.service?.port?.name ?? p?.backend?.servicePort ?? ''

// A1:相关 Ingress → 本负载路由。只保留指向本负载 Service 的路径(defaultBackend 命中折算
// host:'*' 一条);指向其他应用的路径合并为 others [{name,count}]——入口不丢,但不冒充本负载流量。
export function filterOwnIngressRules(relatedIngresses, relatedServiceNames) {
  const ownRules = []
  const otherCounts = new Map() // name → {count, services:Set}(services 供合并行点名他人后端,入口可寻)
  for (const ing of relatedIngresses || []) {
    const db = ing?.defaultBackend
    if (db?.serviceName && relatedServiceNames.has(db.serviceName)) {
      ownRules.push({ ingress: ing.name, host: '*', path: '/', serviceName: db.serviceName, port: db.servicePort || '' })
    }
    for (const r of (ing?.rules || [])) {
      for (const p of (r.http?.paths || [])) {
        const name = backendNameOf(p)
        if (relatedServiceNames.has(name)) {
          ownRules.push({ ingress: ing.name, host: r.host || '*', path: p.path || '/', serviceName: name, port: backendPortOf(p) })
        } else {
          const e = otherCounts.get(ing?.name) || { count: 0, services: new Set() }
          e.count += 1
          if (name) e.services.add(name)
          otherCounts.set(ing?.name, e)
        }
      }
    }
  }
  return { ownRules, others: [...otherCounts].map(([name, e]) => ({ name, count: e.count, services: [...e.services] })) }
}

// C7:Service drift 两档。'broken'=已断(实际无匹配 Pod,或 Endpoints 就绪数为 0);
// 'pending-break'=滚动后将断(现有 Pod 仍匹配;endpoints 数据缺失(null)按保守档处理);
// null=selector 空或匹配模板(不失配)。值按字符串比较(标签本就是字符串)。
export function classifyServiceDrift(svc, tplLabels, actualPods, endpoints) {
  const sel = svc?.selector
  if (!sel || typeof sel !== 'object' || !Object.keys(sel).length) return null
  const subsetOf = labels => Object.entries(sel).every(([k, v]) => {
    const l = labels || {}
    return k in l && String(l[k]) === String(v)
  })
  if (subsetOf(tplLabels)) return null
  const matched = (actualPods || []).some(p => subsetOf(p?.labels))
  if (!matched) return 'broken'
  if (endpoints && endpoints.ready === 0) return 'broken'
  return 'pending-break'
}

// C1:Pod 按所属 RS 分组(pod.raw.metadata.ownerReferences 取 controller=true 的 ReplicaSet);
// 无 owner/RS 不在列 → ungrouped。组序随 replicaSets 入参序。
export function groupPodsByReplicaSet(pods, replicaSets) {
  const byName = new Map((replicaSets || []).map(rs2 => [rs2.name, rs2]))
  const groups = []
  const index = new Map()
  const ungrouped = []
  for (const p of pods || []) {
    const owner = (p?.raw?.metadata?.ownerReferences || []).find(o => o.kind === 'ReplicaSet' && o.controller)
    const rs2 = owner ? byName.get(owner.name) : null
    if (!rs2) { ungrouped.push(p); continue }
    if (!index.has(rs2.name)) {
      index.set(rs2.name, groups.length)
      groups.push({ rsName: rs2.name, ready: rs2.ready || 0, desired: rs2.desired ?? 0, pods: [] })
    }
    groups[index.get(rs2.name)].pods.push(p)
  }
  return { groups, ungrouped }
}

// A4:无 selector/无标签负载的 Pod 兜底归属。①边界收紧为 `${wlName}-`(杜绝 webcache 吞进
// web);②最长前缀让渡(存在更长负载名前缀时让给它,如 web → web-canary)。
export function podsByPrefixFallback(pods, wlName, allWorkloads) {
  if (!wlName) return []
  const prefix = `${wlName}-`
  const longer = (allWorkloads || [])
    .map(w => w?.name)
    .filter(n => n && n !== wlName && n.length > wlName.length && n.startsWith(prefix))
  return (pods || []).filter(p => p?.name?.startsWith(prefix) && !longer.some(n => p.name.startsWith(`${n}-`)))
}

// C4:Service 端点就绪计数(mapEndpoints 形状 {addresses[],notReadyAddresses[]})。未命中 → null。
export function endpointsForService(endpoints, svcName) {
  const ep = (endpoints || []).find(e => e?.name === svcName)
  if (!ep) return null
  const ready = (ep.addresses || []).length
  const notReady = (ep.notReadyAddresses || []).length
  return { ready, notReady, total: ready + notReady }
}

// C1:当前版本 RS = creationTimestamp 最新;其余 desired=0 且 ready=0 → 已淘汰(展示置灰)。
export function latestOwnedRs(replicaSets) {
  const list = replicaSets || []
  if (!list.length) return null
  return list.reduce((a, b) => (String(b?.raw?.metadata?.creationTimestamp || '') > String(a?.raw?.metadata?.creationTimestamp || '') ? b : a))
}
export function isRetiredRs(rs2, latest) {
  if (!latest || rs2?.name === latest.name) return false
  return (rs2?.desired ?? 0) === 0 && (rs2?.ready || 0) === 0
}

// C2:PVC 卷与 imagePullSecrets 提取(形状对齐 configRefs 的 {kind,name},供合并去重)。
export function volumesAndPullSecretsFromPodSpec(podSpec) {
  const out = []
  const seen = new Set()
  const add = (kind, name) => {
    if (!name) return
    const key = `${kind}/${name}`
    if (!seen.has(key)) { seen.add(key); out.push({ kind, name }) }
  }
  for (const vol of (podSpec?.volumes || [])) {
    if (vol?.persistentVolumeClaim?.claimName) add('PVC', vol.persistentVolumeClaim.claimName)
  }
  for (const s of (podSpec?.imagePullSecrets || [])) add('imagePullSecrets', s?.name)
  return out
}
