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
// 死亡处置(终审 I1,移植 agent-bridge):超时先 `stream.close()`(只是这条命令慢,流可收);
// 仅「exec 回调从未触发」(stream==null=疑似死连接)才拆整条池化客户端——client.end 会杀掉
// 该服务器上所有用户共享的连接。此前两者都不做,把半死连接还给池:后续该服务器每个任务操作
// 都烧满 15s 返回垃圾。exit 只记退出码、close 才结算:stdout/stderr 需在流关闭后才算完整。
function execOnce(pool, serverId, label, cmd) {
  return pool.acquire(serverId, label).then(conn => new Promise(resolveP => {
    let done = false, stream = null, timer = null
    let out = Buffer.alloc(0), errBuf = ''
    const settle = r => { if (done) return; done = true; if (timer) clearTimeout(timer); try { conn.release() } catch {}; resolveP(r) }
    timer = setTimeout(() => {
      try { stream?.close?.() } catch {}
      if (stream == null) { try { conn.client.end?.() } catch {} }
      settle({ stdout: out, stderr: errBuf, exitCode: null, timedOut: true })
    }, EXEC_ONCE_TIMEOUT_MS)
    conn.client.exec(cmd, (err, s) => {
      if (err) return settle({ stdout: out, stderr: String(err.message || err), exitCode: null, timedOut: false })
      stream = s
      let exitCode = null
      s.on('data', d => { out = Buffer.concat([out, d]) })
      s.stderr?.on?.('data', d => { errBuf += d.toString('utf8') })
      s.on('exit', code => { exitCode = code })
      s.on('close', () => { settle({ stdout: out, stderr: errBuf, exitCode, timedOut: false }) })
      s.on('error', e2 => settle({ stdout: out, stderr: String(e2.message || e2), exitCode: null, timedOut: false }))
    })
  }))
}

// 跨实例的服务器活跃名单(T6 sweep 用):每实例的 memory 是私有闭包,网关级 sweep 专用实例
// 看不到别的实例——run 成功时登记到模块级集合,进程重启即清空(与「重启后该轮不扫」语义一致)。
const sweepSeenServers = new Set()
// 测试专用复位:模块级集合会让断言与用例顺序耦合,用例开头先复位(T6 审查加固)。
export function _resetSweepSeenServersForTest() { sweepSeenServers.clear() }

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
  // acquire 失败统一包装(终审 I1):此前裸抛 ssh2 错误,AI 会看到原始连接栈文案而非桥的错误形状
  // (与 agent-bridge 的 `SSH 连接失败(${errorKind})` 一致);调用方按 `result.error` 早退。
  const execJob = async (serverId, cmd) => {
    try { return await execOnce(pool, serverId, label, cmd) }
    catch (e) { return { error: `SSH 连接失败(${e?.errorKind || 'unknown'})`, stdout: '', stderr: '', exitCode: null, timedOut: false } }
  }

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
    const lst = await execJob(r.row.id, listScript())
    if (lst.error) return lst
    const runningCount = parseListOutput(lst.stdout.toString('utf8')).filter(j => j.exitCode === null).length
    if (runningCount >= policy.maxPerServer) return { error: `该服务器运行中任务并发已达上限(${policy.maxPerServer}),请先等待或终止部分任务` }
    const jobId = randomUUID()
    const startedAt = Date.now()
    const s = await execJob(r.row.id, launchScript({
      jobId, command: cmd, timeoutMin, maxOutMb, ttlMin: policy.ttlMin,
      meta: { jobId, projectId, startedAt, timeoutMin, maxOutMb },
    }))
    if (s.error) return s
    const launchOut = s.stdout.toString('utf8')
    // 失败文案分流(终审 I1):超时(含死连接烧满 15s)≠ 远端不支持 Linux 原语——
    // 死连接曾被误报成「服务器不支持 setsid/timeout」,误导 AI 去换服务器。
    if (s.timedOut) return { error: '任务启动失败(连接或执行超时,请稍后重试)' }
    if (!/OK/.test(launchOut)) return { error: '任务启动失败(远端不支持 setsid/timeout?异步任务仅支持 Linux 服务器)' }
    memory.set(jobId, { serverId: r.row.id, projectId, startedAt })
    sweepSeenServers.add(r.row.id)
    // launchScript 输出 = pid 行 + 'OK' 确认行;pid 只接受纯数字行(终审 I2:
    // banner/motd 噪音曾被当 pid 回显给 AI,它会拿去 kill)。
    const pid = launchOut.split('\n').map(l => l.trim()).find(l => /^\d+$/.test(l)) || ''
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
    const s = await execJob(r.row.id, readScript({ jobId, offset, maxBytes }))
    if (s.error) return s
    if (s.timedOut) return { error: '读取超时' }
    const sb = parseSideband(s.stderr)
    // 缺任务判定(终审 C1)只看边带,不看 exec 退出码:readScript 的远端退出码恒为 0(末命令是
    // echo,`wc -c < missing || echo 0` 兜底),旧 guard `s.exitCode !== 0` 恰在本场景为 false ——
    // TTL 清掉的/跨服务器错配的任务返回成功形空结果,AI 会误报「任务已结束无输出」。
    // 「目录不存在」的边带签名 = size 0 + 未在跑 + 无退出码,且 exec 本身成功退出。
    if (sb.size === 0 && !sb.running && sb.exitCode === null && s.exitCode === 0) {
      return { error: '任务不存在或输出已被清理(TTL),请用 wb_ssh_job_list 确认' }
    }
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
    const s = await execJob(r.row.id, stdinWriteScript({ jobId, text }))
    if (s.error) return s
    if (s.exitCode === 3) return { error: '任务 stdin 已关闭(任务已结束或被清理)' }
    if (s.timedOut) return { error: '写入超时' }
    return { ok: true, server: r.row.name, jobId }
  }

  async function jobList(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const s = await execJob(r.row.id, listScript())
    if (s.error) return s
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
    const s = await execJob(r.row.id, killScript({ jobId }))
    if (s.error) return s
    if (/NOJOB/.test(s.stdout.toString('utf8'))) return { error: '任务不存在(已结束或 pid 文件缺失)' }
    memory.delete(jobId)
    return { ok: true, server: r.row.name, jobId }
  }

  async function sweepServer(id) {
    try { await execJob(id, sweepScript({ ttlMin: getPolicy().ttlMin })) } catch { /* 单台失败不阻断 */ }
  }
  const sweepServerIds = () => [...sweepSeenServers]
  async function sweep() { for (const id of sweepServerIds()) await sweepServer(id) }

  return { listExposed, needsApproval, run, jobOut, jobWrite, jobList, jobKill, sweep, sweepServer, sweepServerIds }
}
