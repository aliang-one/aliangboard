// 只读命令分类器(spec §6.2):`readonly` 审批策略的白名单闸。宁可错杀(去走审批)不可放行。
// 清单外一律 false;出现 shell 控制元字符/重定向/heredoc/换行直接 false(管道须两段全只读)。
const READONLY = new Set(['cat', 'ls', 'ps', 'df', 'free', 'head', 'tail', 'grep', 'find', 'uname', 'who',
  'uptime', 'date', 'id', 'hostname', 'wc', 'du', 'stat', 'env', 'printenv', 'journalctl', 'dmesg',
  'netstat', 'ss', 'ip', 'ping', 'systemctl'])
// systemctl 仅 status 子命令只读
const SYSTEMCTL_RO = /^status\b/

// 参数级写 deny 集(审查修复):清单只看命令名不够,双义命令的写参数命中任一即 false。
const ARG_DENY = new Map([
  // find 落盘/执行族(-delete/-exec/-ok…;-fprint0 与 -fprint/-fprintf/-fls 同为写文件原语)
  ['find', new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fprint', '-fprint0', '-fls'])],
  // ip 写形态(set/add/del/…);netns 整族拒(exec 子命令 = 命名空间内任意命令)
  ['ip', new Set(['set', 'add', 'del', 'delete', 'change', 'replace', 'flush', 'netns'])],
  ['date', new Set(['-s', '--set'])],                                      // date -s = 改系统时钟
  ['dmesg', new Set(['-c', '-C', '--console-level', '--clear', '--read-clear'])],  // -c/-C = 清环形缓冲
  ['journalctl', new Set(['--rotate', '--flush', '--sync', '--relinquish-var',
    '--vacuum-size', '--vacuum-time', '--vacuum-files'])],                 // rotate/vacuum = 改写日志
])
// env 只允许 VAR=x 赋值形态(env 裸跑 = 打印环境;env <cmd> = 借白名单执行任意命令)
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// 危险环境变量(2026-08-29 审计):VAR=x 前缀对白名单命令无差别放行会被用于代码注入
// (LD_PRELOAD=/tmp/evil.so cat /etc/hostname → cat 进程加载恶意 so)。命中任一 → 非只读。
const DANGEROUS_ENV = /^(LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|PYTHONPATH|PYTHONSTARTUP|PATH|BASH_ENV|ENV|PERL5OPT|RUBYOPT|NODE_OPTIONS|SHELL|IFS)=/i

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
    while (i < tokens.length && VAR_ASSIGN.test(tokens[i])) {
      if (DANGEROUS_ENV.test(tokens[i])) return false                    // 危险 env 注入
      i++
    }
    const bin = (tokens[i] || '').split('/').pop()
    if (!READONLY.has(bin)) return false
    const args = tokens.slice(i + 1)
    if (bin === 'systemctl' && !SYSTEMCTL_RO.test(args[0] || '')) return false
    if (bin === 'hostname' && args.length) return false   // 双义:无参=打印;带参(-F file 也在内)=改主机名
    if (bin === 'env' && args.some(a => !VAR_ASSIGN.test(a))) return false
    const deny = ARG_DENY.get(bin)
    if (deny && args.some(a => hitsDeny(a, deny))) return false
    return true
  })
}

// deny 命中:精确匹配,或 GNU 长选项带值形态(--vacuum-size=1M → 前缀 --vacuum-size 命中)
function hitsDeny(arg, deny) {
  if (deny.has(arg)) return true
  const eq = arg.indexOf('=')
  return eq > 0 && deny.has(arg.slice(0, eq))
}

export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// sudo -S 从 stdin 读密码(网关在 exec 流上写,不进远端 argv/ps)。-p '' 吞掉提示符防污染输出。
export function buildSudoCommand(command) {
  return `sudo -S -p '' sh -c ${shQuote(command)}`
}
