// 文件三件套(2026-09-08):pod(podfile 一次性 exec)与 SSH(sshfile exec)共用的
// 名字/路径校验、失败归类与命令构造。纯逻辑无 IO——双侧路由的单一事实源。
//
// 安全口径(与 sshfile/upload 的 name 校验同源):
// - 用户输入的「名字」(新建/重命名)只允许纯文件名:拒空、拒 ./..、拒含 / 与 \
//   (防路径穿越:名字永远被拼进父目录,不能自带层级)。
// - 删除目标拒根:/ 及一切归一后为根的形态。SSH 是真机、pod 可能挂 PVC,rm -rf /
//   一次都嫌多——前端另有确认弹窗,这里是不依赖 UI 的服务端硬底线。

// 归一路径:去首尾空白 + 去重复尾斜杠('/' → '', '/var/log/' → '/var/log')
export function normalizeFsPath(p) {
  return String(p ?? '').trim().replace(/\/+$/, '')
}

// null = 合法;返回 reason 字符串 = 拒绝原因(审计/文案用)
export function entryNameError(name) {
  const n = String(name ?? '').trim()
  if (!n) return 'empty'
  if (n === '.' || n === '..') return 'dot'
  if (n.includes('/') || n.includes('\\')) return 'slash'
  return null
}

// 删除目标守卫:根拒绝(归一后为空即根)
export function deleteTargetError(path) {
  return normalizeFsPath(path) ? null : 'root'
}

// 父目录 + 名字 → 完整路径(根目录拼接不产双斜杠)
export function joinDirName(dir, name) {
  const d = normalizeFsPath(dir) || '/'
  return d.endsWith('/') ? d + name : d + '/' + name
}

// 路径 → 父目录('/a/b' → '/a','/a' → '/','/' → '/')
export function parentOfFsPath(path) {
  const p = normalizeFsPath(path)
  if (!p) return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

// 失败归类:null = 成功;{status, message} = 应答。
// mkdir 已存在 → 409(busybox『File exists』/coreutils 同);其余非零退出 → 400 + stderr
// 透出(权限不足/父目录不存在等环境语义,对齐 sshfile download 的 stderr→4xx 惯例)。
export function classifyOpFailure(op, exitCode, stderrText) {
  const code = exitCode == null ? 1 : exitCode
  if (code === 0) return null
  const s = String(stderrText || '').trim()
  if (op === 'mkdir' && /exists|存在/i.test(s)) return { status: 409, message: s }
  return { status: 400, message: s || `exit=${code}` }
}

// pod 侧 exec argv:位置参数姿势($1/$2),用户路径永不进命令字符串(与 podfile
// 现有 ls/cat/upload 命令同款;toExecArgv 的字符串 shell 包装是兜底,这里直接给数组)
export const POD_OP_ARGV = {
  mkdir: path => ['sh', '-c', 'mkdir "$1"', 'mkdir', path],
  delete: path => ['sh', '-c', 'rm -rf -- "$1"', 'rm', path],
  rename: (from, to) => ['sh', '-c', 'mv -- "$1" "$2"', 'mv', from, to],
}

// SSH 侧命令串:shellQuote 单引号包裹(不可信片段进 ssh 命令行的唯一合法姿势,
// 与上传预检同款)。调用方负责 conn 归还。
export function sshOpCommand(op, path, to) {
  const q = p => `'${String(p).replace(/'/g, `'\\''`)}'`
  if (op === 'mkdir') return `mkdir ${q(path)}`
  if (op === 'delete') return `rm -rf -- ${q(path)}`
  return `mv -- ${q(path)} ${q(to)}`
}
