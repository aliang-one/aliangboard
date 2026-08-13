// K8s kind → API path 的唯一来源。
// 原先 index.mjs 与 routes/workbench-conversations.mjs 各有一份且已漂移(routes 侧缺 6 个 SP3 kind,
// 导致工作台 @ nodes/PV/PVC/SC/NetPol/SA 报「不支持的 kind」);现统一从此处 import。
export const KIND_API_PATH = {
  pods: (ns, name) => `/api/v1/namespaces/${ns}/pods/${name}`,
  services: (ns, name) => `/api/v1/namespaces/${ns}/services/${name}`,
  configmaps: (ns, name) => `/api/v1/namespaces/${ns}/configmaps/${name}`,
  secrets: (ns, name) => `/api/v1/namespaces/${ns}/secrets/${name}`,
  deployments: (ns, name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
  statefulsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/statefulsets/${name}`,
  daemonsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/daemonsets/${name}`,
  ingresses: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`,
  namespaces: (_ns, name) => `/api/v1/namespaces/${name}`,
  // SP3 扩展:集群级 + 存储 + 网络 + 身份
  nodes: (_ns, name) => `/api/v1/nodes/${name}`,
  persistentvolumes: (_ns, name) => `/api/v1/persistentvolumes/${name}`,
  persistentvolumeclaims: (ns, name) => `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`,
  storageclasses: (_ns, name) => `/apis/storage.k8s.io/v1/storageclasses/${name}`,
  networkpolicies: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${name}`,
  serviceaccounts: (ns, name) => `/api/v1/namespaces/${ns}/serviceaccounts/${name}`,
}
