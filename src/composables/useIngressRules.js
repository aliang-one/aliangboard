// 构造 Ingress 路由规则的 PATCH body（networking.k8s.io/v1，merge-patch 语义）。
// 入参：flatRules [{host,path,pathType,serviceName,servicePort}] + defaultBackend {enabled,serviceName,servicePort} | null
// 出参：{ spec: { rules, defaultBackend } }；defaultBackend===null 表示删除该字段。
// 无依赖纯函数，便于 scripts/test.mjs 直接 import；stores/cluster.js 的 updateIngressRules 复用本函数。
export function buildIngressRulesPatch(flatRules = [], defaultBackend = null) {
  const byHost = new Map()
  for (const r of flatRules) {
    const host = r.host || ''
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host).push({
      path: r.path || '/',
      pathType: r.pathType || 'Prefix',
      backend: { service: { name: r.serviceName || '', port: { number: Number(r.servicePort) || 80 } } },
    })
  }
  const rules = Array.from(byHost.entries()).map(([host, paths]) => ({ host, http: { paths } }))
  let db = null
  if (defaultBackend && defaultBackend.enabled && defaultBackend.serviceName) {
    db = { service: { name: defaultBackend.serviceName, port: { number: Number(defaultBackend.servicePort) || 80 } } }
  }
  return { spec: { rules, defaultBackend: db } }
}
