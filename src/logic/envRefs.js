// 环境变量域模块:统一行模型 <-> K8s env/envFrom 的单一事实源。
// 设计:docs/superpowers/specs/2026-09-05-container-env-editor-design.md
// 类型是行属性(直填/CM Key/Secret Key/字段引用/容器资源);envFrom 是有序多行数组。
// 铁律:往返无损——反解未建模的子字段/形态收进 row.passthrough,序列化原样回吐,
// 从机制上杜绝「编辑保存静默丢配置」(曾致 fieldRef/多 envFrom 丢失,2026-09-05)。
// 空行跳过、半行报错(env 行);envFrom 行唯一字段即 name,空行直接跳过。
// 纯函数、无 Vue 依赖,node:test 零依赖可测。

export const ENV_ROW_TYPES = ['value', 'configMapKeyRef', 'secretKeyRef', 'fieldRef', 'resourceFieldRef']

// 每类型的表单字段与必填集(value 的 value 允许空串,故 required 不含 value)
const TYPE_FIELDS = {
  value:            { fields: ['value'], required: [] },
  configMapKeyRef:  { fields: ['cmName', 'key'], required: ['cmName', 'key'] },
  secretKeyRef:     { fields: ['secretName', 'key'], required: ['secretName', 'key'] },
  fieldRef:         { fields: ['fieldPath'], required: ['fieldPath'] },
  resourceFieldRef: { fields: ['resource', 'containerName', 'divisor'], required: ['resource'] },
}
// source 内已建模键;其余(如 optional/apiVersion)走 passthrough。
// 每项 [sourceKey, rowField](cm/secret 的 source 键是 name,行字段是 cmName/secretName)。
const SOURCE_MODELED = {
  configMapKeyRef: [['name', 'cmName'], ['key', 'key']],
  secretKeyRef: [['name', 'secretName'], ['key', 'key']],
  fieldRef: [['fieldPath', 'fieldPath']],
  resourceFieldRef: [['resource', 'resource'], ['containerName', 'containerName'], ['divisor', 'divisor']],
}
const s = v => (v == null ? '' : String(v))
const nonEmpty = v => s(v).trim() !== ''
const clone = o => JSON.parse(JSON.stringify(o))

export function makeEnvRow(type = 'value') {
  const spec = TYPE_FIELDS[type] || TYPE_FIELDS.value
  const row = { name: '', type: TYPE_FIELDS[type] ? type : 'value', passthrough: undefined }
  for (const f of spec.fields) row[f] = ''
  return row
}

export function makeEnvFromRow(kind = 'configmap') {
  return { kind: kind === 'secret' ? 'secret' : 'configmap', name: '', passthrough: undefined }
}

export function envRowsToSpec(rows = []) {
  const out = []
  for (const r of rows || []) {
    if (!r || !nonEmpty(r.name)) continue
    const name = s(r.name).trim()
    const known = ENV_ROW_TYPES.includes(r.type) && r.type !== 'value'
    if (!known) {
      const entry = { name }
      const hasVf = !!r.passthrough?.valueFrom
      if (hasVf) entry.valueFrom = clone(r.passthrough.valueFrom)
      // 透传行不回吐空 value(保往返恒等);普通 value 行空串显式产出
      if (!hasVf || nonEmpty(r.value)) entry.value = s(r.value)
      out.push(entry)
      continue
    }
    const required = TYPE_FIELDS[r.type].required
    if (!required.every(f => nonEmpty(r[f]))) continue // 序列化只收完整行(校验是第一道)
    const src = {}
    for (const [srcKey, rowField] of SOURCE_MODELED[r.type]) if (nonEmpty(r[rowField])) src[srcKey] = s(r[rowField]).trim()
    if (r.passthrough && !r.passthrough.valueFrom) Object.assign(src, clone(r.passthrough))
    out.push({ name, valueFrom: { [r.type]: src } })
  }
  return out
}

function rowFromSource(srcKey, src) {
  const modeled = SOURCE_MODELED[srcKey]
  const row = { type: srcKey }
  for (const [srcKey2, rowField] of modeled) row[rowField] = s(src[srcKey2])
  const rest = Object.fromEntries(Object.entries(src).filter(([k]) => !modeled.some(([mk]) => mk === k)))
  if (Object.keys(rest).length) row.passthrough = rest
  return row
}

export function envRowsFromSpec(envArr = []) {
  return (envArr || []).map(e => {
    e = e || {}
    const vf = e.valueFrom
    if (vf && typeof vf === 'object' && !Array.isArray(vf)) {
      const srcKey = Object.keys(SOURCE_MODELED).find(k => vf[k] && typeof vf[k] === 'object')
      // srcKey 现在是 valueFrom 内的 source 键(如 configMapKeyRef)
      if (srcKey) {
        const row = { name: s(e.name), ...rowFromSource(srcKey, vf[srcKey]) }
        const restVf = Object.fromEntries(Object.entries(vf).filter(([k]) => k !== srcKey))
        if (Object.keys(restVf).length) row.passthrough = { ...(row.passthrough || {}), ...restVf }
        return row
      }
      return { name: s(e.name), type: 'value', value: s(e.value), passthrough: { valueFrom: vf } }
    }
    return { name: s(e.name), type: 'value', value: s(e.value) }
  })
}

export function envFromRowsToSpec(rows = []) {
  const out = []
  for (const r of rows || []) {
    if (!r) continue
    if (!nonEmpty(r.name)) {
      if (r.passthrough) out.push(clone(r.passthrough)) // 未知形态透传行
      continue
    }
    const refKey = r.kind === 'secret' ? 'secretRef' : 'configMapRef'
    const entry = { [refKey]: { name: s(r.name).trim() } }
    if (r.passthrough && Object.keys(r.passthrough).length) Object.assign(entry, clone(r.passthrough))
    out.push(entry)
  }
  return out
}

export function envFromRowsFromSpec(arr = []) {
  return (arr || []).map(e => {
    e = e || {}
    if (e.configMapRef || e.secretRef) {
      const kind = e.configMapRef ? 'configmap' : 'secret'
      const refKey = kind === 'configmap' ? 'configMapRef' : 'secretRef'
      const row = { kind, name: s(e[refKey]?.name) }
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k !== refKey))
      if (Object.keys(rest).length) row.passthrough = rest
      return row
    }
    return { kind: 'configmap', name: '', passthrough: clone(e) } // 未知形态整体透传
  })
}

export function envRefErrors(rows = []) {
  const errs = []
  ;(rows || []).forEach((r, index) => {
    if (!r) return
    const type = TYPE_FIELDS[r.type] ? r.type : 'value'
    const spec = TYPE_FIELDS[type]
    const all = ['name', ...spec.fields]
    if (all.every(f => !nonEmpty(r[f]))) return // 整行空 → 跳过(五类型同政策;半行才报错)
    const missing = spec.required.filter(f => !nonEmpty(r[f]))
    if (!nonEmpty(r.name)) missing.unshift('name')
    if (missing.length) errs.push({ index, name: s(r.name), type, missing })
  })
  return errs
}

export function duplicateEnvNames(rows = []) {
  const seen = new Map() // casefold → 首个原样 trim 名(K8s env 名大小写敏感但重复检测从宽)
  for (const r of rows || []) {
    const k = s(r?.name).trim()
    if (!k) continue
    const low = k.toLowerCase()
    if (seen.has(low)) return seen.get(low)
    seen.set(low, k)
  }
  return null
}

export function rowNonEmpty(r) {
  if (!r) return false
  const type = TYPE_FIELDS[r.type] ? r.type : 'value'
  return ['name', ...TYPE_FIELDS[type].fields].some(f => nonEmpty(r[f]))
}

export function envRowCount(rows = [], fromRows = []) {
  return (rows || []).filter(r => nonEmpty(r?.name)).length + (fromRows || []).filter(r => nonEmpty(r?.name)).length
}

export function envSectionEmpty(rows = [], fromRows = []) {
  if ((rows || []).some(rowNonEmpty)) return false
  if ((fromRows || []).some(r => nonEmpty(r?.name))) return false
  return true
}

// i18n 全字面量键表(i18n:check 门禁禁拼接键,曾致 'xxx.' + var 被 dangling 判红):
// 消费方以 t(ENV_TYPE_LABEL_KEYS[type]) / t(ENV_FIELD_LABEL_KEYS[f]) 取文案。
export const ENV_TYPE_LABEL_KEYS = {
  value: 'deploy.envType.value',
  configMapKeyRef: 'deploy.envType.configMapKeyRef',
  secretKeyRef: 'deploy.envType.secretKeyRef',
  fieldRef: 'deploy.envType.fieldRef',
  resourceFieldRef: 'deploy.envType.resourceFieldRef',
}
export const ENV_FIELD_LABEL_KEYS = {
  name: 'deploy.envRowName',
  cmName: 'deploy.envField.cmName',
  secretName: 'deploy.envField.secretName',
  key: 'deploy.envField.key',
  fieldPath: 'deploy.envField.fieldPath',
  resource: 'deploy.envField.resource',
  containerName: 'deploy.envField.containerName',
  divisor: 'deploy.envField.divisor',
}
