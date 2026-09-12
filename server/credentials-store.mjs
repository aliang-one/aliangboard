// server/credentials-store.mjs
// workbench_credentials 表 CRUD(2026-09-12 凭据 spec §5)。三铁律(照 ssh/store.mjs):
// ①写入即加密(fields 内所有 value,含 text——加密是存储层概念,可见性是 AI 层概念)
// ②API 层只见 sanitize 行(fields → [{key,type}],任何值不外泄)
// ③明文仅 materializeField 单出口(Task 2)。
// 三态更新语义(Task 2):password 字段 value undefined/''=保持 / null=清除 / 字符串=覆盖;text 全量提交。
import { randomUUID } from 'node:crypto'
import { encryptField, decryptField } from './ssh/crypt.mjs'

export const FIELD_LIMITS = { maxNameLen: 80, maxFields: 32, maxKeyLen: 64, maxValueLen: 16384, maxTags: 8, maxTagLen: 24, maxDescriptionLen: 2000 }
const MASK_PREFIX = '*** ('   // 掩码形态值拒收(fail-safe,同网关仓 normalizePresentedAPIKey 思想)

export function createCredentialsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_credentials (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    expose_to_ai INTEGER NOT NULL DEFAULT 0,
    fields       TEXT NOT NULL DEFAULT '[]',
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_credentials_updated ON workbench_credentials(updated_at DESC)')
  db.exec(`CREATE TABLE IF NOT EXISTS credential_grants (
    id             TEXT PRIMARY KEY,
    credential_id  TEXT NOT NULL,
    adapter        TEXT NOT NULL,
    granted_by     TEXT NOT NULL,
    granted_at     INTEGER NOT NULL,
    UNIQUE (credential_id, adapter)
  )`)
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e }

// §5.4 tags/description 校验,创建与更新共用(undefined = 该项未提交,跳过)。
// tags ≤8 个 × ≤24 字符且须为字符串;description ≤2000 字符。返回错误数组(create 侧汇总,update 侧直接抛)。
function validateCredentialMeta({ tags, description } = {}) {
  const errs = []
  if (tags !== undefined) {
    const list = Array.isArray(tags) ? tags : []
    if (list.length > FIELD_LIMITS.maxTags) errs.push(`标签数超上限 ${FIELD_LIMITS.maxTags}`)
    for (const tg of list) {
      if (typeof tg !== 'string') { errs.push(`标签须为字符串: ${String(tg)}`); continue }
      if (tg.length > FIELD_LIMITS.maxTagLen) errs.push(`标签超 24 字符: ${tg}`)
    }
  }
  if (description !== undefined && String(description ?? '').length > FIELD_LIMITS.maxDescriptionLen) errs.push(`描述超 ${FIELD_LIMITS.maxDescriptionLen} 字符`)
  return errs
}

export function validateCredentialInput(input) {
  const errs = []
  const name = String(input?.name ?? '').trim()
  if (!name || name.length > FIELD_LIMITS.maxNameLen) errs.push('name 必填且 ≤80 字符')
  const fields = Array.isArray(input?.fields) ? input.fields : []
  if (fields.length > FIELD_LIMITS.maxFields) errs.push(`字段数超上限 ${FIELD_LIMITS.maxFields}`)
  const seen = new Set()
  for (const f of fields) {
    const key = String(f?.key ?? '').trim()
    if (!key || key.length > FIELD_LIMITS.maxKeyLen) { errs.push(`字段 key 非法: ${key}`); continue }
    const lower = key.toLowerCase()
    if (seen.has(lower)) errs.push(`字段 key 重复: ${key}`)
    seen.add(lower)
    if (f?.type !== 'text' && f?.type !== 'password') errs.push(`字段 ${key} type 非法: ${f?.type}`)
    if (f?.value != null && typeof f.value !== 'string') errs.push(`字段 ${key} 值须为字符串`)
    if (typeof f?.value === 'string' && f.value.length > FIELD_LIMITS.maxValueLen) errs.push(`字段 ${key} 值超 16KB`)
    if (typeof f?.value === 'string' && f.value.startsWith(MASK_PREFIX)) errs.push(`字段 ${key} 值为掩码形态,拒绝回写`)
  }
  errs.push(...validateCredentialMeta({ tags: input?.tags, description: input?.description }))
  return errs
}

function parseJsonArray(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

export function sanitizeCredential(r) {
  if (!r) return null
  return {
    id: r.id, name: r.name, description: r.description || '',
    tags: parseJsonArray(r.tags),
    exposeToAi: !!r.expose_to_ai,
    fields: parseJsonArray(r.fields).map(f => ({ key: f.key, type: f.type })),
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

export function getCredentialRow(db, id) {
  return db.prepare('SELECT * FROM workbench_credentials WHERE id=?').get(id) || null
}
export function getCredentialSanitized(db, id) { return sanitizeCredential(getCredentialRow(db, id)) }
export function listCredentials(db) {
  return db.prepare('SELECT * FROM workbench_credentials ORDER BY updated_at DESC').all().map(sanitizeCredential)
}

export function createCredential(db, key, input, createdBy = '') {
  const errs = validateCredentialInput(input)
  if (errs.length) throw bad(errs.join('; '))
  const id = randomUUID(), ts = Date.now()
  const encFields = input.fields.map(f => ({ key: String(f.key).trim(), type: f.type, enc: encryptField(key, f.value) }))
  db.prepare(`INSERT INTO workbench_credentials
    (id,name,description,tags,expose_to_ai,fields,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, String(input.name).trim(), String(input.description ?? ''),
      JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
      input.exposeToAi ? 1 : 0, JSON.stringify(encFields), createdBy, ts, ts)
  return getCredentialSanitized(db, id)
}

// patch.fields 数组 = 新字段集(替换语义);password 行三态:无 value/''=保持、null=清除、字符串=覆盖。
function mergeFields(existing, patchFields, key) {
  const byKey = new Map(existing.map(f => [f.key.toLowerCase(), f]))
  const out = [], seen = new Set()
  for (const f of Array.isArray(patchFields) ? patchFields : []) {
    const k = String(f?.key ?? '').trim()
    if (!k || k.length > FIELD_LIMITS.maxKeyLen) throw bad(`字段 key 非法: ${k}`)
    const lower = k.toLowerCase()
    if (seen.has(lower)) throw bad(`字段 key 重复: ${k}`)
    seen.add(lower)
    if (f?.type !== 'text' && f?.type !== 'password') throw bad(`字段 ${k} type 非法: ${f?.type}`)
    const prev = byKey.get(lower)
    if (f.type === 'password') {
      if (f.value === undefined || f.value === '') { if (prev) out.push(prev); continue }   // 保持
      if (f.value === null) continue                                                          // 清除
      if (String(f.value).startsWith(MASK_PREFIX)) throw bad(`字段 ${k} 值为掩码形态,拒绝回写`)
      if (String(f.value).length > FIELD_LIMITS.maxValueLen) throw bad(`字段 ${k} 值超 16KB`)
      out.push({ key: k, type: 'password', enc: encryptField(key, f.value) })                // 覆盖
    } else {
      if (typeof f.value !== 'string') throw bad(`text 字段 ${k} 需字符串值`)
      if (f.value.length > FIELD_LIMITS.maxValueLen) throw bad(`字段 ${k} 值超 16KB`)
      if (f.value.startsWith(MASK_PREFIX)) throw bad(`字段 ${k} 值为掩码形态,拒绝回写`)
      out.push({ key: k, type: 'text', enc: encryptField(key, f.value) })
    }
  }
  if (out.length > FIELD_LIMITS.maxFields) throw bad(`字段数超上限 ${FIELD_LIMITS.maxFields}`)
  return out
}

export function updateCredential(db, key, id, patch = {}) {
  const row = getCredentialRow(db, id)
  if (!row) return null
  // §5.4 校验创建与更新共用:tags/description 走同一钳(未提交的项不校验)
  const metaErrs = validateCredentialMeta({ tags: patch.tags, description: patch.description })
  if (metaErrs.length) throw bad(metaErrs.join('; '))
  const sets = [], args = []
  if (patch.name !== undefined) {
    const n = String(patch.name).trim()
    if (!n || n.length > FIELD_LIMITS.maxNameLen) throw bad('name 必填且 ≤80 字符')
    sets.push('name=?'); args.push(n)
  }
  if (patch.description !== undefined) { sets.push('description=?'); args.push(String(patch.description)) }
  if (patch.exposeToAi !== undefined) { sets.push('expose_to_ai=?'); args.push(patch.exposeToAi ? 1 : 0) }
  if (patch.tags !== undefined) { sets.push('tags=?'); args.push(JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])) }
  if (patch.fields !== undefined) { sets.push('fields=?'); args.push(JSON.stringify(mergeFields(parseJsonArray(row.fields), patch.fields, key))) }
  if (!sets.length) return sanitizeCredential(row)
  sets.push('updated_at=?'); args.push(Date.now()); args.push(id)
  db.prepare(`UPDATE workbench_credentials SET ${sets.join(',')} WHERE id=?`).run(...args)
  return getCredentialSanitized(db, id)
}

export function deleteCredential(db, id) {
  // v2 Task 4 携带项:级联清 grants——孤儿授权行指向不存在的凭据,免审判定凭 (credential_id,
  // adapter) 命中即放行,残留即安全隐患。两删相邻同步执行,无需事务仪式(单进程 sqlite)。
  db.prepare('DELETE FROM credential_grants WHERE credential_id=?').run(id)
  return db.prepare('DELETE FROM workbench_credentials WHERE id=?').run(id).changes > 0
}

export function materializeField(db, key, id, fieldKey) {
  const row = getCredentialRow(db, id)
  if (!row) return null
  const f = parseJsonArray(row.fields).find(x => x.key.toLowerCase() === String(fieldKey ?? '').toLowerCase())
  if (!f) return null
  try { return { key: f.key, type: f.type, value: decryptField(key, f.enc) } }
  catch { throw new Error('CRED_DECRYPT_FAILED') }   // 固定码,路由层映射 409(spec §12)
}

// 系统提示清单(白名单构造:出参只含元数据与字段 {key,type},值/密文永不出现)。
// 防御式降级同 sshPromptServers:workbench_credentials 表可能尚未建(旧库/测试夹具)——
// 清单不可用不该让预览/对话创建整体 500,失败降级空清单(= 无凭据段,语义不变)。
export function listPromptCredentials(db) {
  try {
    return db.prepare('SELECT id,name,description,tags,fields FROM workbench_credentials WHERE expose_to_ai=1 ORDER BY updated_at DESC').all()
      .map(r => ({
        id: r.id, name: r.name, description: r.description || '',
        tags: parseJsonArray(r.tags),
        fields: parseJsonArray(r.fields).map(f => ({ key: f.key, type: f.type })),
      }))
  } catch (e) {
    console.error('[credentials] 提示词凭据清单读取失败,按无凭据装配:', e?.message || e)
    return []
  }
}

// ═══ v2 适配器授权(spec 2026-09-12-v2 §6):凭据×适配器免审 grants。免审只覆盖读路径,
// 写方法恒人审由桥的 needsApproval 分级;免审不免审计(agent-runner approval:auto 标记)。 ═══
export function grantCredentialUse(db, credentialId, adapter, grantedBy) {
  try {
    // ok=本次真实写入(changes>0):重复授权幂等回 {ok:false}(brief 原稿的插入后 SELECT 对已存在行恒真,与其自身测试相悖,此处以测试为准)
    const info = db.prepare('INSERT OR IGNORE INTO credential_grants (id,credential_id,adapter,granted_by,granted_at) VALUES (?,?,?,?,?)')
      .run(randomUUID(), credentialId, String(adapter), grantedBy, Date.now())
    return { ok: info.changes > 0 }
  } catch { return { ok: false } }
}
export function revokeCredentialUse(db, credentialId, adapter) {
  // 防御式降级同 has/list:表缺失(老库未跑 schema 工厂)返 false,不让收回面 500
  try {
    return db.prepare('DELETE FROM credential_grants WHERE credential_id=? AND adapter=?').run(credentialId, String(adapter)).changes > 0
  } catch { return false }
}
export function listCredentialGrants(db, credentialId) {
  try {
    return db.prepare('SELECT adapter, granted_by AS grantedBy, granted_at AS grantedAt FROM credential_grants WHERE credential_id=? ORDER BY granted_at DESC').all(credentialId)
  } catch { return [] }   // 表缺失(老库未跑 schema 工厂)防御式降级,照 listPromptCredentials
}
export function hasCredentialGrant(db, credentialId, adapter) {
  try { return !!db.prepare('SELECT 1 FROM credential_grants WHERE credential_id=? AND adapter=?').get(credentialId, String(adapter)) }
  catch { return false }
}

// 引用解析(id 优先/同名歧义回暴露行候选/not-found 不泄露存在性)——v1 桥内逻辑上提为纯函数,
// 供桥与 approve 端点(remember 写 grants)单一事实源复用。
export function resolveCredentialRef(db, ref) {
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
