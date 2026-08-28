// SSH 服务器 REST(工厂模式同 routes/auth.mjs)。CRUD admin-only(基础设施凭据);
// test 端点 platform 用户即可。所有响应经 sanitizeSshServer——明文凭据永不出路由。
import {
  createSshServer, updateSshServer, deleteSshServer, listSshServers,
  materializeCreds, getSshServerRow,
} from './store.mjs'
import { msg } from '../messages.mjs'

export function createSshRoutes(deps) {
  const { db, sendJson, readBody, requireAdmin, writeAudit, cryptKey, sshTestConnection } = deps

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/ssh/')) return false
    const audit = (verb, tool, result, extra = {}) =>
      writeAudit?.(db, { owner: extra.owner || 'system', verb, tool, result,
        requestSummary: extra.summary || null, source: 'platform', ...extra.fields })
    try {
      // POST /api/ssh/test — 未保存表单试连(body 含明文凭据,仅内存使用不落库)
      if (url.pathname === '/api/ssh/test' && req.method === 'POST') {
        const ps = requireAdmin(req, res); if (!ps) return true
        const input = await readBody(req)
        const out = await sshTestConnection(null, input)
        sendJson(res, 200, out)
        return true
      }
      // /api/ssh/servers 与 /api/ssh/servers/:id[...]
      const rest = url.pathname.slice('/api/ssh/servers'.length)
      if (url.pathname === '/api/ssh/servers' && req.method === 'GET') {
        const ps = requireAdmin(req, res); if (!ps) return true
        sendJson(res, 200, { servers: listSshServers(db, {}) })
        return true
      }
      if (url.pathname === '/api/ssh/servers' && req.method === 'POST') {
        const ps = requireAdmin(req, res); if (!ps) return true
        const input = await readBody(req)
        const row = createSshServer(db, cryptKey, input, ps.username)
        audit('create', 'ssh_server', 'ok', { owner: ps.username, summary: row.name })
        sendJson(res, 200, { server: row, message: msg(req, 'ssh.created') })
        return true
      }
      if (rest.startsWith('/') && rest.split('/').length >= 2) {
        const id = rest.split('/')[1]
        const tail = rest.slice(id.length + 1) // '' | '/test'
        if (tail === '/test' && req.method === 'POST') {
          const ps = requireAdmin(req, res); if (!ps) return true
          const row = getSshServerRow(db, id)
          if (!row) { sendJson(res, 404, { message: msg(req, 'ssh.notFound') }); return true }
          let creds = null
          try { creds = materializeCreds(db, cryptKey, id) }
          catch { sendJson(res, 409, { message: msg(req, 'ssh.credKeyMissing') }); return true }
          const out = await sshTestConnection(row, creds)
          sendJson(res, 200, out)
          return true
        }
        if (!tail && req.method === 'PUT') {
          const ps = requireAdmin(req, res); if (!ps) return true
          const patch = await readBody(req)
          // store 的 update 不做整行校验(Task 2 review 遗留),此处对补丁实际触及的
          // 普通字段做最小校验:port 范围 + aiApprovalPolicy 枚举。
          const errs = []
          if (patch?.port !== undefined && !(Number.isInteger(patch.port) && patch.port >= 1 && patch.port <= 65535)) errs.push('port 须为 1..65535')
          if (patch?.aiApprovalPolicy !== undefined && !['always', 'readonly', 'none'].includes(patch.aiApprovalPolicy)) errs.push('aiApprovalPolicy 非法')
          if (errs.length) { sendJson(res, 400, { message: msg(req, 'ssh.badInput', { reason: errs.join('; ') }) }); return true }
          const row = updateSshServer(db, cryptKey, id, patch)
          if (!row) { sendJson(res, 404, { message: msg(req, 'ssh.notFound') }); return true }
          audit('update', 'ssh_server', 'ok', { owner: ps.username, summary: row.name })
          sendJson(res, 200, { server: row, message: msg(req, 'ssh.updated') })
          return true
        }
        if (!tail && req.method === 'DELETE') {
          const ps = requireAdmin(req, res); if (!ps) return true
          const ok = deleteSshServer(db, id)
          if (!ok) { sendJson(res, 404, { message: msg(req, 'ssh.notFound') }); return true }
          audit('delete', 'ssh_server', 'ok', { owner: ps.username, summary: id })
          sendJson(res, 200, { ok: true, message: msg(req, 'ssh.deleted') })
          return true
        }
      }
      return false
    } catch (e) {
      if (e?.message === 'SSH_CRED_DECRYPT_FAILED') { sendJson(res, 409, { message: msg(req, 'ssh.credKeyMissing') }); return true }
      sendJson(res, e?.status || 500, { message: msg(req, 'ssh.badInput', { reason: e?.message || 'unknown' }) })
      return true
    }
  }
  return { handle }
}
