// cwd 三件套(2026-10-04 终端标签页「+」新建终端):createCwdScanner / sanitizeCwd / buildCdCommand。
// 设计取舍:绝不往用户会话 stdin 写探测命令(前台跑着 vim/长任务时注入=污染输入),只旁路
// 扫描 stdout 里 shell 主动上报的标题序列——Debian/Ubuntu 默认 bashrc 的 PS1 就会发,极简
// 镜像不发则 lastCwd 恒 null,新建终端降级默认登录目录(按钮始终可用,不报错)。
//   OSC 7(权威):ESC ] 7 ; file://host/path BEL|ST —— 专为 cwd 设计,percent-encoded
//   OSC 0/2(启发式):「user@host:路径」标题,须形似 / 或 ~ 起头路径才采信(vim/less 也设标题)
export const MAX_CWD = 4096
// 无终止符 OSC 的驻留上限:超限整段丢弃,防畸形流撑爆缓冲
const MAX_PENDING = 64 * 1024

// —— sanitizeCwd:URL query 传入的起始目录校验(注入防线)——
export function sanitizeCwd(raw) {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > MAX_CWD) return null
  const head = s[0]
  if (head !== '/' && head !== '~') return null           // 只认绝对/家目录路径
  for (const ch of s) { const c = ch.charCodeAt(0); if (c < 0x20 || c === 0x7f) return null }
  return s
}

// —— buildCdCommand:注入 shell 的 cd 命令(入参须已过 sanitizeCwd)——
// 单引号包裹内嵌单引号转义;~ 前缀必须免引号——'~/x' 引号内 tilde 不展开会 cd 到字面 '~' 目录,
// 故 ~ 或 ~/rest 保住免引号前缀、余下部分单独包裹。
export function buildCdCommand(cwd) {
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`
  if (cwd === '~') return 'cd -- ~'
  if (cwd.startsWith('~/')) return `cd -- ~/${q(cwd.slice(2))}`
  return `cd -- ${q(cwd)}`
}

// 路径形态校验(解析产物复用):/ 或 ~ 起头、限长、无控制字符(标题内容不可信)
function validPath(p) {
  if (!p || typeof p !== 'string' || p.length > MAX_CWD) return false
  if (p[0] !== '/' && p[0] !== '~') return false
  for (const ch of p) { const c = ch.charCodeAt(0); if (c < 0x20 || c === 0x7f) return false }
  return true
}

// 单条 OSC 内容 → cwd(无效返回 null)。text 为 ESC ] 与终止符之间的原文。
function parseOsc(text) {
  const semi = text.indexOf(';')
  if (semi < 0) return null
  const code = text.slice(0, semi)
  const body = text.slice(semi + 1)
  if (code === '7') {
    // file://host/path:path 段 percent-encoded
    const m = body.match(/^file:\/\/[^/]*(\/[\s\S]*)$/)
    if (!m) return null
    let path
    try { path = decodeURIComponent(m[1]) } catch { return null }
    return validPath(path) ? path : null
  }
  if (code === '0' || code === '2') {
    // 启发式:剥「user@host:」前缀(host 段不含 /,防把 sftp://x 之类误剥),余下须形似路径
    let rest = body
    const at = rest.indexOf('@')
    if (at > 0) {
      const colon = rest.indexOf(':', at)
      if (colon > at && !rest.slice(at + 1, colon).includes('/')) rest = rest.slice(colon + 1)
    }
    return validPath(rest) ? rest : null
  }
  return null
}

// —— createCwdScanner:跨 chunk 缓冲的旁路扫描器 ——
// push(chunk) 喂 stdout 字节块,返回本次更新的新 cwd(无有效变化返回 null);get() 取当前值。
// 序列可能被 WS 帧任意切断(ESC 在块尾/序列中途断开):尾部未闭合序列驻留 pending 待下块续。
export function createCwdScanner() {
  let cwd = null
  let pending = Buffer.alloc(0)

  const push = chunk => {
    const buf = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    pending = Buffer.alloc(0)
    let i = 0
    let lastValid = null
    let hasValid = false
    while (i < buf.length) {
      if (buf[i] === 0x1b && buf[i + 1] === 0x5d) {          // ESC ]
        let j = i + 2, end = -1, endLen = 0
        while (j < buf.length) {
          if (buf[j] === 0x07) { end = j; endLen = 1; break }               // BEL
          if (buf[j] === 0x1b && buf[j + 1] === 0x5c) { end = j; endLen = 2; break }   // ST(ESC \)
          j++
        }
        if (end < 0) { pending = buf.subarray(i); break }    // 未闭合:整段驻留(见下限长)
        const parsed = parseOsc(buf.subarray(i + 2, end).toString('utf8'))
        if (parsed) { lastValid = parsed; hasValid = true }
        i = end + endLen
      } else i++
    }
    if (pending.length > MAX_PENDING) pending = Buffer.alloc(0)   // 畸形无终止流:丢弃防撑爆
    else if (!pending.length && buf.length && buf[buf.length - 1] === 0x1b) pending = buf.subarray(buf.length - 1)  // 孤立 ESC:可能是下块 OSC 的头
    if (hasValid && lastValid !== cwd) { cwd = lastValid; return cwd }
    return null
  }

  return { push, get: () => cwd }
}
