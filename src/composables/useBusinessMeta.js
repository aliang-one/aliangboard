// AliangBoard 业务标签体系：统一从 labels/annotations 读取展示用元数据。
// 规范前缀 aliangboard.io/；兼容历史键 layer.aliangboard.io / tier，以及用户自定义的 aliang-description。
// description 建议放 annotation（免受 label 63 字符限制）。
//
// 读取优先级：规范键(label) → 规范键(annotation) → 别名(label) → 别名(annotation) → K8s 标准键 → 默认。

export const META_KEYS = {
  title:       { canon: 'aliangboard.io/title',       aliases: ['title'],                                              std: '' },
  description: { canon: 'aliangboard.io/description', aliases: ['aliang-description', 'description', 'desc'],          std: '' },
  layer:       { canon: 'aliangboard.io/layer',       aliases: ['layer.aliangboard.io', 'tier'],                       std: 'app.kubernetes.io/component' },
  icon:        { canon: 'aliangboard.io/icon',        aliases: ['icon'],                                               std: '' },
  owner:       { canon: 'aliangboard.io/owner',       aliases: ['owner', 'team'],                                      std: 'app.kubernetes.io/part-of' },
  version:     { canon: 'aliangboard.io/version',     aliases: ['version'],                                            std: 'app.kubernetes.io/version' },
  tags:        { canon: 'aliangboard.io/tags',        aliases: ['tags'],                                               std: '' },
  managedBy:   { canon: 'aliangboard.io/managed-by',  aliases: [],                                                     std: '' },
  lastEdited:  { canon: 'aliangboard.io/last-edited', aliases: [],                                                     std: '' },
}

function fromAliases(labels, ann, def) {
  for (const k of def.aliases) {
    if (labels[k] != null && labels[k] !== '') return labels[k]
    if (ann[k] != null && ann[k] !== '') return ann[k]
  }
  if (def.std && labels[def.std] != null && labels[def.std] !== '') return labels[def.std]
  return ''
}

// 从一个资源对象（需带 labels/annotations）读取全部业务元数据
export function readMeta(res) {
  const labels = res?.labels || {}
  const ann = res?.annotations || {}
  const out = {}
  for (const [k, def] of Object.entries(META_KEYS)) {
    out[k] = labels[def.canon] ?? ann[def.canon] ?? fromAliases(labels, ann, def) ?? ''
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
