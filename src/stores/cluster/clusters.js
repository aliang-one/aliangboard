// cluster store · 多集群域(2026-09-10 issue#8 系统化重构):
// 身份以服务端为源——connect-cluster/session 下发集群 name,setConnectedCluster 直用;
// 可用集群列表 clusterList 来自 /api/my-clusters(localStorage 登记簿已退役);
// switchCluster 按 clusterId 走平台连接链换新 token,不再消费缓存凭据
// (服务端单活会话模型:换集群即吊销旧 token,缓存 token 必死)。
// 端口转发(kubectl port-forward 语义)保持不变。
import { ref } from 'vue'
import { authApi, portForwardApi } from '@/api/client'
import { queryClient } from '@/queryClient'
import { notify } from '@/composables/useToast'
import { i18n } from '@/i18n'

export function createClustersDomain({ cluster, activeApiServerRef, apiReachable, connectionState, currentCluster, currentNamespace, clusterList, hydrateCriticalResources, startWorkloadFamilyWatch, stopWorkloadFamilyWatch, startHealthCheck, setMetricsHold, metricsReloadWindow, connectCluster }) {
  // === 可用集群列表(服务端为源) ===
  // my-clusters(admin 全量/普通用户已分配)映射为展示行;失败静默——面板/列表页
  // 各自兜底,不阻塞连接主链。
  async function loadAvailableClusters() {
    try {
      const res = await authApi.myClusters()
      clusterList.value = (res.clusters || []).map(c => ({
        id: c.id, name: c.name, apiServer: c.apiServer,
        version: c.version || 'unknown', status: 'Healthy', distribution: 'Kubernetes',
      }))
    } catch { /* 静默:调用方以旧列表兜底 */ }
  }

  // === 切换集群:按 clusterId 平台连接换新 token ===
  // connectCluster 为注入的 authStore.connectCluster(内聚 saveSession/LAST_CLUSTER_KEY/
  // rekey 窗口记录迁移);跨集群切换语义下 rekey 内部自动丢 stash(不迁幽灵记录)。
  // 失败:notify + rethrow——调用方(ClusterCard.open/侧栏面板)据此留在原地,
  // 不再出现旧实现「死 token → 401 → 整页弹回选择页」的二段式切换。
  // (不提前 stopWorkloadFamilyWatch:setConnectedCluster 首步即停旧 watch;若在此
  // 提前停,失败的 connect 会让当前集群的实时 watch 死掉且无人重启——失败路径必须
  // 对当前集群零副作用。)
  async function switchCluster(clusterId) {
    if (!clusterId) return
    setMetricsHold(true)   // 水合期间挂起 tick;try/finally 必清
    try {
      connectionState.value = 'loading'
      const res = await connectCluster(clusterId)
      currentNamespace.value = ''
      metricsReloadWindow()   // epoch++:挂起中的旧 tick 恢复后自弃
      setConnectedCluster({
        name: res.cluster?.name,
        apiServer: String(res.cluster?.apiServer || '').replace(/\/$/, ''),
        version: res.cluster?.version,
      })
      try { await hydrateCriticalResources() } catch { connectionState.value = 'error' }
      apiReachable.value = true
    } catch (e) {
      connectionState.value = 'error'
      notify('error', i18n.global.t('clusters.switchFailed', { error: e?.message || '' }))
      throw e
    } finally { setMetricsHold(false) }
  }

  function setConnectedCluster(info) {
    // 先停旧 watch:换集群不灭旧流会留 7 条僵尸连接(与 switchCluster 对称)
    try { stopWorkloadFamilyWatch() } catch { /* noop */ }
    // 清 Vue Query 缓存(与 switchCluster 对称):旧集群缓存不清会让 B 页面先闪现 A 的数据
    queryClient.clear()
    connectionState.value = 'loading'
    let name = info.name
    try { name = name || new URL(info.apiServer).hostname } catch { name = name || info.apiServer }
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
    loadAvailableClusters()   // fire-and-forget:面板/列表页名字与版本对齐(域内静默 catch)
  }
  // === 端口转发(kubectl port-forward 语义)===
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
  return { switchCluster, setConnectedCluster, loadAvailableClusters, clusterList, currentCluster, cluster, portForwards, addPortForward, removePortForward, refreshPortForwards }
}
