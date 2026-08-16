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

// === hosts 编辑模型 ↔ 扁平规则 ↔ K8s spec(四入口共享)===
// K8s rules 数组 → 扁平规则。兼容两种 backend 形状:
// 新:backend.service.{name,port:{number|name}};旧:backend.{serviceName,servicePort}
export function ingressRulesToFlat(rules) {
  const out = []
  for (const r of rules || []) {
    for (const p of (r.http?.paths || [])) {
      const svc = p.backend?.service || p.backend
      out.push({
        host: r.host || '',
        path: p.path || '/',
        pathType: p.pathType || 'Prefix',
        serviceName: svc?.name ?? svc?.serviceName ?? '',
        servicePort: String(svc?.port?.number ?? svc?.port?.name ?? svc?.servicePort ?? ''),
      })
    }
  }
  return out
}

// 扁平规则 → hosts 编辑模型(按 host 首次出现顺序分组,非相邻同 host 合并)
export function flatToHosts(flatRules) {
  const byHost = new Map()
  for (const r of flatRules || []) {
    if (!byHost.has(r.host)) byHost.set(r.host, [])
    byHost.get(r.host).push({ path: r.path || '/', pathType: r.pathType || 'Prefix', serviceName: r.serviceName || '', servicePort: String(r.servicePort ?? '') })
  }
  return Array.from(byHost.entries()).map(([host, paths]) => ({ host, tls: false, tlsSecret: '', paths }))
}

// hosts 编辑模型 → 扁平规则(updateIngressRules / 追加决策共用)
export function hostsToFlat(hosts) {
  return (hosts || []).flatMap(h => (h.paths || []).map(p => ({
    host: h.host || '', path: p.path || '/', pathType: p.pathType || 'Prefix', serviceName: p.serviceName || '', servicePort: p.servicePort,
  })))
}

// hosts → K8s spec 片段(③ addIngress 构造 rules/tls 用)。
// 注意:port 不做 || 80 兜底——未填由各入口校验拦截(生成层不变式,见 spec §3.3)。
export function hostsToK8sSpec(hosts, { defaultTlsSecret = '' } = {}) {
  const rules = [], tls = []
  for (const h of hosts || []) {
    const paths = (h.paths || []).map(p => ({
      path: p.path || '/',
      pathType: p.pathType || 'Prefix',
      backend: { service: { name: p.serviceName || '', port: { number: Number(p.servicePort) } } },
    }))
    rules.push({ host: h.host || '', http: { paths } })
    if (h.tls && h.host) tls.push({ hosts: [h.host], secretName: h.tlsSecret || defaultTlsSecret })
  }
  return { rules, tls }
}
