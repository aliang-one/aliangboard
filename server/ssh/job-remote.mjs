// SSH 异步任务远端命令拼装/解析(纯函数,零 IO)。规格 2026-08-30 §3。
// 铁律:jobId 拼路径前必过 validateJobId;所有脚本只依赖 POSIX sh + coreutils(Linux)。
import { shQuote } from './readonly-classifier.mjs'

export const JOB_ROOT = '/tmp/.ab-job'
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function validateJobId(id) { return typeof id === 'string' && JOB_ID_RE.test(id) }
export function jobDir(id) {
  if (!validateJobId(id)) throw new Error('bad jobId')
  return `${JOB_ROOT}/${id}`
}
export const capBlocks = mb => Math.ceil((Number(mb) * 1024 * 1024) / 4096)

// 启动:机会性 TTL 清理 → 建目录/meta/fifo → setsid 后台 wrapper(远端 timeout 强制寿命;
// 退出码经 .rc sidecar 精确落 code,dd SIGPIPE 杀命令时落 141)→ pid 落盘并回显。
export function launchScript({ jobId, command, timeoutMin, maxOutMb, ttlMin, meta }) {
  const D = jobDir(jobId)
  const inner = `${String(command)}\nprintf '%s' "$?" > .rc\n`
  const wrapper = `exec 9<> in; timeout --kill-after=10 ${Number(timeoutMin)}m sh -c ${shQuote(inner)} <&9 2>&1 | dd of=out bs=4096 count=${capBlocks(maxOutMb)} 2>/dev/null; if [ -f .rc ]; then mv .rc code; else echo 141 > code; fi; rm -f .rc`
  return [
    `find ${JOB_ROOT} -maxdepth 1 -type d -mmin +${Number(ttlMin)} -exec rm -rf {} + 2>/dev/null`,
    `mkdir -p "${D}" && cd "${D}" || exit 1`,
    `printf '%s\\n' ${shQuote(JSON.stringify(meta))} > meta`,
    `mkfifo in || exit 1`,
    `setsid sh -c ${shQuote(wrapper)} < /dev/null > /dev/null 2>&1 &`,
    `echo $! > pid`,
    `echo OK`,
  ].join('\n')
}

// stdin 应答:O_RDWR 打开永不阻塞(自己即读端);fifo 缺失 = 任务已结束/清理 → exit 3。
export function stdinWriteScript({ jobId, text }) {
  const D = jobDir(jobId)
  return `exec 9<>${shQuote(D + '/in')} 2>/dev/null || exit 3; printf '%s\\n' ${shQuote(String(text))} >&9`
}

// 读输出:stdout=原始字节(tail 1-based 偏移 + head 截断);stderr 边带一行元数据。
export function readScript({ jobId, offset, maxBytes }) {
  const D = jobDir(jobId)
  return [
    `tail -c +${Number(offset) + 1} "${D}/out" 2>/dev/null | head -c ${Number(maxBytes)}`,
    `echo "AB_SIZE=$(wc -c < "${D}/out" 2>/dev/null || echo 0) AB_RUNNING=$([ ! -f "${D}/code" ] && kill -0 "$(cat "${D}/pid" 2>/dev/null)" 2>/dev/null && echo 1 || echo 0) AB_EXIT=$(cat "${D}/code" 2>/dev/null || echo '')" 1>&2`,
  ].join('\n')
}

export function parseSideband(stderrText) {
  const m = /AB_SIZE=(\d+)\s+AB_RUNNING=(\d)\s+AB_EXIT=(\d*)/.exec(String(stderrText || ''))
  if (!m) return { size: 0, running: false, exitCode: null }
  return { size: Number(m[1]), running: m[2] === '1', exitCode: m[3] === '' ? null : Number(m[3]) }
}

export function listScript() {
  return `for d in ${JOB_ROOT}/*/; do [ -d "$d" ] || continue; echo "$(basename "$d") $(cat "$d/code" 2>/dev/null || echo RUNNING)"; done; echo LIST-END`
}

export function parseListOutput(stdoutText) {
  return String(stdoutText || '').split('\n').filter(l => l && !l.includes('LIST-END')).map(l => {
    const [jobId, code] = l.trim().split(/\s+/)
    const n = Number(code)
    return { jobId, exitCode: code === 'RUNNING' || !Number.isFinite(n) ? null : n }
  })
}

export function killScript({ jobId }) {
  const D = jobDir(jobId)
  return `P=$(cat "${D}/pid" 2>/dev/null); if [ -z "$P" ]; then echo NOJOB; exit 0; fi; kill -TERM -- -"$P" 2>/dev/null; sleep 1; kill -KILL -- -"$P" 2>/dev/null; echo KILLED`
}

export function sweepScript({ ttlMin }) {
  return `find ${JOB_ROOT} -maxdepth 1 -type d -mmin +${Number(ttlMin)} -exec rm -rf {} + 2>/dev/null; echo OK`
}
