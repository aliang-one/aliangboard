// 构造 IngressClass 编辑的 merge-patch body(手术式:只含改动字段)。
// 与 buildStorageClassPatch 的差异:IC 单注解键;取消默认置 null(删除)而非 'false'。
// 无依赖纯函数;store 的 promoteIngressClassDefault/demoteIngressClassDefault 复用(spec §3.2)。
export const INGRESSCLASS_DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'

export function buildIngressClassPatch(original = {}, { isDefault } = {}) {
  if (isDefault == null) {
    // 取消默认:仅当当前确实是默认才有事可做(幂等)
    if (!original.isDefault) return null
    return { metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: null } } }
  }
  if (!!isDefault === !!original.isDefault) return null
  return { metadata: { annotations: { [INGRESSCLASS_DEFAULT_KEY]: isDefault ? 'true' : null } } }
}
