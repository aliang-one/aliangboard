// 凭据 CRUD + reveal HTTP 端点(2026-09-12 spec §6)。handler/dispatcher 模式(照 routes/workbench-projects.mjs)。
// 鉴权:/api/workbench/ 前缀 ROUTE_AUTH platform 地板已有,端点内 requireAdmin 收严。
// 审计:create/update/delete/reveal 全落链;请求体含敏感明文,审计只记 id/字段名/长度,绝不记值。
import { msg } from '../messages.mjs'
import { maskValue } from '../secret-mask.mjs'
import {
  createCredential, listCredentials, getCredentialRow,
  updateCredential, deleteCredential, materializeField, sanitizeCredential,
} from '../credentials-store.mjs'
import { decryptField } from '../ssh/crypt.mjs'

// 详情视图:text 字段明文(admin 管理面),password 字段掩码指纹(明文只能走 reveal 单字段出口)
function detailView(db, key, id) {
  const row = getCredentialRow(db, id)
  if (!row) return null
  let fields
  try {
    fields = JSON.parse(row.fields || '[]').map(f => {
      let value
      try { value = decryptField(key, f.enc) } catch { throw new Error('CRED_DECRYPT_FAILED') }
      return { key: f.key, type: f.type, value: f.type === 'password' ? maskValue(value) : value }
    })
  } catch (e) { if (e.message === 'CRED_DECRYPT_FAILED') e.status = 409; throw e }
  return { ...sanitizeCredential(row), fields }
}

export function createCredentialsRoutes(deps) {
  const { db, sendJson, readBody, requireAdmin, writeAudit, credCryptKey } = deps

  // 匹配凭据路由;命中并处理返 true;否则返 false。
  async function handle(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean)   // ['api','workbench','credentials',...?]
    if (seg[0] !== 'api' || seg[1] !== 'workbench' || seg[2] !== 'credentials') return false

    // ====== 集合端点 ======
    if (seg.length === 3) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        if (req.method === 'GET') { sendJson(res, 200, { credentials: listCredentials(db) }); return true }
        if (req.method === 'POST') {
          const input = await readBody(req)
          const c = createCredential(db, credCryptKey, input, ps.userId)
          writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_create', result: 'ok',
            requestSummary: `id=${c.id} name=${c.name}`, source: 'platform' })
          sendJson(res, 200, { credential: c }); return true
        }
        sendJson(res, 405, { message: msg(req, 'wcred.methodNotAllowed') }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, req.method === 'POST' ? 'wcred.createFailed' : 'wcred.loadFailed') }); return true }
    }

    // ====== 单条端点 ======
    const id = seg[3]
    // reveal:POST /:id/reveal body {fieldKey}
    if (seg.length === 5 && seg[4] === 'reveal' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const row = getCredentialRow(db, id)
        if (!row) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
        let m
        try { m = materializeField(db, credCryptKey, id, input.fieldKey) }
        catch { sendJson(res, 409, { message: msg(req, 'wcred.decryptFailed') }); return true }
        if (!m) { sendJson(res, 404, { message: msg(req, 'wcred.fieldNotFound') }); return true }
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_reveal', result: 'ok',
          requestSummary: `id=${id} field=${m.key}`, source: 'platform' })
        sendJson(res, 200, { field: m.key, value: m.value }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wcred.decryptFailed') }); return true }
    }

    if (seg.length === 4) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        if (req.method === 'GET') {
          const c = detailView(db, credCryptKey, id)
          if (!c) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
          sendJson(res, 200, { credential: c }); return true
        }
        if (req.method === 'PATCH') {
          const input = await readBody(req)
          const row = getCredentialRow(db, id)
          if (!row) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
          // Task 2 review 携带项:fields 须为数组(store 层把非数组当 [] 处理会静默清空全部字段)
          if (input.fields !== undefined && !Array.isArray(input.fields)) {
            sendJson(res, 400, { message: msg(req, 'wcred.updateFailed') }); return true
          }
          const c = updateCredential(db, credCryptKey, id, input)
          writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_update', result: 'ok',
            requestSummary: `id=${id}`, source: 'platform' })
          sendJson(res, 200, { credential: c }); return true
        }
        if (req.method === 'DELETE') {
          const input = await readBody(req)
          const row = getCredentialRow(db, id)
          if (!row) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
          if (String(input.confirmName ?? '').trim() !== row.name.trim()) {
            sendJson(res, 400, { message: msg(req, 'wcred.confirmNameMismatch') }); return true
          }
          deleteCredential(db, id)
          writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_delete', result: 'ok',
            requestSummary: `id=${id} name=${row.name}`, source: 'platform' })
          sendJson(res, 200, { ok: true }); return true
        }
        sendJson(res, 405, { message: msg(req, 'wcred.methodNotAllowed') }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e.status === 409 && e.message === 'CRED_DECRYPT_FAILED' ? msg(req, 'wcred.decryptFailed') : (e?.message || msg(req, 'wcred.updateFailed')) }); return true }
    }
    return false
  }

  return { handle }
}
