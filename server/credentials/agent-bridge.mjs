// AI ↔ 凭据桥(2026-09-12 spec §7)。铁律(照 ssh/agent-bridge.mjs):
// ①明文只在桥闭包内 materialize,不外溢;②text 字段明文可回模型(AI 可见等级),password 字段
// 只回 maskValue 指纹 + ref 'cred:<id>#<key>'(v2 执行工具注入协议);③not-found/not-exposed
// 文案不泄露未暴露凭据的存在性(resolveServerRef 同款语义)。
import { listCredentials, materializeField } from '../credentials-store.mjs'
import { maskValue } from '../secret-mask.mjs'

export function createCredentialsAgentBridge({ db, key }) {
  const listExposed = () => listCredentials(db).filter(c => c.exposeToAi)
  // 解析:id 优先;同名歧义只回暴露行候选;not-found 与 not-exposed 文案可区分但都不泄露更多
  function resolve(ref) {
    const r = String(ref ?? '').trim()
    if (!r) return { ok: false, reason: 'not-found', candidates: [] }
    const all = listCredentials(db)
    const byId = all.find(x => x.id === r)
    if (byId) return byId.exposeToAi ? { ok: true, row: byId } : { ok: false, reason: 'not-exposed', candidates: [] }
    const named = all.filter(x => x.name === r)
    if (!named.length) return { ok: false, reason: 'not-found', candidates: [] }
    const exposedNamed = named.filter(x => x.exposeToAi)
    if (named.length > 1) {
      if (!exposedNamed.length) return { ok: false, reason: 'not-exposed', candidates: [] }
      return { ok: false, reason: 'ambiguous', candidates: exposedNamed.map(x => ({ id: x.id, name: x.name })) }
    }
    return exposedNamed.length ? { ok: true, row: named[0] } : { ok: false, reason: 'not-exposed', candidates: [] }
  }

  async function list() {
    return { credentials: listExposed().map(c => ({ ...c, ref: `cred:${c.id}` })) }
  }

  async function read(args) {
    const r = resolve(args?.credential)
    if (!r.ok) return { error: refusal(r) }
    const s = r.row
    const want = args?.field
      ? s.fields.filter(f => f.key.toLowerCase() === String(args.field).toLowerCase())
      : s.fields
    if (!want.length) return { error: `凭据 ${s.name} 无字段 ${args?.field}` }
    const fields = []
    for (const meta of want) {
      const out = { key: meta.key, type: meta.type, ref: `cred:${s.id}#${meta.key}` }
      let m = null
      try { m = materializeField(db, key, s.id, meta.key) } catch { m = null }
      if (!m) { out.error = 'CRED_DECRYPT_FAILED' }
      else out.value = m.type === 'password' ? maskValue(m.value) : m.value
      fields.push(out)
    }
    return { credential: s.name, id: s.id, fields }
  }

  return { listExposed, list, read }
}

function refusal(r) {
  if (r.reason === 'not-found') return '未找到该凭据,可用清单见系统提示'
  if (r.reason === 'not-exposed') return '该凭据未暴露给 AI'
  if (r.reason === 'ambiguous') return `名称对应多条凭据,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
  return '凭据不可用'
}
