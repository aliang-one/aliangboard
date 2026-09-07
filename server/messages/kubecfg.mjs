// W3 Task 6:个人 kubeconfig(/api/k8s-proxy 路由族)的用户可见消息(zh 与原文逐字一致)
export const TABLE = {
  'kubecfg.clusterNotFound': { zh: '集群不存在', en: 'Cluster not found' },
  'kubecfg.noClusterSession': { zh: '请先在平台连接该集群', en: 'Connect this cluster in AliangBoard first' },
  'kubecfg.sessionExpired': { zh: '集群会话已失效，请重新登录平台并连接集群', en: 'Cluster session expired; sign in again and reconnect the cluster' },
  'kubecfg.clusterMismatch': { zh: '当前连接的集群与此请求不符，请先在平台连接对应集群', en: 'The connected cluster does not match this request; connect that cluster in AliangBoard first' },
}
