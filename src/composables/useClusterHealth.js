// 集群健康判定纯函数：从节点列表 + API 可达性算出 {status, severity, reasons, controlPlane, workers}。
// 控制面优先分级：不可达/未连接/空 → Disconnected；控制面有 NotReady → Critical；
// worker 有 NotReady → Degraded；否则 Healthy。无依赖，便于 scripts/test.mjs 直接 import。
export function computeClusterHealth({ nodeList = [], apiReachable = true, remoteMode = true } = {}) {
  const cp = nodeList.filter(n => n.isControlPlane)
  const cpReady = cp.filter(n => n.status === 'Ready')
  const workers = nodeList.filter(n => !n.isControlPlane)
  const wReady = workers.filter(n => n.status === 'Ready')
  const base = { controlPlane: { ready: cpReady.length, total: cp.length }, workers: { ready: wReady.length, total: workers.length } }
  if (!remoteMode || !apiReachable || !nodeList.length) {
    return { status: 'Disconnected', severity: 'none', reasons: ['API 不可达或未连接'], ...base }
  }
  if (cp.length && cpReady.length < cp.length) {
    return { status: 'Critical', severity: 'crit', reasons: [`控制面 ${cpReady.length}/${cp.length} 就绪`], ...base }
  }
  if (wReady.length < workers.length) {
    return { status: 'Degraded', severity: 'warn', reasons: [`worker ${wReady.length}/${workers.length} 就绪`], ...base }
  }
  return { status: 'Healthy', severity: 'ok', reasons: [], ...base }
}
