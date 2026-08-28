// SSH 服务器 REST(工厂模式同 routes/auth.mjs)。CRUD admin-only(基础设施凭据);
// test 端点同 requireAdmin(admin-only)。所有响应经 sanitizeSshServer——明文凭据永不出路由。
// /api/sshfile/*:平台用户可用自己可见服务器的 SFTP 文件浏览/上传/下载(复用 podfile 传输骨架与限额)。
import {
  createSshServer, updateSshServer, deleteSshServer, listSshServers,
  materializeCreds, getSshServerRow,
} from './store.mjs'
import { msg } from '../messages.mjs'
import { withSftp, sftpReaddir, sftpStatSize, sftpStreamSession } from './sftp.mjs'
import { streamUpload, streamDownload } from '../podfile-stream.mjs'

export function createSshRoutes(deps) {
  const { db, sendJson, readBody, requirePlatform, requireAdmin, writeAudit, cryptKey, sshTestConnection, sshPool, getSshfileLimitBytes } = deps

  async function handle(req, res, url) {
    // /api/sshfile/* 先于 /api/ssh/ 前缀判定('/api/sshfile/x' 严格说并不匹配 '/api/ssh/',但先行分支杜绝任何误配/阅读歧义)
    if (url.pathname.startsWith('/api/sshfile/')) {
      const action = url.pathname.slice('/api/sshfile/'.length)
      const ps = requirePlatform(req, res); if (!ps) return true
      // upload 是原始二进制流:绝不能 readBody(整包缓冲),元信息全走查询串
      if (action === 'upload') {
        const serverId = url.searchParams.get('serverId')
        const path = url.searchParams.get('path') || '/'
        const name = (url.searchParams.get('name') || 'upload.bin').trim()
        // name 只允许文件名:拒绝 / 与 ..(防路径穿越写)
        if (!serverId) { sendJson(res, 400, { message: msg(req, 'ssh.badInput', { reason: 'serverId' }) }); return true }
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name === '.' ) {
          sendJson(res, 400, { message: msg(req, 'ssh.badInput', { reason: 'name' }) }); return true
        }
        let conn = null
        try {
          const m = materializeCreds(db, cryptKey, serverId)
          if (!m) { sendJson(res, 404, { message: msg(req, 'ssh.notFound') }); return true }
          conn = await sshPool.acquire(serverId, ps.username)
          const target = (path.endsWith('/') ? path : path + '/') + name
          const contentLength = parseInt(req.headers['content-length'] || '', 10)
          const out = await streamUpload({
            contentLength, limitBytes: getSshfileLimitBytes(), req,
            openConn: (input) => sftpStreamSession(conn.client, s => {
              const ws = s.createWriteStream(target)
              input.pipe(ws)
              return ws
            }),
          })
          sendJson(res, 200, { ok: true, bytes: out.bytes, path: target })
          return true
        } catch (e) {
          if (e?.message === 'SSH_CRED_DECRYPT_FAILED') { sendJson(res, 409, { message: msg(req, 'ssh.credKeyMissing') }); return true }
          console.error('[sshfile/upload]', e?.status || '', e?.message || e)
          if (e.canceled) return sendJson(res, 499, { message: msg(req, 'api.uploadCanceled') })
          sendJson(res, e?.status || 502, { message: e?.message || msg(req, 'ssh.testGeneric', { message: 'sftp failed' }) })
          return true
        } finally { try { conn?.release() } catch { /* noop */ } }
      }
      const body = action === 'list' || action === 'download' ? await readBody(req) : null
      const serverId = body?.serverId || url.searchParams.get('serverId')
      const path = body?.path || url.searchParams.get('path') || '/'
      if (!serverId) { sendJson(res, 400, { message: msg(req, 'ssh.badInput', { reason: 'serverId' }) }); return true }
      let conn = null
      try {
        const m = materializeCreds(db, cryptKey, serverId)
        if (!m) { sendJson(res, 404, { message: msg(req, 'ssh.notFound') }); return true }
        conn = await sshPool.acquire(serverId, ps.username)
        if (action === 'list') {
          const entries = await withSftp(conn.client, s => sftpReaddir(s, path))
          sendJson(res, 200, { path, entries })
          return true
        }
        if (action === 'download') {
          const size = await withSftp(conn.client, s => sftpStatSize(s, path))
          const base = ((path.split('/').pop() || 'download').replace(/[^\w.-]/g, '_')) || 'download'
          res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*')
          res.setHeader('access-control-expose-headers', 'content-disposition')
          // openConn 契约(照 podfile):sink 为 base64 行解码器——sftp 流逐块 base64 行化喂入
          await streamDownload({
            statBytes: size, limitBytes: getSshfileLimitBytes(), res, filename: base,
            openConn: (sink, stderrSink) => sftpStreamSession(conn.client, s => {
              const rs = s.createReadStream(path)
              rs.on('data', d => sink.write(d.toString('base64') + '\n'))
              rs.on('end', () => sink.end())
              // 中途错误必须显式中断:只 destroy 流不发信号的话,streamDownload 会在头部已发时照常
              // res.end() → 产出短于 content-length 的假 200。错误文案写入 stderrSink(头部未发时
              // 由 streamDownload 变成 4xx 响应体,照 podfile 的 stderr 惯例),并 destroy sink
              // (其 'close' 是 streamDownload 的结算路径);rs 本身是 conn,'error' 事件同步触发
              // streamDownload 的 connErrored → res.destroy()。
              rs.on('error', e => {
                try { stderrSink?.write(String(e?.message || e) + '\n') } catch { /* noop */ }
                try { sink.destroy() } catch { /* noop */ }
                try { rs.destroy() } catch { /* noop */ }
              })
              return rs
            }),
          })
          return true
        }
        sendJson(res, 404, { message: msg(req, 'ssh.notFound') })
        return true
      } catch (e) {
        if (e?.message === 'SSH_CRED_DECRYPT_FAILED') { sendJson(res, 409, { message: msg(req, 'ssh.credKeyMissing') }); return true }
        console.error(`[sshfile/${action}]`, e?.status || '', e?.message || e)
        if (!res.headersSent) sendJson(res, e?.status || 502, { message: e?.message || msg(req, 'ssh.testGeneric', { message: 'sftp failed' }) })
        else res.destroy()
        return true
      } finally { try { conn?.release() } catch { /* noop */ } }
    }
    if (!url.pathname.startsWith('/api/ssh/')) return false
    const audit = (verb, tool, result, extra = {}) =>
      writeAudit?.(db, { owner: extra.owner || 'system', verb, tool, result,
        requestSummary: extra.summary || null, source: 'platform', ...extra.fields })
    // 试连失败按 errorKind 组装本地化 message(spec §9:不把原始英文 ssh2 错误怼给用户);errorKind 原样保留供前端分流(hostkey 触发重置确认)
    const localizeTestError = (req, out) => {
      const m = out?.errorKind === 'unreachable' ? msg(req, 'ssh.testUnreachable', { kind: out.message })
        : out?.errorKind === 'auth' ? msg(req, 'ssh.testAuthFailed')
        : out?.errorKind === 'hostkey' ? msg(req, 'ssh.testHostkey')
        : msg(req, 'ssh.testGeneric', { message: out?.message || 'unknown' })
      return m
    }
    try {
      // POST /api/ssh/test — 未保存表单试连(body 含明文凭据,仅内存使用不落库)
      if (url.pathname === '/api/ssh/test' && req.method === 'POST') {
        const ps = requireAdmin(req, res); if (!ps) return true
        const input = await readBody(req)
        let out = await sshTestConnection(null, input)
        writeAudit(db, { owner: ps.username, verb: 'test', tool: 'ssh_server', result: out.ok ? 'ok' : 'error', reason: out.ok ? null : out.errorKind, requestSummary: 'form', source: 'platform' })
        if (!out.ok) out = { ...out, message: localizeTestError(req, out) }
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
          writeAudit(db, { owner: ps.username, verb: 'test', tool: 'ssh_server', result: out.ok ? 'ok' : 'error', reason: out.ok ? null : out.errorKind, requestSummary: row.name, source: 'platform' })
          sendJson(res, 200, out.ok ? out : { ...out, message: localizeTestError(req, out) })
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
