// exec 收集界限(2026-08-14 审计 P1a):AI 路径(exec_pod/browse_files/read_file)的一次性 exec
// 必须有超时 + 流式字节上限——原实现 `await conn.on('close')` 无超时,tail -f/sleep 类命令会把
// MCP tools/call 永久挂死(审计停在 reserved 不 finalize);输出先全量缓冲再截断,cat 大文件先吃满内存。
// 交互终端路径不传 bounds(timeoutMs/maxBytes=0)→ 无界,行为与旧版一致。
import { Writable } from 'node:stream'

// exec argv 归一(2026-08-25 exec 字符串命令 bug):K8s exec API 的 argv 必须以**数组**传。
// client-node 用 querystring.stringify({command}) 编码——字符串只产单个 command=cat%20--%20…
// 参数(kubelet 收到单元素 argv,整串被当二进制名 → executable not found);数组才产
// 一词一参的重复 command= 参数。execCapture 调用方全量扫点后:人用路径(终端/tmux/PVC/podfile)
// 均已数组,唯 AI 工具(exec_pod/read_file/browse_files/wb_exec/wb_read_pod_file)传字符串。
// 字符串 → ['sh','-c',cmd](shell 语义,exec_pod/wb_exec 的 schema 契约);数组 → 透传;
// 空/非命令 → 抛(防 sh -c "" 幽灵命令)。
export function toExecArgv(command) {
  if (Array.isArray(command)) {
    if (!command.length) throw new Error('command 不能是空数组(exec argv)')
    return command
  }
  if (typeof command === 'string' && command.trim()) return ['sh', '-c', command]
  throw new Error(`command 必须是非空字符串或非空字符串数组(收到: ${typeof command})`)
}

// openConn(stdoutSink, stderrSink) → Promise<conn>(conn: EventEmitter,须有 close())。
// 返回 { stdout, stderr(Buffer), timedOut, truncated }:
//   timedOut  = 超时被中止(timeoutMs>0 且 conn 在期限内未关)→ 主动 close,已收数据保留
//   truncated = 流式字节超限(maxBytes>0 且 stdout+stderr 合计超)→ 丢超出 chunk + 立刻 close
export function runBoundedCollect({ openConn, timeoutMs = 0, maxBytes = 0 }) {
  return new Promise((resolve, reject) => {
    const chunks = { stdout: [], stderr: [] }
    let bytes = 0
    let truncated = false
    let conn = null
    let settled = false
    const finish = (timedOut) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { conn?.close() } catch { /* 已关 */ }
      resolve({ stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), timedOut, truncated })
    }
    const sink = (key) => new Writable({
      write(c, _e, cb) {
        const b = Buffer.from(c)
        if (maxBytes && bytes + b.length > maxBytes) {
          truncated = true
          try { conn?.close() } catch { /* 已关 */ } // 达流式上限立刻断(不再继续冲内存)
          cb(); return
        }
        bytes += b.length
        chunks[key].push(b)
        cb()
      },
    })
    const timer = timeoutMs > 0 ? setTimeout(() => finish(true), timeoutMs) : null
    openConn(sink('stdout'), sink('stderr'))
      .then((c) => {
        conn = c
        conn.on('close', () => finish(false))
        conn.on('error', () => finish(false))
      })
      .catch(reject)
  })
}
