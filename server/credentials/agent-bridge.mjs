// AI ↔ 凭据桥(2026-09-12 spec §7)。铁律(照 ssh/agent-bridge.mjs):
// ①明文只在桥闭包内 materialize,不外溢;②text 字段明文可回模型(AI 可见等级),password 字段
// 只回 maskValue 指纹 + ref 'cred:<id>#<key>'(v2 执行工具注入协议);③not-found/not-exposed
// 文案不泄露未暴露凭据的存在性(resolveServerRef 同款语义)。
import { listCredentials, materializeField, resolveCredentialRef, hasCredentialGrant } from '../credentials-store.mjs'
import { getAdapter, matchAdapter } from '../credential-adapters/registry.mjs'
import { maskValue } from '../secret-mask.mjs'

export function createCredentialsAgentBridge({ db, key }) {
  const listExposed = () => listCredentials(db).filter(c => c.exposeToAi)
  // 解析:id 优先;同名歧义只回暴露行候选;not-found 与 not-exposed 文案可区分但都不泄露更多
  function resolve(ref) { return resolveCredentialRef(db, ref) }

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
      else {
        // 空值字段归一:空串加密落库为 null,回模型前归 ''(text 回空串,password 走 maskValue('')=0 字符指纹,truthful)
        const v = m.value == null ? '' : m.value
        out.value = m.type === 'password' ? maskValue(v) : v
      }
      fields.push(out)
    }
    return { credential: s.name, id: s.id, fields }
  }

  // ═══ v2 适配器面(spec v2 §5/§6)。needsApproval 必须纯(读库判定,无写副作用)——checkpoint 与
  // resume 两处被咨询。读路径判定:manifest.readonlyMethods 含本次 method(db_query 恒只读)。
  async function needsApproval(name, args) {
    const a = getAdapter(name)
    if (!a) return true                                  // 非适配器工具恒人审(fail-closed)
    const r = resolveCredentialRef(db, args?.credential)
    if (!r.ok) return true                               // 解析失败也人审(用户会看到错误)
    if (!matchAdapter(name, r.row).ok) return true       // 形状不符:人审下暴露错误更安全
    const method = String(args?.method || 'GET').toUpperCase()
    const readonly = (a.manifest.readonlyMethods || ['GET']).includes(method) || !a.manifest.readonlyMethods
    if (!readonly) return true                           // 写方法恒人审(spec §6.2)
    return !hasCredentialGrant(db, r.row.id, name)       // grant 命中+读路径 → 免审
  }

  async function runAdapter(name, args) {
    const a = getAdapter(name)
    if (!a) return { error: `未知适配器: ${name}` }
    const r = resolveCredentialRef(db, args?.credential)
    if (!r.ok) return { error: refusal(r) }
    const m = matchAdapter(name, r.row)
    if (!m.ok) return { error: `该凭据字段结构与 ${name} 不匹配(缺 ${m.missing.join('/')})` }
    // 字段解密在本闭包:适配器 exec 拿到的 fields 只活在函数调用栈内
    const needKeys = new Set(Object.keys(a.manifest.needs).map(k => k.toLowerCase()))
    const fields = {}
    for (const meta of r.row.fields) {
      if (!needKeys.has(meta.key.toLowerCase())) continue
      try { const mv = materializeField(db, key, r.row.id, meta.key); fields[meta.key] = mv?.value ?? '' }
      catch { return { error: 'CRED_DECRYPT_FAILED' } }
    }
    try { return await a.exec({ fields, args }) }
    catch (e) { return { error: `适配器执行失败(${e?.name || 'unknown'})` } }
  }

  return { listExposed, list, read, needsApproval, runAdapter }
}

function refusal(r) {
  if (r.reason === 'not-found') return '未找到该凭据,可用清单见系统提示'
  if (r.reason === 'not-exposed') return '该凭据未暴露给 AI'
  if (r.reason === 'ambiguous') return `名称对应多条凭据,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
  return '凭据不可用'
}
