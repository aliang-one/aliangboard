// ref→资源配对(2026-09-06 审计#11):服务端 fetchedResources 与请求 references 数组严格按
// 下标平行(not-found 为 null 占位,保下标对齐)。按下标配对天然免疫「同名不同 kind」错绑——
// 旧的 name+namespace find 会把 Deployment 的资源绑到同名的 Service ref 上(ResourceCard 显示错对象)。
// refs 与 fetched 长度恒一致(同一 refs.value 快照映射);防御 fetched 异常形态 → 全部置 null。
export function pairRefResources(refs, fetched) {
  if (!Array.isArray(refs)) return refs
  const parallel = Array.isArray(fetched)
  refs.forEach((ref, i) => { ref.resource = parallel ? (fetched[i] || null) : null })
  return refs
}
