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
    const errChunks = []
    const stderrSink = new Writable({ write(c, _e, cb) { errChunks.push(c); cb() } })
    let conn = null
    let settled = false
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
          else resolve({ ok: true, path: '', bytes: contentLength })
        })
        conn.on('error', () => fail(Object.assign(new Error('exec 连接错误'), { status: 502 })))
      })
      .catch(e => fail(Object.assign(new Error(e?.message || 'exec 失败'), { status: 502 })))
    req.on('error', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
    req.on('aborted', () => fail(Object.assign(new Error('客户端中断上传'), { status: 499, canceled: true })))
  })
}
