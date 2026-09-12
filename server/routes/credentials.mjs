// 凭据 CRUD + reveal HTTP 端点(2026-09-12 spec §6)。handler/dispatcher 模式(照 routes/workbench-projects.mjs)。
// 鉴权:/api/workbench/ 前缀 ROUTE_AUTH platform 地板已有,端点内 requireAdmin 收严。
// 审计:create/update/delete/reveal 全落链;请求体含敏感明文,审计只记 id/字段名/长度,绝不记值。
import { msg } from '../messages.mjs'
import { maskValue } from '../secret-mask.mjs'
import {
  createCredential, listCredentials, getCredentialRow,
  updateCredential, deleteCredential, materializeField, sanitizeCredential,
  grantCredentialUse, revokeCredentialUse, listCredentialGrants,
} from '../credentials-store.mjs'
import { adapterToolNames } from '../credential-adapters/registry.mjs'
import { decryptField } from '../ssh/crypt.mjs'
import { runCredentialParse } from '../credential-parse.mjs'

// 详情视图:text 字段明文(admin 管理面),password 字段掩码指纹(明文只能走 reveal 单字段出口)
function detailView(db, key, id) {
  const row = getCredentialRow(db, id)
  if (!row) return null
  let fields
  try {
    fields = JSON.parse(row.fields || '[]').map(f => {
      let value
      try { value = decryptField(key, f.enc) } catch { throw new Error('CRED_DECRYPT_FAILED') }
      if (value == null) value = ''   // 空值字段归一:空串加密落库为 null,展示侧回 ''(password 则 maskValue('')=0 字符指纹,truthful)
      return { key: f.key, type: f.type, value: f.type === 'password' ? maskValue(value) : value }
    })
  } catch (e) { if (e.message === 'CRED_DECRYPT_FAILED') e.status = 409; throw e }
  // v2(spec §6):详情附 grants 清单(凭据×适配器免审授权行,管理面展示/前端勾选用)
  return { ...sanitizeCredential(row), fields, grants: listCredentialGrants(db, id) }
}

export function createCredentialsRoutes(deps) {
  const { db, sendJson, readBody, requireAdmin, writeAudit, credCryptKey, getLlmConfig, createLlmClient } = deps

  // 匹配凭据路由;命中并处理返 true;否则返 false。
  async function handle(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean)   // ['api','workbench','credentials',...?]
    if (seg[0] !== 'api' || seg[1] !== 'workbench' || seg[2] !== 'credentials') return false

    // POST /api/workbench/credentials/parse:LLM 智能粘贴解析(spec §9)。admin;不落库;
    // 审计只记动作与原文长度,绝不记 body(请求体含敏感明文)。
    if (seg.length === 4 && seg[3] === 'parse' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const text = String(input.text ?? '')
        if (!text.trim()) { sendJson(res, 400, { message: msg(req, 'wcred.parseFailed') }); return true }
        if (text.length > 65536) { sendJson(res, 400, { message: msg(req, 'wcred.parseFailed') }); return true }   // 64KB 上限:超长原文不进 LLM
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 503, { message: msg(req, 'wcred.llmNotConfigured') }); return true }
        const llmClient = createLlmClient({ ...cfg, temperature: 0 })   // 显式覆写:防对话向参数泄漏进解析任务
        const out = await runCredentialParse({ llmClient, rawText: text })
        if (!out.ok) { sendJson(res, 400, { message: msg(req, 'wcred.parseFailed') }); return true }
        writeAudit?.(db, { owner: ps.username, verb: 'read', tool: 'credential_parse', result: 'ok',
          requestSummary: `len=${text.length} dropped=${out.dropped}`, source: 'platform' })
        sendJson(res, 200, { draft: out.draft, dropped: out.dropped }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wcred.parseFailed') }); return true }
    }

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
      } catch (e) {
        // store 层 bad() 的中文校验错不外泄:400 一律回双语键(其余状态保留 message 透传)
        const failKey = req.method === 'POST' ? 'wcred.createFailed' : 'wcred.loadFailed'
        sendJson(res, e.status || 500, { message: e.status === 400 ? msg(req, failKey) : (e?.message || msg(req, failKey)) }); return true
      }
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

    // grants 子路径:POST /:id/grants body{adapter};DELETE /:id/grants/:adapter(v2 spec §6)。
    // 前置于单条 seg.length===4 块(与 parse/reveal 同族前置法;POST 是 5 段、DELETE 是 6 段,
    // 本就不会落入单条块,前置只为可读性)。adapter 须为已实装适配器(registry 单一事实源)。
    if (seg[4] === 'grants' && req.method === 'POST' && seg.length === 5) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        if (!adapterToolNames().has(String(input.adapter ?? ''))) { sendJson(res, 400, { message: msg(req, 'wcred.unknownAdapter') }); return true }
        const row = getCredentialRow(db, id)
        if (!row) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
        grantCredentialUse(db, id, String(input.adapter), ps.userId)
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_grant_create', result: 'ok', requestSummary: `id=${id} adapter=${input.adapter}`, source: 'platform' })
        sendJson(res, 200, { grant: { adapter: String(input.adapter), grantedBy: ps.userId } }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wcred.updateFailed') }); return true }
    }
    if (seg[3] && seg[4] === 'grants' && seg[5] && req.method === 'DELETE' && seg.length === 6) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        if (!getCredentialRow(db, id)) { sendJson(res, 404, { message: msg(req, 'wcred.notFound') }); return true }
        const ok = revokeCredentialUse(db, id, seg[5])
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'credential_grant_revoke', result: ok ? 'ok' : 'noop', requestSummary: `id=${id} adapter=${seg[5]}`, source: 'platform' })
        sendJson(res, 200, { ok }); return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wcred.updateFailed') }); return true }
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
      } catch (e) {
        // store 层 bad() 的中文校验错不外泄:400 回双语键(PATCH updateFailed / DELETE deleteFailed);409 解密失败映射 decryptFailed
        const failKey = req.method === 'DELETE' ? 'wcred.deleteFailed' : 'wcred.updateFailed'
        const message = e.status === 400 ? msg(req, failKey)
          : (e.status === 409 && e.message === 'CRED_DECRYPT_FAILED') ? msg(req, 'wcred.decryptFailed')
          : (e?.message || msg(req, failKey))
        sendJson(res, e.status || 500, { message }); return true
      }
    }
    return false
  }

  return { handle }
}
