// K8s / aliangboard 系统管理注解:控制器或平台写入,不代表用户意图。
// 单一事实源:复制 workload 反向映射(useWorkloadToForm)与详情页元信息合并(NsWorkloadDetail)共用。
// 2026-08-16 线上事故:复制 workload 把 deployment.kubernetes.io/revision:"14" 带进新负载表单,
// 向导 YAML 裸拼成数字 14,apiserver SSA 拒绝(expected string, got valueUnstructured)——
// 名单散落两处会漂移,故抽出共享。
export const SYSTEM_ANNOTATIONS = [
  'deployment.kubernetes.io/revision',
  'kubectl.kubernetes.io/restartedAt',
  'kubectl.kubernetes.io/last-applied-configuration',
  'aliangboard.io/last-edited',
  'aliangboard.io/last-action',
]
