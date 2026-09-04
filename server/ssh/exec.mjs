// SSH 一次性命令执行(上传预检用,与长驻 shell 通道/tmux 会话无关):
// client.exec → 收 stdout/stderr,'close' 结算;超时/exec 错/同步抛 → null(best-effort 语义,调用方跳过预检不拦上传)。
export function sshExecCommand(client, cmd, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let stream = null
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => { try { stream?.destroy() } catch { /* 已毁 */ } done(null) }, timeoutMs)
    try {
      client.exec(cmd, (err, s) => {
        if (err) return done(null)
        stream = s
        const out = [], errOut = []
        s.on('data', d => out.push(d))
        s.stderr?.on('data', d => errOut.push(d))
        s.on('close', () => done({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') }))
        s.on('error', () => done(null))
      })
    } catch { done(null) }
  })
}

// 单引号 shell 安全包裹(target 等不可信片段进 ssh 命令行的唯一合法姿势)
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}
