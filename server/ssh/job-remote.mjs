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

// TTL 清理片段(终审 C2:规格 §4 原写「按目录 mtime 扫」是被忠实实现的规格缺陷)。
// 目录 mtime 在任务启动时就定格(wrapper 结束才因 `mv .rc code` 再变)——按目录年龄扫会删掉
// **在跑**任务:超时上限(timeoutMax=120min)恰等于默认 ttl 时最长任务一结束就被扫,admin 调小
// ttl 则常态化;叠加上 launchScript 开头的机会性清理,同服务器后来启动的任务 B 会静默删掉任务 A
// 的输出 → job_list 不再显示、无法 kill、job_out 报干净空结束。
// 改为只删**已达终态**的目录:
//   ① `code` 文件存在(= 终态权威信号)→ 按其文件年龄删(结束时刻起算 TTL);
//   ② 无 `code` 且目录已超 TTL 且 pid 已死(= kill/ wrapper 崩溃残留,无人再写)→ 删;
//   ③ 其余(在跑:无 code 且 pid 活着)一律不碰。
// root 可注入(仅测试):单测用临时目录跑真 sh 验证「在跑不删/已结束才删」。
export function sweepSnippet(ttlMin, root = JOB_ROOT) {
  const t = Number(ttlMin)
  return [
    `for f in ${root}/*/code; do`,
    `[ -f "$f" ] || continue`,
    `[ -n "$(find "$f" -mmin +${t} 2>/dev/null)" ] && rm -rf "$(dirname "$f")"`,
    `done`,
    `for d in ${root}/*/; do`,
    `[ -d "$d" ] || continue`,
    `[ -f "$d/code" ] && continue`,
    `[ -n "$(find "$d" -maxdepth 0 -mmin +${t} 2>/dev/null)" ] || continue`,
    `kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null && continue`,
    `rm -rf "$d"`,
    `done`,
  ].join('\n')
}

// 启动:机会性 TTL 清理(sweepSnippet 同款终态判定)→ 建目录/meta/fifo → setsid 后台 wrapper
// (远端 timeout 强制寿命;退出码经 .rc sidecar 精确落 code,dd SIGPIPE 杀命令时落 141)→ pid 落盘并回显。
export function launchScript({ jobId, command, timeoutMin, maxOutMb, ttlMin, meta }) {
  const D = jobDir(jobId)
  const inner = `${String(command)}\nprintf '%s' "$?" > .rc\n`
  const wrapper = `exec 9<> in; timeout --kill-after=10 ${Number(timeoutMin)}m sh -c ${shQuote(inner)} <&9 2>&1 | dd of=out bs=4096 count=${capBlocks(maxOutMb)} 2>/dev/null; if [ -f .rc ]; then mv .rc code; else echo 141 > code; fi; rm -f .rc`
  return [
    sweepSnippet(ttlMin),
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

// 终审 I2:sshd Banner/motd 也会在 exec 通道输出。任何解析不了的行一律**丢弃**——曾把它们映射成
// {jobId:<文本>,exitCode:null},桥里被数成 RUNNING:一行 banner 就虚增并发计数(maxPerServer=4 时
// banner+3 真任务 ⇒ 误报「并发已达上限」),还会以假任务形态喂给 AI(它会去 kill)。
export function parseListOutput(stdoutText) {
  return String(stdoutText || '').split('\n').map(l => l.trim())
    .filter(l => l && !l.includes('LIST-END'))
    .map(l => {
      const [jobId, code] = l.split(/\s+/)
      if (!validateJobId(jobId)) return null
      const n = Number(code)
      return { jobId, exitCode: code === 'RUNNING' || !Number.isFinite(n) ? null : n }
    })
    .filter(Boolean)
}

export function killScript({ jobId }) {
  const D = jobDir(jobId)
  return `P=$(cat "${D}/pid" 2>/dev/null); if [ -z "$P" ]; then echo NOJOB; exit 0; fi; kill -TERM -- -"$P" 2>/dev/null; sleep 1; kill -KILL -- -"$P" 2>/dev/null; echo KILLED`
}

export function sweepScript({ ttlMin, root = JOB_ROOT }) {
  return `${sweepSnippet(ttlMin, root)}\necho OK`
}
