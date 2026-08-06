// 集群健康判定纯函数：从节点列表 + API 可达性算出 {status, severity, reasons, controlPlane, workers}。
// 控制面优先分级：不可达/未连接/空 → Disconnected；控制面有 NotReady → Critical；
// worker 有 NotReady → Degraded；否则 Healthy。无依赖，便于 scripts/test.mjs 直接 import。
//
// reasons 存 i18n key（非翻译串）——保持模块纯净（不引 @/i18n，scripts/test.mjs 可直 import）；
// 消费方（AppLayout/TopNavBar）渲染时 $t(r) 翻译。ready/total 数值由 controlPlane/workers 字段携带，
// 渲染处的消息（layout.controlPlaneAbnormal 等）已含 {ready}/{total}，故 reason 串只存类别。
export function computeClusterHealth({ nodeList = [], apiReachable = true, remoteMode = true } = {}) {
  const cp = nodeList.filter(n => n.isControlPlane)
  const cpReady = cp.filter(n => n.status === 'Ready')
  const workers = nodeList.filter(n => !n.isControlPlane)
  const wReady = workers.filter(n => n.status === 'Ready')
  const base = { controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  if (!remoteMode || !apiReachable || !nodeList.length) {
    return { status: 'Disconnected', severity: 'crit', reasons: ['clusterHealth.reasonApiUnreachable'], ...base }
  }
  if (cp.length && cpReady.length < cp.length) {
    return { status: 'Critical', severity: 'crit', reasons: ['clusterHealth.reasonControlPlane'], ...base }
  }
  if (wReady.length < workers.length) {
    return { status: 'Degraded', severity: 'warn', reasons: ['clusterHealth.reasonWorker'], ...base }
  }
  return { status: 'Healthy', severity: 'ok', reasons: [], ...base }
}
