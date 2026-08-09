// NetworkPolicy 创建向导纯逻辑:无 Vue 依赖,可被 scripts/test.mjs(Node)与组件共同 import。
// model 直接是 K8s 原生 NetworkPolicy 对象 —— 不造中间 app-model。
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'

export function emptySelector() {
  return { matchLabels: {}, matchExpressions: [] }
}

export function emptyPeer() {
  // 新增 peer 默认给一个空 Pod 选择器(用户可在编辑器里切 namespace/ipBlock/组合)
  return { podSelector: emptySelector() }
}

export function emptyPort() {
  // port 为 ''/缺省 = 全部端口
  return { protocol: 'TCP', port: '' }
}

export function emptyIngressRule() {
  return { from: [], ports: [] }
}

export function emptyEgressRule() {
  return { to: [], ports: [] }
}

export function defaultModel(namespace) {
  // 放行起步:每方向一条「未限定源」规则(allowAll),对生产最安全。
  // denyAll 只有用户手动删光规则才会出现。
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: '', namespace: namespace || 'default' },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [emptyIngressRule()],
      egress: [emptyEgressRule()],
    },
  }
}

// 方向后果四态:none(不管控)/ denyAll(受管但无规则)/ allowAll(存在无 peer 的规则)/ scoped(全部规则有具体 peer)
export function consequence(spec, direction) {
  const typeName = direction === 'ingress' ? 'Ingress' : 'Egress'
  const peersKey = direction === 'ingress' ? 'from' : 'to'
  if (!(spec.policyTypes || []).includes(typeName)) {
    return { state: 'none', rules: 0, peers: 0, ports: 0 }
  }
  const rules = spec[direction] || []
  let peers = 0
  let ports = 0
  for (const r of rules) {
    peers += (r[peersKey] || []).length
    ports += (r.ports || []).length
  }
  if (rules.length === 0) return { state: 'denyAll', rules: 0, peers: 0, ports: 0 }
  // 规则间是 OR:任一规则「无 peer」即等于放行所有源
  const hasUnrestricted = rules.some(r => (r[peersKey] || []).length === 0)
  if (hasUnrestricted) return { state: 'allowAll', rules: rules.length, peers, ports }
  return { state: 'scoped', rules: rules.length, peers, ports }
}

export function isDenyAll(spec) {
  return consequence(spec, 'ingress').state === 'denyAll' || consequence(spec, 'egress').state === 'denyAll'
}

export function modelToYaml(model) {
  // 规范化:补全 apiVersion/kind,保留 model 其余字段(metadata/spec)
  const doc = {
    apiVersion: model.apiVersion || 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { ...(model.metadata || {}) },
    spec: model.spec || {},
  }
  return yamlDump(doc, { lineWidth: -1, noRefs: true })
}

export function parseAndValidate(yamlStr) {
  let doc
  try {
    doc = yamlLoad(yamlStr)
  } catch (e) {
    return { ok: false, code: 'parseError', detail: e?.message || String(e) }
  }
  if (!doc || typeof doc !== 'object') return { ok: false, code: 'parseError', detail: 'empty document' }
  if (!doc.kind || typeof doc.kind !== 'string') return { ok: false, code: 'parseError', detail: 'missing or invalid kind field' }
  if (doc.kind !== 'NetworkPolicy') return { ok: false, code: 'notNetworkPolicy', detail: `kind=${doc.kind}` }
  if (!doc.metadata?.name) return { ok: false, code: 'nameRequired', detail: 'metadata.name missing' }
  return { ok: true, model: doc }
}
