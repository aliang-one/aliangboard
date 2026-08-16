// workload「变更进行中」判定(纯函数,零依赖,node --test 直测)。
// 消费方:NsOverview 自适应轮询(useDeployFastPoll)+ healthOf 取数。
// 语义:进行中 = generation 未被观测(刚 apply/回滚)|| updated 未达 desired(滚动中)|| ready 未达 desired(扩容中)。
// 仅 Deployment/StatefulSet/DaemonSet 参与;Job/CronJob 与未知 kind 恒 false(范围外,后续可扩)。

const TRANSITIONING_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

export function workloadCounts(raw) {
  const st = raw?.status || {}
  const spec = raw?.spec || {}
  if (raw?.kind === 'DaemonSet') {
    const ready = st.numberReady ?? 0
    return { desired: st.desiredNumberScheduled ?? 0, updated: st.updatedNumberScheduled ?? 0, ready, total: st.currentNumberScheduled ?? ready }
  }
  const ready = st.readyReplicas ?? 0
  return { desired: spec.replicas ?? 1, updated: st.updatedReplicas ?? 0, ready, total: st.replicas ?? ready }
}

export function isWorkloadTransitioning(raw) {
  if (!raw || !TRANSITIONING_KINDS.has(raw.kind)) return false
  const { desired, updated, ready } = workloadCounts(raw)
  const gen = raw.metadata?.generation   // K8s 真实路径:metadata.generation
  if (gen != null && raw.status?.observedGeneration != null && gen > raw.status.observedGeneration) return true
  return updated < desired || ready < desired
}

export function anyWorkloadTransitioning(list) {
  for (const raw of list || []) if (isWorkloadTransitioning(raw)) return true
  return false
}
