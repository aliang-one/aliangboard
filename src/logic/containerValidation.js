// Deploy 向导 init/sidecar 容器字段校验(纯函数,无 Vue 依赖,node:test 零依赖可测)。
// 单一事实源:ContainerEditorDialog 实时校验与 DeployApp 提交 validate() 共用——
// 两条编辑入口(原地小卡片/弹窗)规则永远一致。
// 契约:env 行空行整体跳过(envRefErrors 内建,与 YAML 生成一致);
// 本函数假定容器存在 → image 必填无条件检查。
import { toBaseValue } from '../composables/useResourceQuantity.js'
import { splitCommandTokens } from '../utils/containerTokens.js'
import { envRefErrors, duplicateEnvNames } from './envRefs.js'

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

// 规范串 → 归一数值(cpu=毫核/memory=Ki,完整 K8s 文法:十进制 SI/二进制/科学计数);
// 空/解析失败 → null(不参与比较)。2026-10-11:曾沿用 parseQuantity 的 UI 单位表回退,
// compareQuantity('100u','250m') 误判超限(真值 0.1m≤250m)——假阳性阻断合法保存、
// 假阴性漏成 apiserver 422。
export function quantityValue(str, kind) {
  return toBaseValue(str, kind)
}

// a<b → -1;a>b → 1;相等 → 0;任一侧无效 → null。
// 浮点容差:0.1 cores×1000=100.00000000000001 类尾迹不得把等值判成超限。
export function compareQuantity(a, b, kind) {
  const va = quantityValue(a, kind), vb = quantityValue(b, kind)
  if (va == null || vb == null) return null
  const eps = 1e-9 * Math.max(1, Math.abs(va), Math.abs(vb))
  return va < vb - eps ? -1 : va > vb + eps ? 1 : 0
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
  // env:统一行模型;空行跳过、半行报(CED 语境用精简文案,精确字段清单在创建/编辑主面)
  for (const e of envRefErrors(c.envRows || []))
    errs.push({ field: 'env', msgKey: 'deploy.containerFv.envRowMissing', params: { name: e.name || `#${e.index + 1}` } })
  const dup = duplicateEnvNames(c.envRows || [])
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
