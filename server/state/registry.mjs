// server/state/registry.mjs
// 状态登记处(统一轴向的户口本,spec 2026-09-11 §5):每个内存状态(内核原语或原地重态)
// 登记五样:名称/域/原语类型/describe(聚合快照)。红线:describe 只返回计数与水位,
// 键与值永不离开进程(会话键=token、票据键=票据本体)。模块级单例,单进程网关不变式。
const registrations = new Map() // name -> { name, domain, primitive, describe }

export function registerState({ name, domain = 'misc', primitive = 'registered', describe = null }) {
  if (registrations.has(name)) throw new Error(`state registry: 重名登记 ${name}`)
  registrations.set(name, { name, domain, primitive, describe })
}

export function stateSnapshot() {
  const out = []
  for (const r of registrations.values()) {
    let meta = {}
    try { meta = r.describe ? (r.describe() || {}) : {} }
    catch (e) { meta = { error: String(e?.message || e) } }
    out.push({ name: r.name, domain: r.domain, primitive: r.primitive, ...meta })
  }
  out.sort((a, b) => (a.domain || '').localeCompare(b.domain || '') || (a.name || '').localeCompare(b.name || ''))
  return out
}

export function _clearRegistryForTest() { registrations.clear() }
