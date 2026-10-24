// AI ↔ 凭据桥(2026-09-12 spec §7)。铁律(照 ssh/agent-bridge.mjs):
// ①明文只在桥闭包内 materialize,不外溢;②text 字段明文可回模型(AI 可见等级),password 字段
// 只回 maskValue 指纹 + ref 'cred:<id>#<key>'(v2 执行工具注入协议);③not-found/not-exposed
// 文案不泄露未暴露凭据的存在性(resolveServerRef 同款语义)。
import { listCredentials, materializeField, resolveCredentialRef, hasCredentialGrant, AI_READABLE_MAX_VALUE_LEN } from '../credentials-store.mjs'
import { getAdapter, matchAdapter } from '../credential-adapters/registry.mjs'
import { maskValue } from '../secret-mask.mjs'
import { rememberCredentialValue } from '../credential-known-values.mjs'

// cred: 占位符协议(2026-09-20 spec §7):{{cred:<名或id>#<字段>}}。纯模式判定,供审批门
// (wb-approval-mode / routeDynamicApproval)与工具包装(tool-registry)同源复用——两处门都问
// 同一个谓词,缺一即漏(auto 档 wb_exec 走模式白名单、免审服务器走桥策略,各绕开对方)。
// 2026-10-24 审计:递归走嵌套数组/对象——LLM 自拟 args 形态不可信,顶层扫描可被数组形态
// command 绕过恒人审门(虽然注入层不物化数组命令,门与谓词必须同源同深度)。
export const CRED_REF_RE = /\{\{cred:([^#}]+)#([^}]+)\}\}/g
const WALK_DEPTH_MAX = 8
function walkArgStrings(args, fn, depth = 0) {
  if (!args || typeof args !== 'object' || depth > WALK_DEPTH_MAX) return
  for (const v of Object.values(args)) {
    if (typeof v === 'string') fn(v)
    else if (v && typeof v === 'object') walkArgStrings(v, fn, depth + 1)
  }
}
export function containsCredRef(args) {
  let hit = false
  walkArgStrings(args, s => { if (!hit && s.includes('{{cred:')) hit = true })
  return hit
}

// I1(2026-09-20 final review):取首个含占位符字符串参数里的凭据名(wbAuditIntent 审计归因消费:
// wb_exec/wb_ssh_exec 的 args 无 server/credential 键,占位符是唯一凭据线索)。无命中返 null
// (消费方兜底 'unknown',fail-visible);matchAll 不动模块级 RE 的 lastIndex(同 substitute)。
export function firstCredRefName(args) {
  let found = null
  walkArgStrings(args, s => {
    if (found) return
    const m = s.matchAll(CRED_REF_RE).next().value   // 首个占位符即停(归因取首线索足够)
    if (m) found = String(m[1] || '').trim() || 'unknown'
  })
  return found
}

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
    // 🔓明文合计闸(2026-10-24 审计 P0):单字段 ≤4096 的 M3 上限只护住单字段读取;field 省略
    // 返回全字段是默认用法,多个合规明文合计可越过 8192 工具内容钳制,截断把 JSON 切成裸串
    // 后落库洗涤失明(审计 HIGH 的多字段形态)。合计超限整体拒读(fail-closed),逼逐字段读取。
    let plainTotal = 0
    for (const meta of want) {
      if (meta.type !== 'password' || !meta.aiReadable) continue
      let m = null
      try { m = materializeField(db, key, s.id, meta.key) } catch { m = null }
      if (m) plainTotal += (m.value == null ? '' : m.value).length
    }
    if (plainTotal > AI_READABLE_MAX_VALUE_LEN) {
      return { error: `凭据 ${s.name} 的 🔓 明文字段合计 ${plainTotal} 字符超限(>${AI_READABLE_MAX_VALUE_LEN}),请用 field 参数逐字段读取` }
    }
    const fields = []
    for (const meta of want) {
      const out = { key: meta.key, type: meta.type, ref: `cred:${s.id}#${meta.key}` }
      let m = null
      try { m = materializeField(db, key, s.id, meta.key) } catch { m = null }
      if (!m) { out.error = 'CRED_DECRYPT_FAILED' }
      else {
        // 空值字段归一:空串加密落库为 null,回模型前归 ''(text 回空串,password 走 maskValue('')=0 字符指纹,truthful)
        const v = m.value == null ? '' : m.value
        if (m.type === 'password' && meta.aiReadable) {
          out.value = v; out.plaintext = true   // 🔓明文通道(spec §6):工具恒 requiresApproval=每读必人审
          rememberCredentialValue(v, `${s.name}#${meta.key}`)   // 值级登记(P0-1,带溯源供占位符洗)
        }
        else out.value = m.type === 'password' ? maskValue(v) : v
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
    // 回显洗 + 值级登记(2026-10-24 审计 P1):V2 红线 1「明文永不进返回值」在回显型端点
    // (echo Authorization / 错误页回带凭据)有条件破口——适配器响应此前只做 JWT/PEM/AKIA 形态
    // 脱敏,api_token 形态穿透。此处携带本次消费值集对结果 scrubDeep,与注入通道(往返双洗)
    // 对称。in-run 洗脱阈值 8 字符:更短的值('true'/'1234')在响应正文里合法高频出现,整值
    // 替换会把 AI 的数据视图洗烂——短密码本就可暴力枚举,指纹化收益抵不过误伤成本。
    // 消费值同时进登记表(≥4 字符),供持久化边界的值级兜底洗涤。
    const pairs = [...new Set(Object.values(fields).filter(v => typeof v === 'string' && v.length >= 8))]
      .map(v => {
        const meta = r.row.fields.find(fm => fields[fm.key] === v)
        return { value: v, mask: maskValue(v), ref: meta ? `${r.row.name}#${meta.key}` : undefined }
      })
    for (const p of pairs) rememberCredentialValue(p.value, p.ref)
    const scrubValues = t => { let x = String(t ?? ''); for (const p of pairs) x = x.split(p.value).join(p.mask); return x }
    try {
      const res = await a.exec({ fields, args })
      return pairs.length ? scrubResultDeep(res, scrubValues) : res
    }
    catch (e) { return { error: `适配器执行失败(${e?.name || 'unknown'})` } }
  }

  // cred: 执行点注入(spec §7):物化只发生在本闭包;scrub 携带本次值集,回传输出精确洗回指纹
  // (往返双洗)。fail-closed:任一占位符解析失败整体拒,绝不执行部分物化命令。空值不进洗集
  // (split/join 空串灾难);matchAll 不动原 regex lastIndex,模块级 RE 复用安全。
  function substitute(text) {
    const s = String(text ?? '')
    const matches = [...s.matchAll(CRED_REF_RE)]
    if (!matches.length) return { ok: true, text: s, refs: [], scrub: x => x }
    let out = s
    const refs = [], pairs = [], seen = new Set()
    for (const m of matches) {
      const r = resolve(m[1].trim())
      if (!r.ok) return { ok: false, error: refusal(r) }
      const fieldKey = m[2].trim()
      const meta = r.row.fields.find(f => f.key.toLowerCase() === fieldKey.toLowerCase())
      if (!meta) return { ok: false, error: `凭据 ${r.row.name} 无字段 ${fieldKey}` }
      let mv
      try { mv = materializeField(db, key, r.row.id, meta.key) } catch { mv = null }
      if (!mv) return { ok: false, error: 'CRED_DECRYPT_FAILED' }
      const value = mv.value == null ? '' : mv.value
      out = out.split(m[0]).join(value)
      refs.push({ name: r.row.name, id: r.row.id, field: meta.key, type: meta.type })
      if (value && !seen.has(value)) {
        seen.add(value)
        pairs.push({ value, mask: maskValue(value) })
        rememberCredentialValue(value, `${r.row.name}#${meta.key}`)   // 值级登记(P0-1,带溯源)
      }
    }
    return { ok: true, text: out, refs,
      scrub: t => { let x = String(t ?? ''); for (const p of pairs) x = x.split(p.value).join(p.mask); return x } }
  }

  return { listExposed, list, read, needsApproval, runAdapter, substitute }
}

function refusal(r) {
  if (r.reason === 'not-found') return '未找到该凭据,可用清单见系统提示'
  if (r.reason === 'not-exposed') return '该凭据未暴露给 AI'
  if (r.reason === 'ambiguous') return `名称对应多条凭据,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
  return '凭据不可用'
}

// 适配器结果的值级洗:深走对象/数组(深度上限 8 防循环),裸字符串同样处理。
// (与 secret-mask.scrubDeep 同构;不复用以保持桥内 pairs 闭包自洽。)
function scrubResultDeep(value, scrub, depth = 0) {
  if (typeof value === 'string') return scrub(value)
  if (value == null || typeof value !== 'object' || depth > 8) return value
  if (Array.isArray(value)) return value.map(v => scrubResultDeep(v, scrub, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = scrubResultDeep(v, scrub, depth + 1)
  return out
}
