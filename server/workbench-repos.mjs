// 工作台 repo 存储层(W1):per-project repo + cluster ledger 的 git 操作原语。
// 平台 shell-out `git` 二进制、sole committer。安全要点(决策 3):
//   - child_process.execFile,args 数组 → 无 shell → 无命令注入
//   - 每次 git 调用 -c core.hooksPath=/dev/null → 抑制 repo 内 hook 执行
//   - GIT_TERMINAL_PROMPT=0 / GIT_CONFIG_NOSYSTEM=1 / 清 askpass → 不挂起、不读系统 config
//   - timeout → 防 hang
//   - write_file 路径禁闭(resolve + 不越界)→ 防路径穿越
//   - withRepoLock → 同 repo 的异步 git op 串行,防 .git 损坏
//   - 非 0 退出 → 结构化错误 {code:'GIT_FAILED', gitArgs, stderr}
import { execFile } from 'node:child_process'
import { mkdir, readFile as fsRead, writeFile as fsWrite, stat, unlink, rmdir } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'

const GIT_TIMEOUT_MS = 15000
const GIT_IDENTITY = { name: 'aliangboard', email: 'workbench@aliangboard.local' }

// git 调用的最小 env:复制 process.env(保留 PATH 等),覆盖 git 行为相关变量
function gitEnv() {
  const env = { ...process.env }
  env.GIT_TERMINAL_PROMPT = '0'   // 绝不交互式要凭证(防 hang)
  env.GIT_CONFIG_NOSYSTEM = '1'   // 忽略系统级 gitconfig
  delete env.GIT_ASKPASS          // 不调 askpass 辅助程序
  env.GIT_AUTHOR_NAME = env.GIT_AUTHOR_NAME || GIT_IDENTITY.name
  env.GIT_AUTHOR_EMAIL = env.GIT_AUTHOR_EMAIL || GIT_IDENTITY.email
  env.GIT_COMMITTER_NAME = env.GIT_COMMITTER_NAME || GIT_IDENTITY.name
  env.GIT_COMMITTER_EMAIL = env.GIT_COMMITTER_EMAIL || GIT_IDENTITY.email
  return env
}

// 原始 git 执行(不加锁)。所有 repo-scoped 操作经 withRepoLock → execGit;勿嵌套锁。
function execGit(args, { cwd } = {}) {
  return new Promise((resolveFn, reject) => {
    // -c 必须在子命令前;hooksPath=/dev/null 抑制 .git/hooks
    const fullArgs = ['-c', 'core.hooksPath=/dev/null', ...args]
    execFile('git', fullArgs, { cwd, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`git ${args.join(' ')} 失败: ${(stderr || err.message || '').trim().slice(0, 500)}`)
        e.code = 'GIT_FAILED'
        e.gitArgs = args
        e.exitCode = err.code ?? null
        e.stderr = (stderr || '').trim()
        reject(e)
        return
      }
      resolveFn({ stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

// 同 repo 串行:每次调用等上一个 settle 再跑 fn。fn 抛错不污染链(catch 吞掉只保链)。
const _locks = new Map() // repoPath -> 尾部 Promise
export function withRepoLock(repoPath, fn) {
  const tail = _locks.get(repoPath) || Promise.resolve()
  const run = tail.then(fn, fn)
  _locks.set(repoPath, run.then(() => {}, () => {}))
  return run
}

// 路径禁闭:relPath 解析后必须落在 root 内。拒绝对空/绝对/空字节/越界。返回规范化后的相对路径。
export function safeRelativePath(root, relPath) {
  if (typeof relPath !== 'string' || relPath === '') throw new Error('路径为空')
  if (relPath.includes('\0')) throw new Error('路径含空字节')
  if (isAbsolute(relPath)) throw new Error('禁止绝对路径')
  const rootNorm = resolve(root)
  const resolved = resolve(rootNorm, relPath)
  const rel = relative(rootNorm, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界: ${relPath}`)
  return rel
}

let _gitOk = false
export async function ensureGitAvailable() {
  if (_gitOk) return
  await execGit(['--version']) // git 缺失/超时 → 抛 GIT_FAILED
  _gitOk = true
}

export async function hasRepo(repoPath) {
  try { await stat(join(repoPath, '.git')); return true } catch { return false }
}

export async function initRepo(repoPath) {
  return withRepoLock(repoPath, async () => {
    await mkdir(repoPath, { recursive: true })
    await execGit(['init', '--quiet'], { cwd: repoPath })
    await execGit(['config', 'user.name', GIT_IDENTITY.name], { cwd: repoPath })
    await execGit(['config', 'user.email', GIT_IDENTITY.email], { cwd: repoPath })
  })
}

export async function writeFile(repoPath, relPath, content) {
  const safe = safeRelativePath(repoPath, relPath)
  return withRepoLock(repoPath, async () => {
    const abs = join(repoPath, safe)
    await mkdir(dirname(abs), { recursive: true })
    await fsWrite(abs, content, 'utf8')
  })
}

export async function readFile(repoPath, relPath) {
  const safe = safeRelativePath(repoPath, relPath)
  return fsRead(join(repoPath, safe), 'utf8')
}

// 删除工作树内一个文件(路径禁闭同 writeFile)。删除后尽力清掉变空的父目录(best-effort,失败忽略);
// 删除本身在 commit 时进 git 历史(git add -A 会记下删除)。文件不存在 → 抛(ENOENT)。
export async function deleteFile(repoPath, relPath) {
  const safe = safeRelativePath(repoPath, relPath)
  return withRepoLock(repoPath, async () => {
    const abs = join(repoPath, safe)
    await unlink(abs)
    let dir = dirname(abs)
    while (dir.startsWith(resolve(repoPath)) && dir !== resolve(repoPath)) {
      try { await rmdir(dir) } catch { break } // 非空/不存在 → 停止上溯
      dir = dirname(dir)
    }
  })
}

// 已跟踪文件(git ls-files)。未 commit 的工作树改动不在此列 —— UI 在 commit 后刷新。
export async function listFiles(repoPath) {
  return withRepoLock(repoPath, async () => {
    const r = await execGit(['ls-files'], { cwd: repoPath })
    return r.stdout.split('\n').filter(Boolean)
  })
}

export async function commit(repoPath, message) {
  return withRepoLock(repoPath, async () => {
    await execGit(['add', '-A'], { cwd: repoPath })
    const status = await execGit(['status', '--porcelain'], { cwd: repoPath })
    if (!status.stdout.trim()) return { committed: false, reason: 'nothing staged' }
    await execGit(['commit', '--quiet', '-m', message || 'update'], { cwd: repoPath })
    const log = await execGit(['log', '-1', '--format=%H%x1f%ct%x1f%s'], { cwd: repoPath })
    const [hash, ts, ...subj] = log.stdout.trim().split('\x1f')
    return { committed: true, hash, ts: Number(ts), subject: subj.join('\x1f') }
  })
}

export async function recentCommits(repoPath, n = 10) {
  return withRepoLock(repoPath, async () => {
    const r = await execGit(['log', `-${n}`, '--format=%H%x1f%ct%x1f%s'], { cwd: repoPath })
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [hash, ts, ...subj] = line.split('\x1f')
      return { hash, ts: Number(ts), subject: subj.join('\x1f') }
    })
  })
}

// 读 manifests/ 下所有 yaml 拼成 --- 分隔的串(apply/reconcile 用)。空则返空串。
export async function readManifests(repoPath) {
  const files = await listFiles(repoPath)
  const yamls = files.filter(f => f.startsWith('manifests/') && /\.ya?ml$/.test(f))
  const contents = await Promise.all(yamls.map(f => readFile(repoPath, f).catch(() => '')))
  return contents.join('\n---\n')
}
