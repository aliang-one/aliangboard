// AI↔SSH 异步任务桥(规格 2026-08-30 §3-5):启动/读输出/stdin 应答/列表/终止。
// 铁律:全一次性 exec(复用池,零长连接);远端目录=事实源;jobId 拼路径前必 validateJobId;
// 凭据/host 绝不出现在结果;keyMode(MCP/API-key)fail-closed——write/kill 恒拒,run 按策略。
import { randomUUID } from 'node:crypto'
import { listSshServers } from './store.mjs'
import { resolveServerRef } from './agent-bridge.mjs'
import { classifyReadonly } from './readonly-classifier.mjs'
import { resolveJobPolicy } from './job-policy.mjs'
import {
  validateJobId, launchScript, stdinWriteScript, readScript, parseSideband,
  listScript, parseListOutput, killScript, sweepScript,
} from './job-remote.mjs'

export const TIMEOUT_MIN_MIN = 1, TIMEOUT_MAX_MIN = 120, TIMEOUT_DEFAULT_MIN = 30
export const OUTMB_MIN = 1, OUTMB_MAX = 512, OUTMB_DEFAULT = 64
export const OUTBYTES_DEFAULT = 16384, OUTBYTES_MAX = 32768, WRITE_TEXT_MAX = 4096
const EXEC_ONCE_TIMEOUT_MS = 15000

// 语义(brief 测试为证):超过上限截到 hi;非数字/低于下限回落默认 fb(0 等无效值→默认)。
const clampN = (v, lo, hi, fb) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo) return fb
  return Math.min(hi, Math.floor(n))
}

// 单次结算闩:超时/exec 回调/close/error 谁先到谁赢(与 agent-bridge exec 同款语义;
// 有意不复用其函数——那里缠着 sudo/stdin/审计,是已测代码,不动)。
function execOnce(pool, serverId, label, cmd) {
  return pool.acquire(serverId, label).then(conn => new Promise(resolveP => {
    let done = false, timer = null
    let out = Buffer.alloc(0), errBuf = ''
    const settle = r => { if (done) return; done = true; clearTimeout(timer); try { conn.release() } catch {} ; resolveP(r) }
    timer = setTimeout(() => settle({ stdout: out, stderr: errBuf, exitCode: null, timedOut: true }), EXEC_ONCE_TIMEOUT_MS)
    conn.client.exec(cmd, (err, s) => {
      if (err) return settle({ stdout: out, stderr: String(err.message || err), exitCode: null, timedOut: false })
      s.on('data', d => { out = Buffer.concat([out, d]) })
      s.stderr?.on?.('data', d => { errBuf += d.toString('utf8') })
      s.on('exit', code => { settle({ stdout: out, stderr: errBuf, exitCode: code, timedOut: false }) })
      s.on('error', e2 => settle({ stdout: out, stderr: String(e2.message || e2), exitCode: null, timedOut: false }) )
    })
  }))
}

export function createSshJobBridge({ db, pool, projectId, getPolicy = () => resolveJobPolicy(), keyMode = false }) {
  const label = `wb:${projectId}`
  const memory = new Map() // jobId -> { serverId, projectId, startedAt }
  const resolve = ref => resolveServerRef(
    db.prepare('SELECT id,name,host,port,username,authMethod,exposeToAi,aiApprovalPolicy FROM ssh_servers').all(), ref)
  const refusal = r => r.reason === 'not-found' ? '未找到该服务器,可用清单见系统提示'
    : r.reason === 'not-exposed' ? '该服务器未暴露给 AI'
    : r.reason === 'ambiguous' ? `名称对应多台服务器,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
    : '服务器不可用'
  const listExposed = () => listSshServers(db, { exposedOnly: true })
    .map(s => ({ id: s.id, name: s.name, description: s.description || '', clusterRef: s.clusterRef || '' }))

  async function needsApproval(name, args) {   // 纯(同步 DB 读),agent-runner checkpoint/resume 两处咨询
    const r = resolve(args?.server)
    if (!r.ok) return true
    const p = r.row.aiApprovalPolicy
    if (name === 'wb_ssh_job_write') return p !== 'none'
    if (name === 'wb_ssh_run') {
      if (p === 'none') return false
      if (p === 'readonly') return !classifyReadonly(args?.command)
      return true
    }
    return true
  }

  async function run(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const cmd = String(args?.command || '')
    if (!cmd.trim()) return { error: 'command 为空' }
    const policy = getPolicy()
    const timeoutMin = clampN(args?.timeoutMin, TIMEOUT_MIN_MIN, TIMEOUT_MAX_MIN, TIMEOUT_DEFAULT_MIN)
    const maxOutMb = clampN(args?.maxOutMb, OUTMB_MIN, OUTMB_MAX, OUTMB_DEFAULT)
    if (keyMode) {
      const p = r.row.aiApprovalPolicy || 'always'
      if (p === 'always') return { error: '该服务器审批策略为 always(启动需人审),key 通道无人审不可启动;将策略调为 none/readonly 后重试' }
      if (p === 'readonly' && !classifyReadonly(cmd)) return { error: '该服务器审批策略为 readonly(仅只读命令免审),key 通道无人审,非只读任务已拒' }
    }
    // 并发上限:远端 RUNNING 数
    const lst = await execOnce(pool, r.row.id, label, listScript())
    const runningCount = parseListOutput(lst.stdout.toString('utf8')).filter(j => j.exitCode === null).length
    if (runningCount >= policy.maxPerServer) return { error: `该服务器运行中任务并发已达上限(${policy.maxPerServer}),请先等待或终止部分任务` }
    const jobId = randomUUID()
    const startedAt = Date.now()
    const s = await execOnce(pool, r.row.id, label, launchScript({
      jobId, command: cmd, timeoutMin, maxOutMb, ttlMin: policy.ttlMin,
      meta: { jobId, projectId, startedAt, timeoutMin, maxOutMb },
    }))
    const launchOut = s.stdout.toString('utf8')
    if (s.timedOut || !/OK/.test(launchOut)) return { error: '任务启动失败(远端不支持 setsid/timeout?异步任务仅支持 Linux 服务器)' }
    memory.set(jobId, { serverId: r.row.id, projectId, startedAt })
    // launchScript 输出 = pid 行 + 'OK' 确认行;pid 取首个非 OK 行。
    const pid = launchOut.split('\n').map(l => l.trim()).find(l => l && l !== 'OK') || ''
    return { jobId, pid, server: r.row.name, startedAt, timeoutMin, maxOutMb }
  }

  async function jobOut(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const offset = clampN(args?.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const maxBytes = clampN(args?.maxBytes, 1, OUTBYTES_MAX, OUTBYTES_DEFAULT)
    const started = Date.now()
    const s = await execOnce(pool, r.row.id, label, readScript({ jobId, offset, maxBytes }))
    if (s.timedOut) return { error: '读取超时' }
    const sb = parseSideband(s.stderr)
    if (sb.size === 0 && s.exitCode !== 0) return { error: '任务不存在或输出已被清理(TTL),请用 wb_ssh_job_list 确认' }
    return {
      server: r.row.name, jobId, chunk: s.stdout.toString('utf8'),
      size: sb.size, offset: Math.min(sb.size, offset + maxBytes),
      running: sb.running, exitCode: sb.exitCode, durationMs: Date.now() - started,
    }
  }

  async function jobWrite(args) {
    if (keyMode) return { error: 'stdin 应答仅工作台 AI 支持(需人审),key 通道不可用' }
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const text = String(args?.text ?? '')
    if (!text.length) return { error: 'text 为空' }
    if (text.length > WRITE_TEXT_MAX) return { error: `text 超长(上限 ${WRITE_TEXT_MAX})` }
    const s = await execOnce(pool, r.row.id, label, stdinWriteScript({ jobId, text }))
    if (s.exitCode === 3) return { error: '任务 stdin 已关闭(任务已结束或被清理)' }
    if (s.timedOut) return { error: '写入超时' }
    return { ok: true, server: r.row.name, jobId }
  }

  async function jobList(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const s = await execOnce(pool, r.row.id, label, listScript())
    const jobs = parseListOutput(s.stdout.toString('utf8')).map(j => ({
      ...j, projectId: memory.get(j.jobId)?.projectId || undefined,
    }))
    return { server: r.row.name, jobs }
  }

  async function jobKill(args) {
    if (keyMode) return { error: '任务终止仅工作台 AI 支持,key 通道不可用' }
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const s = await execOnce(pool, r.row.id, label, killScript({ jobId }))
    if (/NOJOB/.test(s.stdout.toString('utf8'))) return { error: '任务不存在(已结束或 pid 文件缺失)' }
    memory.delete(jobId)
    return { ok: true, server: r.row.name, jobId }
  }

  async function sweepServer(id) {
    try { await execOnce(pool, id, 'wb:__sweep__', sweepScript({ ttlMin: getPolicy().ttlMin })) } catch { /* 单台失败不阻断 */ }
  }
  const sweepServerIds = () => [...new Set([...memory.values()].map(v => v.serverId))]
  async function sweep() { for (const id of sweepServerIds()) await sweepServer(id) }

  return { listExposed, needsApproval, run, jobOut, jobWrite, jobList, jobKill, sweep, sweepServer, sweepServerIds }
}
