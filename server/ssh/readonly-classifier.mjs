// 只读命令分类器(spec §6.2):`readonly` 审批策略的白名单闸。宁可错杀(去走审批)不可放行。
// 清单外一律 false;出现 shell 控制元字符/重定向/heredoc/换行直接 false(管道须两段全只读)。
const READONLY = new Set(['cat', 'ls', 'ps', 'df', 'free', 'head', 'tail', 'grep', 'find', 'uname', 'who',
  'uptime', 'date', 'id', 'hostname', 'wc', 'du', 'stat', 'env', 'printenv', 'journalctl', 'dmesg',
  'netstat', 'ss', 'ip', 'ping', 'systemctl'])
// systemctl 仅 status 子命令只读
const SYSTEMCTL_RO = /^status\b/

const DANGEROUS_CHARS = /[;&`<>]|\$\(|\n/

export function classifyReadonly(command) {
  const cmd = String(command || '').trim()
  if (!cmd || DANGEROUS_CHARS.test(cmd)) return false
  if (/<<\w/.test(cmd)) return false                                     // heredoc
  const segs = cmd.split('|').map(s => s.trim()).filter(Boolean)
  if (!segs.length) return false
  return segs.every(seg => {
    const tokens = seg.split(/\s+/)
    let i = 0
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++   // VAR=x 前缀
    const bin = (tokens[i] || '').split('/').pop()
    if (!READONLY.has(bin)) return false
    if (bin === 'systemctl' && !SYSTEMCTL_RO.test(tokens[i + 1] || '')) return false
    return true
  })
}

export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// sudo -S 从 stdin 读密码(网关在 exec 流上写,不进远端 argv/ps)。-p '' 吞掉提示符防污染输出。
export function buildSudoCommand(command) {
  return `sudo -S -p '' sh -c ${shQuote(command)}`
}
