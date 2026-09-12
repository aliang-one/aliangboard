// server/credentials-store.mjs
// workbench_credentials 表 CRUD(2026-09-12 凭据 spec §5)。三铁律(照 ssh/store.mjs):
// ①写入即加密(fields 内所有 value,含 text——加密是存储层概念,可见性是 AI 层概念)
// ②API 层只见 sanitize 行(fields → [{key,type}],任何值不外泄)
// ③明文仅 materializeField 单出口(Task 2)。
// 三态更新语义(Task 2):password 字段 value undefined/''=保持 / null=清除 / 字符串=覆盖;text 全量提交。
import { randomUUID } from 'node:crypto'
import { encryptField } from './ssh/crypt.mjs'

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
