// 工作负载业务元数据的 selector 承重墙防线(纯函数,2026-08-19 线上事故修复)。
//
// 事故:Kuboard 创建的 Deployment,selector.matchLabels 绑定 k8s.kuboard.cn/layer=svc(selector
// 创建后不可变)。元数据编辑器(NsWorkloadDetail saveMeta)曾把该键当普通自定义标签展示并镜像
// 写入 Pod 模板 labels——用户改值 svc→gateway 后 selector ⊄ template,K8s 拒绝整个保存:
//   Deployment.apps "ai-gateway" is invalid: spec.template.metadata.labels: ... `selector` does not match template `labels`
//
// 防线(与 META_SYS_LABELS 的「系统保留」同族,但键随资源动态):
//   ① openMetaEditor:selector 键从自定义标签列表隐藏(selectorMatchLabels)
//   ② saveMeta 保存前拦截撞键行(findSelectorLabelConflict)——把 K8s 422 变成前端明确报错
//   ③ 模板镜像对 selector 键强制原值透传(guardTemplateLabels)——业务/自定义键一律不得覆写

// raw → spec.selector.matchLabels(Deployment/StatefulSet/DaemonSet;缺 shape 一律空 map 不炸)
export function selectorMatchLabels(raw) {
  const m = raw?.spec?.selector?.matchLabels
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
}

// 自定义标签行里第一个撞 selector 键的行(行 key 已 trim;无撞键 → null)
export function findSelectorLabelConflict(rows, selector) {
  const keys = new Set(Object.keys(selector || {}))
  if (!keys.size) return null
  for (const r of rows || []) {
    const k = String(r?.key ?? '').trim()
    if (k && keys.has(k)) return r
  }
  return null
}

// 模板镜像的最后防线:desired 里所有 selector 键强制回填 raw 模板原值(selector 不可变,
// 模板必须保持匹配;模板上没有的键不注入)。返回新对象,不改入参。
export function guardTemplateLabels(desired, rawTplLabels, selector) {
  const raw = rawTplLabels || {}
  const out = { ...desired }
  for (const k of Object.keys(selector || {})) {
    if (k in raw) out[k] = raw[k]
  }
  return out
}
