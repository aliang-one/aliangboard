// GET /api/cluster-certs(2026-09-06 证书可观测):session 级集群证书报告——连接证书(TLS 双拨归因)+
// 信任 CA 锚 + kubernetes.io/tls Secret 扫描 + cert-manager 合并。出口无任何 PEM/私钥材料。
// 鉴权:门外 ROUTE_AUTH session;ns 门 namespace:null(集群级读,对齐 registry-tags 先例:
// open 模式照常放行,allowlist 模式按集群授权,admin 短路)。报告缓存 60s 在服务层(cluster-certs.mjs)。
export function createClusterCertsRoutes(deps) {
  const { sendJson, msg, clusterCerts, k8sGate, levelForRequest } = deps

  // 匹配证书路由;命中并处理返 true(调用方不再 dispatch);否则返 false。
  async function handle(req, res, url) {
    if (url.pathname === '/api/cluster-certs' && req.method === 'GET') {
      const session = req.abSession // 路由鉴权门已预检并缓存
      if (!k8sGate.gateK8sSession(session, { namespace: null, level: levelForRequest(req.method), path: url.pathname, method: req.method })) {
        sendJson(res, 403, { message: msg(req, 'api.nsForbidden') })
        return true
      }
      try {
        sendJson(res, 200, await clusterCerts.getCertsReport(session))
      } catch (error) {
        sendJson(res, error.status || 502, { message: error?.message || msg(req, 'api.clusterCertsFailed') })
      }
      return true
    }
    return false
  }
  return { handle }
}
