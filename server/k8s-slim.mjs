// K8s list 响应瘦身:剥 metadata.managedFields 与 last-applied-configuration 注解。
// 两者对前端均为纯冗余(所有消费方都在删 managedFields;last-applied 无读取方),
// 大集群下可占 list 响应字节的数倍。仅用于非流式 list 响应;watch 流保持字节级透传。
export function slimListBody(body) {
  if (!body || !Array.isArray(body.items)) return body
  for (const it of body.items) {
    const m = it?.metadata
    if (!m) continue
    if (m.managedFields) delete m.managedFields
    if (m.annotations && 'kubectl.kubernetes.io/last-applied-configuration' in m.annotations) {
      delete m.annotations['kubectl.kubernetes.io/last-applied-configuration']
    }
  }
  return body
}
