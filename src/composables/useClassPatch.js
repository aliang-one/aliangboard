// 构造 IngressClass 编辑的 merge-patch body(手术式:只含改动字段)。
// 与 buildStorageClassPatch 的差异:IC 单注解键;取消默认置 null(删除)而非 'false'。
// 全参数扩展(2026-09-05):controller/parameters/labels/annotations ——
//   parameters:undefined=不动;null=整体删除(merge-patch);对象=设置;
//   labels/annotations 传「期望全量」,diffMap 比对后删除键置 null;
//   isDefault 传 null=摘除注解,传 boolean=设/撤(编辑弹窗不传此参,设默认走 promote/demote 保 sweep 唯一性)。
// 无依赖纯函数(diffMap 来自 useStoragePatch);store 的 promote/demote/updateIngressClassSpec 复用。
import { diffMap } from './useStoragePatch'

export const INGRESSCLASS_DEFAULT_KEY = 'ingressclass.kubernetes.io/is-default-class'

export function buildIngressClassPatch(original = {}, { isDefault, controller, parameters, labels, annotations } = {}) {
  const metadata = {}
  const spec = {}

  // 默认注解(仅显式提及 isDefault 时参与)
  const annPatch = {}
  if (isDefault !== undefined) {
    if (isDefault === null) {
      if (original.isDefault) annPatch[INGRESSCLASS_DEFAULT_KEY] = null
    } else if (!!isDefault !== !!original.isDefault) {
      annPatch[INGRESSCLASS_DEFAULT_KEY] = isDefault ? 'true' : null
    }
  }
  if (annotations) {
    const origAnnExcl = { ...(original.annotations || {}) }
    delete origAnnExcl[INGRESSCLASS_DEFAULT_KEY]   // is-default 归 promote/demote 管,不进普通注解 diff
    Object.assign(annPatch, diffMap(origAnnExcl, annotations))
  }
  if (Object.keys(annPatch).length) metadata.annotations = annPatch

  if (labels) {
    const lp = diffMap(original.labels || {}, labels)
    if (Object.keys(lp).length) metadata.labels = lp
  }

  if (controller !== undefined && controller !== original.controller) spec.controller = controller

  if (parameters !== undefined) {
    if (parameters === null) {
      if (original.parameters != null) spec.parameters = null
    } else if (JSON.stringify(parameters) !== JSON.stringify(original.parameters ?? null)) {
      spec.parameters = parameters
    }
  }

  if (!Object.keys(metadata).length && !Object.keys(spec).length) return null
  const patch = {}
  if (Object.keys(spec).length) patch.spec = spec
  if (Object.keys(metadata).length) patch.metadata = metadata
  return patch
}
