// SFTP 原语(浏览器文件浏览/传输 与 wb_ssh_read_file 共用)。
// client 形状 = ssh2 Client(client.sftp(cb) → sftp 会话);withSftp 负责开/关会话(fn 结束或抛错都 finally end)。
export function withSftp(client, fn) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err)
      // 关会话先于结算(finally 在 then 之前挂链,保证调用方 await 返回时会话已收)
      Promise.resolve().then(() => fn(sftp))   // then 包裹:fn 同步抛错也走 finally 链,不逃逸
        .finally(() => { try { sftp.end() } catch { /* 已关 */ } })
        .then(resolve, reject)
    })
  })
}

export function sftpReaddir(sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err)
      const entries = (list || []).map(e => ({ name: e.filename, type: e.attrs?.isDirectory?.() ? 'dir' : 'file' }))
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      resolve(entries)
    })
  })
}

// 读文件(≤maxBytes 保留,超出置 truncated)。截断语义照 agent-bridge 2026-08-28 审查修复版:
// 超限时先以已累计内容结算再销毁流——destroy 后只发 'close' 不发 'end' 且无 error,
// 等 'close' 才结算会致 promise 永挂;幂等门闩保证 end/close/error 单次结算。
export function sftpReadFile(sftp, path, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let truncated = false; let settled = false
    const rs = sftp.createReadStream(path)
    const ok = () => {
      if (settled) return; settled = true
      resolve({ content: Buffer.concat(chunks).toString('utf8'), truncated, size })
    }
    rs.on('data', d => {
      const before = size
      size += d.length
      if (size <= maxBytes) { chunks.push(d); return }
      // 超限:保留本 chunk 落在 maxBytes 内的前缀,先结算再销毁流——destroy 后只发 'close'
      // 不发 'end' 且无 error,等 'close' 才结算曾致 promise 永挂 + 会话泄漏(2026-08-28 审查)。
      truncated = true
      if (before < maxBytes) chunks.push(d.subarray(0, maxBytes - before))
      ok()
      try { rs.destroy() } catch { /* 已关 */ }
    })
    rs.on('end', ok)
    rs.on('close', ok)
    rs.on('error', e => { if (settled) return; settled = true; reject(e) })
  })
}

export const sftpCreateReadStream = (sftp, path) => sftp.createReadStream(path)
export const sftpCreateWriteStream = (sftp, path) => sftp.createWriteStream(path)

export function sftpStatSize(sftp, path) {
  return new Promise((resolve, reject) => sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st.size))))
}

// 会话级流适配(REST download/upload 用):开独立 sftp 会话拿原生流,流 'close' 时收会话。
// podfile-stream 的 openConn 契约要求返回带 .on('close'/'error')/.close() 的「连接」——sftp 流天然满足;
// download 侧在调用方把流数据 base64 行化写入 sink(对齐 streamDownload 的解码器)。
export function sftpStreamSession(client, openStream) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err)
      let stream
      try { stream = openStream(sftp) } catch (e) { try { sftp.end() } catch { /* noop */ } return reject(e) }
      stream.on('close', () => { try { sftp.end() } catch { /* 已关 */ } })
      resolve(stream)
    })
  })
}
