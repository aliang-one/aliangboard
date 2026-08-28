// AI ↔ SSH 桥:解析 server 引用(id 优先/name 唯一)、按服务器策略回答审批、exec/readFile(SFTP)。
// 铁律:凭据只在 pool/连接闭包内;结果/错误只含 exitCode/stdout/stderr/durationMs,绝不含凭据;
// not-exposed 与 not-found 的文案不得回显 host(不泄露未暴露服务器的存在细节)。
// needsApproval 必须纯(无 IO 副作用/日志/审计)——agent.mjs 在 checkpoint 与 resume 两处都会调它。
import { listSshServers, materializeCreds } from './store.mjs'
import { classifyReadonly, buildSudoCommand } from './readonly-classifier.mjs'

const TIMEOUT_DEFAULT_MS = 30000, TIMEOUT_MIN_MS = 1000, TIMEOUT_MAX_MS = 120000
const STDOUT_MAX = 32768, STDERR_MAX = 8192
const READFILE_MAX_DEFAULT = 65536, READFILE_MAX = 1048576

// 纯函数:rows 为全量原始行(exposeToAi 0/1)。id 优先;name 只在暴露行中解析(歧义候选仅含暴露行);
// 有同名但未暴露 → not-exposed;完全无名 → not-found。
export function resolveServerRef(rows, ref) {
  const r = String(ref || '').trim()
  if (!r) return { ok: false, reason: 'not-found', candidates: [] }
  const byId = rows.find(x => x.id === r)
  if (byId) return byId.exposeToAi ? { ok: true, row: byId } : { ok: false, reason: 'not-exposed', candidates: [] }
  const named = rows.filter(x => x.name === r)
  if (named.length === 0) return { ok: false, reason: 'not-found', candidates: [] }
  // 同名多台(含未暴露)即歧义——AI 无法自证指向哪台;候选只列暴露行(不泄露未暴露行)。
  if (named.length > 1) {
    const exposed = named.filter(x => x.exposeToAi)
    return { ok: false, reason: 'ambiguous', candidates: exposed.map(x => ({ id: x.id, name: x.name })) }
  }
  return named[0].exposeToAi ? { ok: true, row: named[0] } : { ok: false, reason: 'not-exposed', candidates: [] }
}

export function createSshAgentBridge({ db, key, pool, projectId, actor = 'agent' }) {
  // AI 可见清单:仅暴露行,仅元数据字段(无 host/凭据列)。
  const listExposed = () => listSshServers(db, { exposedOnly: true })
    .map(s => ({ id: s.id, name: s.name, description: s.description || '', clusterRef: s.clusterRef || '' }))
  // 解析面读全量原始行(含未暴露)以正确区分 not-found/not-exposed;host 不参与解析。
  function resolve(ref) {
    const all = db.prepare('SELECT id,name,host,port,username,authMethod,exposeToAi,aiApprovalPolicy FROM ssh_servers').all()
    return resolveServerRef(all, ref)
  }
  // 纯(仅同步 DB 读):静态 requiresApproval 命中后由 agent-runner 咨询。
  async function needsApproval(name, args) {
    const r = resolve(args?.server)
    if (!r.ok) return true                        // 解析失败:安全默认走人审(错误信息随后由 exec 给出)
    if (r.row.aiApprovalPolicy === 'none') return false
    if (r.row.aiApprovalPolicy === 'readonly') {
      if (name === 'wb_ssh_read_file') return false
      return !classifyReadonly(args?.command)
    }
    return true                                   // always
  }
  async function exec(args) {
    const started = Date.now()
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const row = r.row
    let cmd = String(args?.command || '')
    if (!cmd.trim()) return { error: 'command 为空' }
    const timeoutMs = Math.min(Math.max((Number(args?.timeoutSec) * 1000) || TIMEOUT_DEFAULT_MS, TIMEOUT_MIN_MS), TIMEOUT_MAX_MS)
    let stdinPassword = null
    if (args?.sudo) {
      let creds = null
      try { creds = materializeCreds(db, key, row.id) } catch { return { error: 'SSH_CRED_DECRYPT_FAILED' } }
      if (!creds?.sudoPassword) return { error: '该服务器未配置 sudo 密码,无法以 sudo 执行' }
      cmd = buildSudoCommand(cmd)
      stdinPassword = creds.sudoPassword
    }
    let conn
    try { conn = await pool.acquire(row.id, `wb:${projectId}`) }
    catch (e) { return { error: `SSH 连接失败(${e.errorKind || 'unknown'})` } }
    try {
      return await new Promise(resolveP => {
        conn.client.exec(cmd, (err, stream) => {
          if (err) return resolveP({ error: String(err.message || err) })
          if (stdinPassword != null) stream.write(stdinPassword + '\n')
          let out = Buffer.alloc(0), errBuf = Buffer.alloc(0), exitCode = null, done = false
          const finish = () => { if (done) return; done = true
            resolveP({ exitCode, stdout: out.toString('utf8'), stderr: errBuf.toString('utf8'),
              stdoutTruncated: out.length >= STDOUT_MAX, stderrTruncated: errBuf.length >= STDERR_MAX,
              durationMs: Date.now() - started }) }
          const timer = setTimeout(() => { done = true; try { stream.close() } catch {}; resolveP({ exitCode: null, timedOut: true, stdout: out.toString('utf8'), stderr: errBuf.toString('utf8'), durationMs: Date.now() - started }) }, timeoutMs)
          stream.on('data', d => { if (out.length < STDOUT_MAX) out = Buffer.concat([out, d]).subarray(0, STDOUT_MAX) })
          stream.stderr?.on?.('data', d => { if (errBuf.length < STDERR_MAX) errBuf = Buffer.concat([errBuf, d]).subarray(0, STDERR_MAX) })
          stream.on('exit', code => { exitCode = code })
          stream.on('close', () => { clearTimeout(timer); finish() })
          stream.on('error', e2 => { clearTimeout(timer); done = true; resolveP({ error: String(e2.message || e2) }) })
        })
      })
    } finally { try { conn.release() } catch {} }
  }
  async function readFile(args) {
    const started = Date.now()
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const row = r.row
    const maxBytes = Math.min(Math.max(Number(args?.maxBytes) || READFILE_MAX_DEFAULT, 1), READFILE_MAX)
    const path = String(args?.path || '')
    if (!path.startsWith('/') || path.includes('..')) return { error: 'path 须为绝对路径且不含 ..' }
    let conn
    try { conn = await pool.acquire(row.id, `wb:${projectId}`) }
    catch (e) { return { error: `SSH 连接失败(${e.errorKind || 'unknown'})` } }
    try {
      const sftp = await new Promise((res2, rej2) => conn.client.sftp((e, s) => e ? rej2(e) : res2(s)))
      const data = await new Promise((res2, rej2) => {
        const chunks = []; let size = 0; let truncated = false
        const rs = sftp.createReadStream(path)
        rs.on('data', d => { size += d.length; if (size <= maxBytes) chunks.push(d); else truncated = true; if (size > maxBytes) rs.destroy() })
        rs.on('end', () => res2({ content: Buffer.concat(chunks).toString('utf8'), truncated, size }))
        rs.on('error', e2 => rej2(e2))
      })
      return { server: row.name, path, content: data.content, truncated: data.truncated, size: data.size, durationMs: Date.now() - started }
    } catch (e) {
      const m = String(e?.message || e)
      return { error: /No such file/i.test(m) ? `文件不存在: ${path}` : /permission/i.test(m) ? `无权限读取: ${path}` : `读取失败: ${m.slice(0, 120)}` }
    } finally { try { conn.release() } catch {} }
  }
  return { listExposed, needsApproval, exec, readFile }
}

// 错误文案:not-found 不回显 ref 以外的细节;not-exposed 不回显 host(存在性最小泄露)。
function refusal(r) {
  if (r.reason === 'not-found') return '未找到该服务器,可用清单见系统提示'
  if (r.reason === 'not-exposed') return '该服务器未暴露给 AI'
  if (r.reason === 'ambiguous') return `名称对应多台服务器,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
  return '服务器不可用'
}
