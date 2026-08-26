// kind → API 路径的单一事实源(2026-08-26 根治「不支持的 kind」第二轮)。
// 历史:此文件原先只有 @-mention 用的 KIND_API_PATH 函数表,index.mjs(WB list/get)、
// api-key-tools.mjs(LIST/GET_PATH)、workbench-projects.mjs(KIND_PATH)各持一份拷贝,
// 漂移过两次(routes 缺 6 个 SP3 kind;api-key LIST 6 vs GET 15)。现全部改为
// import 本表派生函数;kindAlias.CANICAL_KINDS 也由本表 keys 派生——加 kind 只改这里。
// ns: true = namespaced(路径含 /namespaces/<ns>/);false = 集群级(忽略 ns)。
export const KIND_API = {
  // core
  pods: { prefix: '/api/v1', ns: true },
  services: { prefix: '/api/v1', ns: true },
  configmaps: { prefix: '/api/v1', ns: true },
  secrets: { prefix: '/api/v1', ns: true },
  endpoints: { prefix: '/api/v1', ns: true },
  limitranges: { prefix: '/api/v1', ns: true },
  resourcequotas: { prefix: '/api/v1', ns: true },
  serviceaccounts: { prefix: '/api/v1', ns: true },
  persistentvolumeclaims: { prefix: '/api/v1', ns: true },
  namespaces: { prefix: '/api/v1', ns: false },
  nodes: { prefix: '/api/v1', ns: false },
  persistentvolumes: { prefix: '/api/v1', ns: false },
  // apps / batch
  deployments: { prefix: '/apis/apps/v1', ns: true },
  statefulsets: { prefix: '/apis/apps/v1', ns: true },
  daemonsets: { prefix: '/apis/apps/v1', ns: true },
  replicasets: { prefix: '/apis/apps/v1', ns: true },
  cronjobs: { prefix: '/apis/batch/v1', ns: true },
  jobs: { prefix: '/apis/batch/v1', ns: true },
  // networking / storage / autoscaling / policy / rbac
  ingresses: { prefix: '/apis/networking.k8s.io/v1', ns: true },
  networkpolicies: { prefix: '/apis/networking.k8s.io/v1', ns: true },
  storageclasses: { prefix: '/apis/storage.k8s.io/v1', ns: false },
  horizontalpodautoscalers: { prefix: '/apis/autoscaling/v2', ns: true },
  poddisruptionbudgets: { prefix: '/apis/policy/v1', ns: true },
  roles: { prefix: '/apis/rbac.authorization.k8s.io/v1', ns: true },
  rolebindings: { prefix: '/apis/rbac.authorization.k8s.io/v1', ns: true },
  clusterroles: { prefix: '/apis/rbac.authorization.k8s.io/v1', ns: false },
  clusterrolebindings: { prefix: '/apis/rbac.authorization.k8s.io/v1', ns: false },
}

const enc = encodeURIComponent

// list 路径:ns-scoped 且给了 ns → 收窄到该 ns;否则集群级列表。未知 kind → null。
export function listApiPath(kind, ns) {
  const e = KIND_API[kind]
  if (!e) return null
  return e.ns && ns ? `${e.prefix}/namespaces/${enc(ns)}/${kind}` : `${e.prefix}/${kind}`
}

// get 路径:ns-scoped → /namespaces/<ns>/<kind>/<name>;集群级忽略 ns。未知 kind → null。
export function getApiPath(kind, ns, name) {
  const e = KIND_API[kind]
  if (!e) return null
  return e.ns ? `${e.prefix}/namespaces/${enc(ns)}/${kind}/${enc(name)}` : `${e.prefix}/${kind}/${enc(name)}`
}
