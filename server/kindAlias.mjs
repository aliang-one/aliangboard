// kind 归一化单一事实源:LLM 常传 K8s Kind 自然名(Service/Pod)或 kubectl 缩写(svc/po),
// 而各分发表只收小写复数——曾致「不支持的 kind: service」(2026-08-26 wb_get_resource 报障)。
// 全部 kind 分发点(WB list/get、api-key list/get、@-mention 搜索)统一经此归一。
export const CANONICAL_KINDS = [
  'pods', 'services', 'configmaps', 'secrets', 'namespaces',
  'deployments', 'statefulsets', 'daemonsets', 'ingresses',
  'nodes', 'persistentvolumes', 'persistentvolumeclaims', 'storageclasses',
  'networkpolicies', 'serviceaccounts',
]

const ALIAS = {}
for (const k of CANONICAL_KINDS) {
  // 去尾 s / es / ies 的单数近似:pods→pod, services→service, ingresses→ingress,
  // networkpolicies→networkpolic(y 补回), statefulsets→statefulset ...
  let s = k.replace(/ies$/, 'y')
  if (s === k) s = k.replace(/(ses|xes|zes|ches|shes)$/, 's')
  if (s === k) s = k.replace(/s$/, '')
  if (s !== k) ALIAS[s] = k
}
// 去尾 s 的近似会把 storageclasses→storageclasse(ses 规则先命中已正确);兜底显式别名:
Object.assign(ALIAS, {
  storageclass: 'storageclasses',
  // kubectl 风格缩写
  po: 'pods', svc: 'services', cm: 'configmaps', ns: 'namespaces',
  deploy: 'deployments', sts: 'statefulsets', ds: 'daemonsets', ing: 'ingresses',
  no: 'nodes', pv: 'persistentvolumes', pvc: 'persistentvolumeclaims',
  sc: 'storageclasses', netpol: 'networkpolicies', sa: 'serviceaccounts',
})

// 任意输入(复数/单数/Kind 大写/缩写)→ 规范复数键;无法识别 → null
export function normalizeKind(input) {
  const k = String(input ?? '').trim().toLowerCase()
  if (CANONICAL_KINDS.includes(k)) return k
  return ALIAS[k] || null
}
