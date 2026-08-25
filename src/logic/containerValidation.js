// Deploy 向导 init/sidecar 容器字段校验(纯函数,无 Vue 依赖,node:test 零依赖可测)。
// 单一事实源:ContainerEditorDialog 实时校验与 DeployApp 提交 validate() 共用——
// 两条编辑入口(原地小卡片/弹窗)规则永远一致。
// 契约:调用方负责「空行整体跳过」(isEmptyEnvRow,与 YAML 生成一致);
// 本函数假定容器存在 → image 必填无条件检查。
import { parseQuantity } from '../composables/useResourceQuantity.js'
import { splitCommandTokens } from '../utils/containerTokens.js'
import { isEmptyEnvRow, firstDuplicateEnvName } from '../utils/envRows.js'

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const CPU_FACTOR = { '': 1000, m: 1 }                     // cores → 毫核
const MEM_FACTOR = { Ki: 1, Mi: 1024, Gi: 1024 ** 2, Ti: 1024 ** 3 } // → Ki

// 规范串 → 归一数值;空/解析失败 → null(不参与比较)
export function quantityValue(str, kind) {
  const { num, unit } = parseQuantity(str, kind)
  if (num === '') return null
  const factor = (kind === 'cpu' ? CPU_FACTOR : MEM_FACTOR)[unit]
  if (factor == null) return null
  return Number(num) * factor
}

// a<b → -1;a>b → 1;相等 → 0;任一侧无效 → null
export function compareQuantity(a, b, kind) {
  const va = quantityValue(a, kind), vb = quantityValue(b, kind)
  if (va == null || vb == null) return null
  return va < vb ? -1 : va > vb ? 1 : 0
}

// 字段校验。c: 8 字符串字段容器对象;otherNames: 除本容器外的名字集合
// (主容器有效名 + 其他容器显式名,自身重复由调用方组集合时按下标排除)。
// 返回 [{ field, msgKey, params }],msgKey 均在 locales deploy.containerFv 下。
export function validateContainerFields(c, otherNames = []) {
  const errs = []
  if (!c.image) errs.push({ field: 'image', msgKey: 'deploy.containerFv.imageRequired', params: {} })
  if (c.name && !DNS1123.test(c.name)) errs.push({ field: 'name', msgKey: 'deploy.containerFv.namePattern', params: {} })
  if (c.name && otherNames.includes(c.name)) errs.push({ field: 'name', msgKey: 'deploy.containerFv.nameDuplicate', params: { name: c.name } })
  if (compareQuantity(c.cpuRequest, c.cpuLimit, 'cpu') === 1) errs.push({ field: 'cpu', msgKey: 'deploy.containerFv.cpuOverLimit', params: { req: c.cpuRequest, lim: c.cpuLimit } })
  if (compareQuantity(c.memoryRequest, c.memoryLimit, 'memory') === 1) errs.push({ field: 'memory', msgKey: 'deploy.containerFv.memoryOverLimit', params: { req: c.memoryRequest, lim: c.memoryLimit } })
  // ports:残行(containerPort 空)跳过;非数字→portRequired;越界→portRange;协议→protocolInvalid
  ;(c.ports || []).forEach((p, i) => {
    if (p.containerPort === '' || p.containerPort == null) return
    const n = Number(p.containerPort)
    if (!Number.isFinite(n)) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.portRequired', params: { idx: i + 1 } })
    else if (n < 1 || n > 65535) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.portRange', params: { idx: i + 1 } })
    if (p.protocol && !['TCP', 'UDP', 'SCTP'].includes(p.protocol)) errs.push({ field: 'ports', msgKey: 'deploy.containerFv.protocolInvalid', params: { idx: i + 1 } })
  })
  // env:三机制残行跳过;非空行缺键报;跨机制重名报
  ;(c.envVars || []).forEach((e, i) => {
    if (!isEmptyEnvRow(e, ['key', 'value']) && !e.key) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { idx: i + 1 } })
  })
  ;(c.envCMKeys || []).forEach(e => {
    if (!isEmptyEnvRow(e, ['name', 'cmName', 'key']) && (!e.name || !e.cmName || !e.key)) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { name: e.name || '—' } })
  })
  ;(c.envSecretKeys || []).forEach(e => {
    if (!isEmptyEnvRow(e, ['name', 'secretName', 'key']) && (!e.name || !e.secretName || !e.key)) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envMissingKey', params: { name: e.name || '—' } })
  })
  const dup = firstDuplicateEnvName(c.envVars || [], c.envCMKeys || [], c.envSecretKeys || [])
  if (dup) errs.push({ field: 'env', msgKey: 'deploy.containerFv.envNameDuplicate', params: { name: dup } })
  // 探针:enabled 时 http/tcp 须 port,exec 须命令
  for (const k of ['liveness', 'readiness', 'startup']) {
    const p = c[k]
    if (!p || !p.enabled) continue
    if ((p.type === 'http' || p.type === 'tcp') && (p.port === '' || p.port == null || isNaN(Number(p.port))))
      errs.push({ field: k, msgKey: 'deploy.containerFv.probePortRequired', params: { probe: k } })
    if (p.type === 'exec' && !splitCommandTokens(p.execCommand).length)
      errs.push({ field: k, msgKey: 'deploy.containerFv.probeCommandRequired', params: { probe: k } })
  }
  return errs
}
