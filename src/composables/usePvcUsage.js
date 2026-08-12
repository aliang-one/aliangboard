import { computed, unref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useClusterStore } from '@/stores/cluster'
import { api } from '@/api/client'
import { parseSizeToBytes } from '@/utils/bytes'

// 按 {podName, volumeName} 在 node 的卷清单里反查 claimName(无 pvcRef 时兜底)。
function lookupClaim(list, podName, volumeName) {
  if (!list) return null
  const hit = list.find(x => x.podName === podName && x.volumeName === volumeName)
  return hit ? hit.claimName : null
}

// 纯聚合:ns 内 pod↔PVC↔kubelet stats → 每 PVC 用量。注入 fetchers,可单测(不引 Vue)。
// deps.listPods(ns) → K8s podList {items:[{metadata:{name}, spec:{nodeName, volumes:[{name, persistentVolumeClaim:{claimName}}]}}]}
// deps.nodeStats(node) → kubelet {pods:[{podRef:{name}, volume:[{name, usedBytes, capacityBytes, pvcRef:{name,namespace}}]}]}
// deps.listPVCs?(ns) → PVC 列表(取 storageClassName + 申请容量,用于共享检测;可选)
// deps.listSCs?() → StorageClass 列表(取 provisioner,用于 NFS 检测;可选)
// 返回 { usage: Map<claimName, {usedBytes, capacityBytes, percent, mounted, shared}>, noStatsAccess }
export async function aggregatePvcUsage(ns, deps) {
  if (!ns) return { usage: new Map(), noStatsAccess: false }
  const podsRes = await deps.listPods(ns).catch(() => null)
  const pods = podsRes?.items || []

  // 共享存储检测所需的 PVC 申请容量 + storageClass provisioner(可选 deps;缺失则跳过该检测)
  const pvcItems = deps.listPVCs ? ((await deps.listPVCs(ns).catch(() => null))?.items || []) : []
  const scItems = deps.listSCs ? ((await deps.listSCs().catch(() => null))?.items || []) : []
  const scProvisioner = new Map(scItems.map(sc => [sc.metadata?.name, sc.provisioner || '']))
  const pvcRequested = new Map()     // claim → requestedBytes|null
  const pvcSC = new Map()            // claim → storageClassName
  for (const pvc of pvcItems) {
    const name = pvc.metadata?.name
    if (!name) continue
    pvcRequested.set(name, parseSizeToBytes(pvc.spec?.resources?.requests?.storage))
    pvcSC.set(name, pvc.spec?.storageClassName || '')
  }

  const claimsInNs = new Set()          // 该 ns 内被 pod 引用的 PVC claimName
  const byNode = new Map()              // node → [{podName, volumeName, claimName}]
  for (const pod of pods) {
    const node = pod.spec?.nodeName
    for (const vol of (pod.spec?.volumes || [])) {
      const claim = vol?.persistentVolumeClaim?.claimName
      if (!claim) continue
      claimsInNs.add(claim)
      if (!node) continue
      if (!byNode.has(node)) byNode.set(node, [])
      byNode.get(node).push({ podName: pod.metadata?.name, volumeName: vol.name, claimName: claim })
    }
  }
  const targetNodes = [...byNode.keys()]

  const statsResults = await Promise.all(targetNodes.map(n => deps.nodeStats(n).catch(() => null)))
  const raw = new Map()                 // claim → {usedBytes, capacityBytes}(取 max)
  let failures = 0
  statsResults.forEach((s, idx) => {
    if (!s || !Array.isArray(s.pods)) { failures++; return }
    const list = byNode.get(targetNodes[idx])
    for (const p of s.pods) {
      for (const vol of (p.volume || p.volumes || [])) {
        const claim = (vol?.pvcRef?.namespace === ns) ? vol.pvcRef.name : lookupClaim(list, p.podRef?.name, vol?.name)
        if (!claim || !claimsInNs.has(claim)) continue
        const used = Number(vol.usedBytes)
        const cap = Number(vol.capacityBytes)
        const prev = raw.get(claim)
        if (!prev) raw.set(claim, { usedBytes: used, capacityBytes: cap })
        else { if (used > prev.usedBytes) prev.usedBytes = used; if (cap > prev.capacityBytes) prev.capacityBytes = cap }
      }
    }
  })

  const usage = new Map()
  for (const claim of claimsInNs) {
    const u = raw.get(claim)
    const usedBytes = Number.isFinite(u?.usedBytes) ? u.usedBytes : null
    const capacityBytes = Number.isFinite(u?.capacityBytes) ? u.capacityBytes : null
    // 共享存储检测:NFS provisioner;或 kubelet capacityBytes 远大于 PVC 申请量(>4×,兜底非 NFS 的共享后端)
    const provisioner = scProvisioner.get(pvcSC.get(claim)) || ''
    const isNfs = /nfs/i.test(provisioner)
    const requested = pvcRequested.get(claim) ?? null
    const capInflate = !!(requested && capacityBytes && capacityBytes > requested * 4)
    const shared = isNfs || capInflate
    if (shared) {
      // 共享存储:kubelet 报的是后端总量,不是 per-PVC;置 null 避免误导
      usage.set(claim, { usedBytes: null, capacityBytes: null, percent: null, mounted: true, shared: true })
    } else {
      const percent = (usedBytes != null && capacityBytes) ? Math.round(usedBytes / capacityBytes * 100) : null
      usage.set(claim, { usedBytes, capacityBytes, percent, mounted: true, shared: false })   // 在 claimsInNs 即「有 pod 引用」→ mounted=true
    }
  }
  const noStatsAccess = targetNodes.length > 0 && failures === targetNodes.length
  return { usage, noStatsAccess }
}

// Vue Query 封装:列表与详情共用同一缓存(按 ns 去重)。data.value = { usage: Map, noStatsAccess }。
// 薄封装(queryFn=已测的 aggregate、key/path 显见),不单独写单测,其行为由列表/详情集成 + 手测担保。
export function usePvcUsage(namespace) {
  const store = useClusterStore()
  const cid = computed(() => store.currentCluster || 'cluster')
  const ns = computed(() => unref(namespace) || '')
  return useQuery({
    queryKey: computed(() => ['cluster', cid.value, 'pvc-usage', ns.value]),
    queryFn: () => aggregatePvcUsage(ns.value, {
      listPods: (n) => api.k8s(`/api/v1/namespaces/${encodeURIComponent(n)}/pods`),
      nodeStats: (node) => api.k8s(`/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`),
      listPVCs: (n) => api.k8s(`/api/v1/namespaces/${encodeURIComponent(n)}/persistentvolumeclaims`),
      listSCs: () => api.k8s('/apis/storage.k8s.io/v1/storageclasses'),
    }),
    enabled: computed(() => !!ns.value),
    refetchInterval: 60000,
    staleTime: 30000,
    retry: 1,
  })
}
