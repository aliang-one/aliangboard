// Pod 文件流式传输核心(纯逻辑,依赖注入,照 exec-bounds.mjs 模式):
//  - 下载:容器内 base64 输出 → 网关逐行解码回二进制流式写响应。base64 字母表不含 \r/ESC,
//    pty 的 \n→\r\n 翻译与 ANSI 清洗都不损数据(规避 execCapture raw=false 剥 \r 的二进制损坏)。
//  - 上传:请求体原始二进制 pipe → exec stdin(tty=false,与 /api/podfile/write 同路径)。
import { Writable } from 'node:stream'

export const PODFILE_LIMIT_DEFAULT_MB = 1024
export const PODFILE_LIMIT_MAX_MB = 10240

// 限额 MB 解析:1-10240 整数,非法/null → null(调用方回退默认)
export function limitMbFromValue(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10)
  return Number.isInteger(n) && n >= 1 && n <= PODFILE_LIMIT_MAX_MB ? n : null
}

export function fmtMB(bytes) {
  const mb = bytes / 1024 / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

// —— 上传预检(2026-09-04:/etc 不可写、磁盘不足等要在开传前秒拒,别让人推完几个 G 才见错)——
// 以 $1(目标完整路径)为参:目录不存在→NODIR;目标或其所在目录不可写→NOWRITE;否则输出目标目录 df 剩余 KB。
// df -k -P:POSIX 列序对三族 df 统一(macOS/BSD 默认 9 列含 inode 列,-P 压回 6 列;GNU 单行不 wrap;
// busybox 仍会 wrap,但 wrap 行 [blocks,used,avail,use%,mount] 从右数第 3 列 $(NF-2) 仍= Available,
// 常规 6 列行 NF-2 同样= Available——从右数是 wrap/常规两态通吃的口径)。
export const UPLOAD_PROBE_SCRIPT = [
  'd=$(dirname "$1")',
  'if [ ! -d "$d" ]; then echo NODIR; exit 0; fi',
  'if [ -e "$1" ]; then',
  '  if [ ! -w "$1" ]; then echo NOWRITE; exit 0; fi',
  'else',
  '  if [ ! -w "$d" ]; then echo NOWRITE; exit 0; fi',
  'fi',
  'df -k -P "$d" 2>/dev/null | tail -1 | awk \'{print $(NF-2)}\'',
].join('\n')

// SSH 通道下发形态:脚本没有 argv 可用,base64 + `sh -s` 免嵌套引号(模块加载时算一次)
export const UPLOAD_PROBE_SCRIPT_B64 = Buffer.from(UPLOAD_PROBE_SCRIPT).toString('base64')

// 解析探针 stdout:NODIR/NOWRITE 标记优先——必须整行精确匹配(防 df 行里恰好含标记子串,如挂载点叫 NODIR);
// 末行 ≥3 列按倒数第 3 列(Available,与脚本的 NF-2 口径一致,兼容 df wrap)取,否则整行按数字;
// 取不到 → ok + availKB:null(预检 best-effort,探不出来不拦上传)。
export function parseUploadProbe(raw) {
  const lines = String(raw || '').split('\n').map(s => s.trim()).filter(Boolean)
  const up = lines.map(l => l.toUpperCase())
  if (up.some(l => l === 'NODIR')) return { verdict: 'nodir', availKB: null }
  if (up.some(l => l === 'NOWRITE')) return { verdict: 'nowrite', availKB: null }
  const last = lines[lines.length - 1]
  if (last === undefined) return { verdict: 'ok', availKB: null }
  const fields = last.split(/\s+/)
  const n = Number(fields.length >= 3 ? fields[fields.length - 3] : last)
  return { verdict: 'ok', availKB: Number.isFinite(n) && n >= 0 ? n : null }
}

// 判定:目录不存在/不可写 → 400;磁盘剩余(KB)*1024 < contentLength → 413 带 fmtMB 参数;
// 放行返回 null。contentLength < 0(缺头)不查空间(411 由 streamUpload 管)。
export function evaluateUploadProbe(raw, contentLength) {
  const p = parseUploadProbe(raw)
  if (p.verdict === 'nodir') return { status: 400, key: 'api.uploadTargetNotFound', params: {} }
  if (p.verdict === 'nowrite') return { status: 400, key: 'api.uploadTargetNotWritable', params: {} }
  if (p.availKB !== null && contentLength >= 0 && p.availKB * 1024 < contentLength) {
    return { status: 413, key: 'api.uploadInsufficientSpace', params: { need: fmtMB(contentLength), avail: fmtMB(p.availKB * 1024) } }
  }
  return null
}

// base64 行解码 Writable:任意 chunk 切分下按行(\n 分隔,\r 等杂散字节剔除)解码;尾段无换行也解码。
export function createBase64LineDecoder(onChunk) {
  let buf = ''
  return new Writable({
    write(c, _e, cb) {
      buf += c.toString('ascii')
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const clean = line.replace(/[^A-Za-z0-9+/=]/g, '')
        if (clean) onChunk(Buffer.from(clean, 'base64'))
      }
      cb()
    },
    final(cb) {
      const clean = buf.replace(/[^A-Za-z0-9+/=]/g, '')
      if (clean) onChunk(Buffer.from(clean, 'base64'))
      cb()
    },
  })
}

const cleanTty = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim()

// 下载编排:stat 已由调用方完成(statBytes>=0 才进来;NaN 也按 404 处理)。
// 超限→413;openConn 后 conn 早关且零数据+stderr 非空→404;头部已发后的失败→res.destroy(不抛)。
export async function streamDownload({ statBytes, limitBytes, openConn, res, filename }) {
  if (!(statBytes >= 0)) throw Object.assign(new Error('文件不存在或不可读'), { status: 404 })
  if (statBytes > limitBytes) {
    throw Object.assign(new Error(`文件过大(${fmtMB(statBytes)} > 限额 ${fmtMB(limitBytes)});管理员可在 设置→文件传输 调整`), { status: 413 })
  }
  if (statBytes === 0) {   // 空文件:无 base64 输出,直接 200 空体(不走「零数据=失败」判定)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${filename}"`, 'content-length': '0' })
    res.end()
    return
  }
  const errChunks = []
  const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb() } })
  let received = false
  let headSent = false
  let connErrored = false
  const decoder = createBase64LineDecoder((chunk) => {
    if (!headSent) {
      headSent = true
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(statBytes),
      })
    }
    received = true
    res.write(chunk)
  })
  const conn = await openConn(decoder, stderrSink)
  await new Promise((resolve) => {
    conn.on('close', resolve)
    conn.on('error', (err) => {
      connErrored = true
      if (headSent) res.destroy()
      resolve()
    })
    decoder.on('close', resolve)   // 上游 end() 兜底
  })
  try { conn.close() } catch { /* 已关 */ }
  if (!headSent) {
    const errText = cleanTty(Buffer.concat(errChunks).toString('utf8'))
    throw Object.assign(new Error(errText || '文件读取失败'), { status: 404 })
  }
  if (connErrored) return          // error 分支已 res.destroy():destroy 后不得再 end(语义脏,交给浏览器报中断)
  if (received) res.end()
  else { res.destroy(); return }  // 头都发了却零数据:毁连接让浏览器报错,而非挂空文件
}

// 上传编排:contentLength 缺失→411、超限→413(都不启 exec);req.pipe(stdin);req aborted→conn.close+canceled。
export function streamUpload({ contentLength, limitBytes, openConn, req }) {
  return new Promise((resolve, reject) => {
    if (!(contentLength >= 0)) return reject(Object.assign(new Error('缺少 content-length'), { status: 411 }))
    if (contentLength > limitBytes) {
      return reject(Object.assign(new Error(`文件过大(${fmtMB(contentLength)} > 限额 ${fmtMB(limitBytes)});管理员可在 设置→文件传输 调整`), { status: 413 }))
    }
    // 预检窗口遗留(2026-09-04 审查):调用方在 streamUpload 之前可能有 I/O await(上传预检/池冷连),
    // 客户端若在该窗口断开,'aborted' 在无人监听时已发出且永不重放——在已 destroyed 的 req 上挂监听器
    // + pipe 会双双失灵,openConn 启动后 promise 永不结算(exec WebSocket / SFTP 句柄连带泄漏)。
    // 入口即拒,canceled=true 让路由走既有的 499 分支。
    if (req.destroyed) {
      return reject(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true }))
    }
    const errChunks = []
    const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb() } })
    let conn = null
    let settled = false
    // 请求体是否完整结束:必须挂在 openConn 之前(监听序先于调用方 pipe 的 'end'),
    // 正常路径 req end 早于 conn close;未结束就关 → 上传中断,不得假报成功。
    let reqDone = false
    req.on('end', () => { reqDone = true })
    const fail = (e) => { if (settled) return; settled = true; try { conn?.close() } catch { /* noop */ } reject(e) }
    openConn(req, stderrSink)          // 注意:openConn 的第一参即 stdin(=req 原样传给 exec 也可,但为对齐 seam 统一由调用方 pipe)
      .then(c => {
        // 竞态:fail() 先走(req aborted 时 conn 还是 null,close 不掉任何东西),随后 openConn 才 resolve——
        // 此时 settled=true,若照常赋值 conn,close handler 会因 settled 早退,这条 exec 连接就永久泄漏
        if (settled) { try { c.close() } catch { /* 已关 */ } return }
        conn = c
        conn.on('close', () => {
          if (settled) return
          settled = true
          const errText = cleanTty(Buffer.concat(errChunks).toString('utf8'))
          if (errText) reject(Object.assign(new Error(errText), { status: 502 }))
          else if (!reqDone) reject(Object.assign(new Error('上传中断(连接提前关闭)'), { status: 502 }))
          else resolve({ ok: true, path: '', bytes: contentLength })
        })
        conn.on('error', () => fail(Object.assign(new Error('exec 连接错误'), { status: 502 })))
      })
      .catch(e => fail(Object.assign(new Error(e?.message || 'exec 失败'), { status: 502 })))
    req.on('error', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
    req.on('aborted', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
  })
}
