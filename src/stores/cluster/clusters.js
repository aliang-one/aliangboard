// cluster store · 多集群域(Plan 5 第二波,2026-08-28):switchCluster/removeSavedClusterStore/
// setConnectedCluster(localStorage 集群登记簿与平台集群收敛)+ 端口转发(kubectl port-forward 语义)。
// 自 cluster.js 逐字搬迁;依赖显式注入;store 公开名不变。
import { ref } from 'vue'
import { api, portForwardApi, getSavedClusters, addSavedCluster, removeSavedCluster, setActiveToken, getSessionToken } from '@/api/client'
import { queryClient } from '@/queryClient'

export function createClustersDomain({ cluster, activeApiServerRef, apiReachable, connectionState, currentCluster, currentNamespace, savedClusters, hydrateCriticalResources, startWorkloadFamilyWatch, stopWorkloadFamilyWatch, startHealthCheck, setMetricsHold, metricsReloadWindow: metricsReloadWindow }) {
  // === 多集群 ===
  // 切换活跃集群：写入该集群 token 为活跃 → 重新水合（后端 session 仍在内存中即可直接复用）
  async function switchCluster(apiServer) {
    const c = savedClusters.value.find(x => x.apiServer === apiServer)
    if (!c) return
    setMetricsHold(true)   // 水合期间挂起 tick(变体 B);try/finally 必清,不会永久卡死采样
    try {
      // 切集群前停止旧集群的实时监听并清空命名空间作用域，避免旧 ns 残留 / 旧 watch 带失效 token 报错
      try { stopWorkloadFamilyWatch() } catch { /* 未启动时忽略 */ }
      currentNamespace.value = ''
      setActiveToken(c.token)
      activeApiServerRef.value = c.apiServer
      currentCluster.value = c.name
      metricsReloadWindow()   // epoch++:挂起中的旧 tick 恢复后自弃(变体 A)
      cluster.value = { ...cluster.value, name: c.name, apiServer: c.apiServer, version: c.version, status: c.status || 'Healthy' }
      connectionState.value = 'loading'
      try { queryClient.clear(); await hydrateCriticalResources() } catch { connectionState.value = 'error' }
      apiReachable.value = true
      startHealthCheck()
      startWorkloadFamilyWatch()
    } finally { setMetricsHold(false) }
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
    metricsReloadWindow()
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
  // === 端口转发(kubectl port-forward 语义)===
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
  return { switchCluster, removeSavedClusterStore, setConnectedCluster, portForwards, addPortForward, removePortForward, refreshPortForwards }
}
