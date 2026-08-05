// AliangBoard 业务标签体系：统一从 labels/annotations 读取展示用元数据。
// 规范前缀 aliangboard.io/；兼容历史键 layer.aliangboard.io / tier，以及用户自定义的 aliang-description。
// description 建议放 annotation（免受 label 63 字符限制）。
//
// 读取优先级：规范键(label) → 规范键(annotation) → 别名(label) → 别名(annotation) → K8s 标准键 → 默认。

export const META_KEYS = {
  title:       { canon: 'aliangboard.io/title',       aliases: ['title'],                                              std: '', storage: 'annotation' },
  description: { canon: 'aliangboard.io/description', aliases: ['aliang-description', 'description', 'desc'],          std: '', storage: 'annotation' },
  layer:       { canon: 'aliangboard.io/layer',       aliases: ['layer.aliangboard.io', 'tier'],                       std: 'app.kubernetes.io/component', storage: 'label' },
  icon:        { canon: 'aliangboard.io/icon',        aliases: ['icon'],                                               std: '', storage: 'label' },
  owner:       { canon: 'aliangboard.io/owner',       aliases: ['owner', 'team'],                                      std: 'app.kubernetes.io/part-of', storage: 'label' },
  version:     { canon: 'aliangboard.io/version',     aliases: ['version'],                                            std: 'app.kubernetes.io/version', storage: 'label' },
  tags:        { canon: 'aliangboard.io/tags',        aliases: ['tags'],                                               std: '', storage: 'annotation' },
  managedBy:   { canon: 'aliangboard.io/managed-by',  aliases: [],                                                     std: '', storage: 'label' },
  lastEdited:  { canon: 'aliangboard.io/last-edited', aliases: [],                                                     std: '', storage: 'annotation' },
}

function fromAliases(labels, ann, def) {
  for (const k of def.aliases) {
    if (labels[k] != null && labels[k] !== '') return labels[k]
    if (ann[k] != null && ann[k] !== '') return ann[k]
  }
  if (def.std && labels[def.std] != null && labels[def.std] !== '') return labels[def.std]
  return ''
}

// 从一个资源对象（需带 labels/annotations）读取全部业务元数据。
// 优先读「主存储」位置（storage），主存储为空再回退另一处——兼容从 label↔annotation 的历史迁移，
// 避免旧残留位置（如迁移前 tags 存在 label）盖过权威位置（annotation）。
export function readMeta(res) {
  const labels = res?.labels || {}
  const ann = res?.annotations || {}
  const out = {}
  for (const [k, def] of Object.entries(META_KEYS)) {
    const primary = def.storage === 'annotation'
      ? (ann[def.canon] ?? labels[def.canon])
      : (labels[def.canon] ?? ann[def.canon])
    out[k] = primary ?? fromAliases(labels, ann, def) ?? ''
  }
  return out
}

// 日期格式化：ISO timestamp → YYYY-MM-DD（卡片「年月日」展示，替代 45d 这种相对值）
export function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 从镜像串取版本 tag：nginx:1.25 → 1.25；repo/app:v2 → v2；无 tag → latest
export function imageTag(image) {
  if (!image) return ''
  const noDigest = image.split('@')[0]
  const idx = noDigest.lastIndexOf(':')
  if (idx <= noDigest.lastIndexOf('/')) return ''   // registry:port/... 无 tag
  return noDigest.slice(idx + 1)
}
