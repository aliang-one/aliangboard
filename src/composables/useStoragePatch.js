// 构造 PV/StorageClass 编辑的 merge-patch body（手术式：只含改动字段）。
// labels/annotations 传「期望全量」，与 original 比较后，删除的键置 null（merge-patch 删除语义）。
// 无依赖纯函数，便于 scripts/test.mjs 直接 import；store.updatePV/updateStorageClass 复用。

// diffMap：desired 相对 original 的变化——新增/改值 → {k:v}；删除 → {k:null}
export function diffMap(original = {}, desired = {}) {
  const out = {}
  for (const [k, v] of Object.entries(desired)) {
    if (original[k] !== v) out[k] = v
  }
  for (const k of Object.keys(original)) {
    if (!(k in desired)) out[k] = null
  }
  return out
}

const SC_DEFAULT_KEYS = ['storageclass.kubernetes.io/is-default-class', 'storageclass.beta.kubernetes.io/is-default-class']

// PV patch：reclaimPolicy（可选）+ labels/annotations diff。无改动返回 null。
export function buildPVPatch(original = {}, { reclaimPolicy, labels, annotations } = {}) {
  const metadata = {}
  const spec = {}
  let touched = false
  if (reclaimPolicy && reclaimPolicy !== original.reclaimPolicy) {
    spec.persistentVolumeReclaimPolicy = reclaimPolicy; touched = true
  }
  if (labels) {
    const lp = diffMap(original.labels || {}, labels)
    if (Object.keys(lp).length) { metadata.labels = lp; touched = true }
  }
  if (annotations) {
    const ap = diffMap(original.annotations || {}, annotations)
    if (Object.keys(ap).length) { metadata.annotations = ap; touched = true }
  }
  if (!touched) return null
  const patch = {}
  if (Object.keys(spec).length) patch.spec = spec
  if (Object.keys(metadata).length) patch.metadata = metadata
  return patch
}

// SC patch：is-default 注解（由 isDefault 控制）+ labels/annotations diff（排除 is-default 键）。无改动返回 null。
export function buildStorageClassPatch(original = {}, { isDefault, labels, annotations } = {}) {
  const metadata = {}
  let touched = false
  if (isDefault != null && !!isDefault !== !!original.default) {
    metadata.annotations = { 'storageclass.kubernetes.io/is-default-class': isDefault ? 'true' : 'false' }
    touched = true
  }
  if (labels) {
    const lp = diffMap(original.labels || {}, labels)
    if (Object.keys(lp).length) { metadata.labels = lp; touched = true }
  }
  if (annotations) {
    const origAnnExcl = { ...(original.annotations || {}) }
    for (const k of SC_DEFAULT_KEYS) delete origAnnExcl[k]
    const ap = diffMap(origAnnExcl, annotations)
    if (Object.keys(ap).length) { metadata.annotations = { ...(metadata.annotations || {}), ...ap }; touched = true }
  }
  if (!touched) return null
  return { metadata }
}
