// server/credentials-store.mjs
// workbench_credentials 表 CRUD(2026-09-12 凭据 spec §5)。三铁律(照 ssh/store.mjs):
// ①写入即加密(fields 内所有 value,含 text——加密是存储层概念,可见性是 AI 层概念)
// ②API 层只见 sanitize 行(fields → [{key,type}],任何值不外泄)
// ③明文仅 materializeField 单出口(Task 2)。
// 三态更新语义(Task 2):password 字段 value undefined/''=保持 / null=清除 / 字符串=覆盖;text 全量提交。
import { randomUUID } from 'node:crypto'
import { encryptField, decryptField } from './ssh/crypt.mjs'

export const FIELD_LIMITS = { maxNameLen: 80, maxFields: 32, maxKeyLen: 64, maxValueLen: 16384, maxTags: 8, maxTagLen: 24 }
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
}

function bad(msg) { const e = new Error(msg); e.status = 400; return e }

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
  const tags = Array.isArray(input?.tags) ? input.tags : []
  if (tags.length > FIELD_LIMITS.maxTags) errs.push(`标签数超上限 ${FIELD_LIMITS.maxTags}`)
  for (const tg of tags) if (String(tg).length > FIELD_LIMITS.maxTagLen) errs.push(`标签超 24 字符: ${tg}`)
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
