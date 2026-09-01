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

// 模板 YAML 编辑器防线:用户手编模板时把 selector 绑定标签的【值】改成与 selector 不一致
// → K8s 422。merge-patch 不删未提及键,故「删行」无害不查,只查「出现且值不一致」;
// 值按字符串比较(标签本就是字符串)。返回冲突键数组(空=通过)。
export function templateSelectorBreaks(tplLabels, selector) {
  const out = []
  const labels = tplLabels && typeof tplLabels === 'object' ? tplLabels : {}
  for (const [k, v] of Object.entries(selector || {})) {
    if (k in labels && String(labels[k]) !== String(v)) out.push(k)
  }
  return out
}

// === Service selector 失配防线(2026-09-01 Ingress 503 事故) ===
// saveExpose 曾把暴露时刻全部模板 labels 快照进 Service selector;元数据编辑器镜像改动
// 业务标签 → Pod labels 变 → Service selector ⊄ Pod labels → Endpoints 空 → Ingress 503,
// 全程静默(K8s 只校验 Deployment 自己的 selector,上面四道防线对此全盲)。
// 裁决:selector 单一事实源 = 不可变身份标签;模板 labels 变更前先算会失配哪些 Service。

// merge-patch 语义求补后 labels:{...base},patch 值 null → 删键,否则覆写。
// saveMeta(带 null 删除)与 saveTemplate(YAML 键级合并)两条守卫共用,勿在视图各写一套。
export function applyLabelPatch(base, patchLabels) {
  const out = { ...(base && typeof base === 'object' ? base : {}) }
  const patch = patchLabels && typeof patchLabels === 'object' ? patchLabels : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete out[k]
    else out[k] = v
  }
  return out
}

// 身份 selector:Deployment 不可变 selector(selectorMatchLabels)中「模板实有且值相等」的键
// + 模板上的身份标签(app / app.kubernetes.io/name)。业务/自定义标签永不算身份(会被元数据
// 编辑器镜像改写)。模板为空(legacy 扁平数据)时回退 {app: fallbackName}(与创建向导落点一致);
// 模板非空却无身份键 → 返回空 map,调用方必须拦截(空 selector 会选中 ns 全部 Pod,更糟)。
// 返回新对象,不改入参;值一律 String 化(标签本就是字符串)。
export function identitySelector(raw, tplLabels, fallbackName) {
  const tpl = tplLabels && typeof tplLabels === 'object' ? tplLabels : {}
  const out = {}
  for (const [k, v] of Object.entries(selectorMatchLabels(raw))) {
    if (k in tpl && String(tpl[k]) === String(v)) out[k] = String(v)
  }
  for (const k of ['app', 'app.kubernetes.io/name']) {
    if (!(k in out) && tpl[k] != null && tpl[k] !== '') out[k] = String(tpl[k])
  }
  if (!Object.keys(out).length && fallbackName && !Object.keys(tpl).length) out.app = String(fallbackName)
  return out
}

// 会因模板 labels 变为 tplLabels 而失配的 Service 名单:selector 非空 且 ⊄ tplLabels
// 会因模板 labels 变为 tplLabels 而失配的 Service 名单:selector 非空 且 ⊄ tplLabels
// (值按字符串比较)。空 selector(含 ExternalName)天然匹配一切,跳过。
// 分工:本函数服务【拓扑修复可见性】——那个场景要抓「曾锚定现已失配」的存量病灶,故意不看
// 「是否曾匹配」;编辑面守卫(saveMeta/saveTemplate 防线④)必须用 consumersBrokenBy(精度版,
// 只拦「当前正匹配且这次编辑会拆掉」的,否则 ns 内 selector 指向别处的不相关 Service 会被误拦)。
export function servicesBrokenBy(tplLabels, services) {
  const tpl = tplLabels && typeof tplLabels === 'object' ? tplLabels : {}
  return (services || [])
    .filter(s => {
      const sel = s?.selector
      if (!sel || typeof sel !== 'object' || !Object.keys(sel).length) return false
      return !Object.entries(sel).every(([k, v]) => k in tpl && String(tpl[k]) === String(v))
    })
    .map(s => s.name)
}

// 编辑面守卫④(精度版):labels 从 old 变为 new 会【拆掉】的消费者。
// 只拦「当前正匹配本负载(selector ⊆ old)且改后将不匹配(⊄ new)」的——从未匹配本负载的
// 无关对象(如 selector app: other)不是这次编辑拆的,排除。consumer 形状 {kind, name, selector}。
// 返回 [{kind, name}];空 selector 跳过;值按字符串比较。
export function consumersBrokenBy(oldTplLabels, newTplLabels, consumers) {
  const oldTpl = oldTplLabels && typeof oldTplLabels === 'object' ? oldTplLabels : {}
  const newTpl = newTplLabels && typeof newTplLabels === 'object' ? newTplLabels : {}
  const subsetOf = (sel, tpl) => Object.entries(sel || {}).every(([k, v]) => k in tpl && String(tpl[k]) === String(v))
  return (consumers || [])
    .filter(c => {
      const sel = c?.selector
      if (!sel || typeof sel !== 'object' || !Object.keys(sel).length) return false
      return subsetOf(sel, oldTpl) && !subsetOf(sel, newTpl)
    })
    .map(c => ({ kind: c.kind, name: c.name }))
}

// Pod 模板 labels 单一事实源(A2,2026-09-01 拓扑整修):CronJob 的 Pod 模板在
// spec.jobTemplate.spec.template 下——此前调用方直读 spec.template 缺失后静默回退
// 到 CronJob 自身 metadata.labels,导致 relatedServices/driftedServices/identitySelector
// 全部建在错误标签面上。其余类型读 spec.template。缺 shape 一律空 map 不炸。
export function podTemplateLabels(raw) {
  const spec = raw?.spec
  const tpl = spec?.jobTemplate?.spec?.template?.metadata?.labels
    ?? spec?.template?.metadata?.labels
  return tpl && typeof tpl === 'object' && !Array.isArray(tpl) ? tpl : {}
}
