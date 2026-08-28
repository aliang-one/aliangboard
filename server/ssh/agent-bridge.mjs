// AI ↔ SSH 桥:解析 server 引用(id 优先/name 唯一)、按服务器策略回答审批、exec/readFile(SFTP)。
// 铁律:凭据只在 pool/连接闭包内;结果/错误只含 exitCode/stdout/stderr/durationMs,绝不含凭据;
// not-exposed 与 not-found 的文案不得回显 host(不泄露未暴露服务器的存在细节)。
// needsApproval 必须纯(无 IO 副作用/日志/审计)——agent.mjs 在 checkpoint 与 resume 两处都会调它。
import { listSshServers, materializeCreds } from './store.mjs'
import { classifyReadonly, buildSudoCommand } from './readonly-classifier.mjs'
import { withSftp, sftpReadFile } from './sftp.mjs'

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
  // 同名多台且至少一台暴露 → 歧义(AI 无法自证指向哪台),候选只列暴露行(不泄露未暴露行);
  // 同名全未暴露 → not-exposed(不给存在性预言机,也不产「候选 id:」空文案)。
  const exposedNamed = named.filter(x => x.exposeToAi)
  if (named.length > 1) {
    if (exposedNamed.length === 0) return { ok: false, reason: 'not-exposed', candidates: [] }
    return { ok: false, reason: 'ambiguous', candidates: exposedNamed.map(x => ({ id: x.id, name: x.name })) }
  }
  return exposedNamed.length ? { ok: true, row: named[0] } : { ok: false, reason: 'not-exposed', candidates: [] }
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
      // sudo=true = 以 root 执行:readonly 分类器只看命令文本,不看提权位。
      // 「cat /etc/shadow + sudo」在纯文本分类下无害,实际是 root 读取 → 一律人审(2026-08-28 审批旁路修复)。
      if (args?.sudo === true) return true
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
        // 单次结算门闩:超时/exec 回调/close/error 谁先到谁赢,迟到者幂等 no-op(防死连接 cb 迟到重入)。
        let done = false, stream = null, timer = null
        let out = Buffer.alloc(0), errBuf = Buffer.alloc(0), outTruncated = false, errTruncated = false
        const settle = r => { if (done) return; done = true; if (timer) clearTimeout(timer); resolveP(r) }
        // 总定时器挂在 exec 调用外层:覆盖「cb 永不回调」的死连接场景(2026-08-28 审查),而非仅流内。
        timer = setTimeout(() => {
          try { stream?.close?.() } catch {}
          // 仅「exec 回调都还没触发」(stream 为 null = 疑似死连接)才拆整条池化客户端;
          // stream 已拿到 = 只是这条命令慢,close 流即可——池按 server 复用,client.end 会
          // 杀掉该服务器上所有用户共享的连接(2026-08-28 跨会话杀伤修复)。
          if (stream == null) { try { conn.client.end?.() } catch {} }
          settle({ exitCode: null, timedOut: true, stdout: out.toString('utf8'), stderr: errBuf.toString('utf8'), durationMs: Date.now() - started })
        }, timeoutMs)
        conn.client.exec(cmd, (err, s) => {
          if (err) return settle({ error: String(err.message || err) })
          stream = s
          if (stdinPassword != null) stream.write(stdinPassword + '\n')
          let exitCode = null
          const finish = () => settle({ exitCode, stdout: out.toString('utf8'), stderr: errBuf.toString('utf8'),
            stdoutTruncated: outTruncated, stderrTruncated: errTruncated, durationMs: Date.now() - started })
          // 截断标志 = 「实际丢弃过字节」:恰好满上限不误报(2026-08-28 审查)。
          stream.on('data', d => {
            if (out.length + d.length <= STDOUT_MAX) { out = Buffer.concat([out, d]); return }
            outTruncated = true
            out = Buffer.concat([out, d]).subarray(0, STDOUT_MAX)
          })
          stream.stderr?.on?.('data', d => {
            if (errBuf.length + d.length <= STDERR_MAX) { errBuf = Buffer.concat([errBuf, d]); return }
            errTruncated = true
            errBuf = Buffer.concat([errBuf, d]).subarray(0, STDERR_MAX)
          })
          stream.on('exit', code => { exitCode = code })
          stream.on('close', finish)
          stream.on('error', e2 => settle({ error: String(e2.message || e2) }))
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
      const data = await withSftp(conn.client, s => sftpReadFile(s, path, maxBytes))
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
