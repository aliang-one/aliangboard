import { yamlScalar } from './useYaml.js'

// 构造 Ingress 路由规则的 PATCH body（networking.k8s.io/v1，merge-patch 语义）。
// 入参：flatRules [{host,path,pathType,serviceName,servicePort}] + defaultBackend {enabled,serviceName,servicePort} | null
// 出参：{ spec: { rules, defaultBackend } }；defaultBackend===null 表示删除该字段。
// 端口按类型分流：纯数字串 → port.number；否则(命名端口如 'http')→ port.name；无数字兜底(不把命名端口改写成 80)。
// 无依赖纯函数，便于 scripts/test.mjs 直接 import；stores/cluster.js 的 updateIngressRules 复用本函数。
const k8sPortOf = port => (/^\d+$/.test(String(port)) ? { number: Number(port) } : { name: String(port) })
export function buildIngressRulesPatch(flatRules = [], defaultBackend = null) {
  const byHost = new Map()
  for (const r of flatRules) {
    const host = r.host || ''
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host).push({
      path: r.path || '/',
      pathType: r.pathType || 'Prefix',
      backend: { service: { name: r.serviceName || '', port: k8sPortOf(r.servicePort) } },
    })
  }
  const rules = Array.from(byHost.entries()).map(([host, paths]) => ({ host, http: { paths } }))
  let db = null
  if (defaultBackend && defaultBackend.enabled && defaultBackend.serviceName) {
    db = { service: { name: defaultBackend.serviceName, port: k8sPortOf(defaultBackend.servicePort) } }
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

// hosts 编辑模型 → 校验错误数组(四入口共享;语义对齐 DeployApp 向导 stepBlockReason 的 backend 门禁)。
// 生成层不变式(spec §3.3):hostsToK8sSpec 对 port 不做兜底——未填/命名端口必须由各入口
// 用本函数拦截,否则 Number('')→0 / Number('http')→NaN,经 generateYAML `|| 80` 静默改写 80 端口。
// 规则:有 host 的组须至少一条 path,且每条 path/serviceName 非空、servicePort 纯数字。
// 无 host 的组跳过(与向导一致)。返回 [{host, path, reason}],reason ∈ noPath|noService|badPort。
export function ingressHostsErrors(hosts) {
  const errs = []
  for (const h of hosts || []) {
    if (!h.host) continue
    const paths = h.paths || []
    if (!paths.length) { errs.push({ host: h.host, reason: 'noPath' }); continue }
    for (const p of paths) {
      if (!p.path || !p.serviceName) errs.push({ host: h.host, path: p.path, reason: !p.path ? 'noPath' : 'noService' })
      if (!/^\d+$/.test(String(p.servicePort ?? ''))) errs.push({ host: h.host, path: p.path, reason: 'badPort' })
    }
  }
  return errs
}

// === ② 智能追加决策 ===
// 同 host(精确、trim 后非空)的已有 Ingress 列表。ingressList 为 store ingress 对象。
export function sameHostIngresses(ingressList, host) {
  const h = String(host || '').trim()
  if (!h) return []
  return (ingressList || []).filter(i => (i.rules || []).some(r => (r.host || '') === h))
}

// 往单个 ingress 追加一条 path:拍平现有规则 + 新规则,返回完整 flatRules(供 updateIngressRules)
// 与冲突标记(同 host 同 path 已存在,忽略 pathType)。defaultBackend 由调用方从 ingress 对象读取并回传。
export function appendPathToIngress(ingress, rule) {
  const flat = ingressRulesToFlat(ingress.rules || [])
  const conflict = flat.some(r => r.host === (rule.host || '') && r.path === (rule.path || '/'))
  flat.push({ host: rule.host || '', path: rule.path || '/', pathType: rule.pathType || 'Prefix', serviceName: rule.serviceName || '', servicePort: rule.servicePort })
  return { flatRules: flat, conflict }
}

// === ① 向导 Ingress YAML(从 DeployApp previewYAML 拆出)===
// 生成完整 Ingress 文档(以 '\n---\n' 开头,可直接字符串拼进多资源 YAML)。
// backend 一律取 path 级 serviceName/servicePort;无兜底(向导校验负责拦截)。
// tls secret 回退链:h.tlsSecret || defaultTlsSecret || name+'-tls'(name 逐字使用,后缀由调用方决定)。
export function buildWizardIngressYaml(hosts, { name, namespace, ingressClassName = '', annotations = {}, defaultTlsSecret = '' } = {}) {
  const valid = (hosts || []).filter(h => h.host && (h.paths || []).some(p => p.path))
  if (!valid.length) return ''
  let yaml = `\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: ${name}\n  namespace: ${namespace}`
  if (Object.keys(annotations).length) {
    yaml += '\n  annotations:'
    for (const [k, v] of Object.entries(annotations)) yaml += `\n    ${k}: ${yamlScalar(v)}`
  }
  yaml += `\nspec:`
  if (ingressClassName) yaml += `\n  ingressClassName: ${ingressClassName}`
  const tlsHosts = valid.filter(h => h.tls)
  if (tlsHosts.length) {
    yaml += `\n  tls:`
    tlsHosts.forEach(h => { yaml += `\n  - hosts:\n    - ${h.host}\n    secretName: ${h.tlsSecret || defaultTlsSecret || name + '-tls'}` })
  }
  yaml += `\n  rules:`
  valid.forEach(h => {
    yaml += `\n  - host: ${h.host}\n    http:\n      paths:`
    h.paths.filter(p => p.path).forEach(p => {
      yaml += `\n      - path: ${p.path}\n        pathType: ${p.pathType}\n        backend:\n          service:\n            name: ${p.serviceName}\n            port:\n              number: ${p.servicePort}`
    })
  })
  return yaml
}
