// W1 存储层测试:git 原语 roundtrip + 安全加固(路径禁闭/锁串行/错误结构化/hook 抑制)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile as fsWrite, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureGitAvailable, initRepo, writeFile, readFile, listFiles, commit, recentCommits,
  hasRepo, withRepoLock, safeRelativePath, deleteFile, readManifests,
} from './workbench-repos.mjs'

const delay = ms => new Promise(r => setTimeout(r, ms))
let _seq = 0
async function freshRepo() {
  const dir = await mkdtemp(join(tmpdir(), `wb-repo-${Date.now()}-${_seq++}-`))
  await initRepo(dir)
  return dir
}

test('roundtrip:init → write → commit → list → read → recentCommits', async () => {
  const repo = await freshRepo()
  try {
    await writeFile(repo, 'manifests/deploy.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n')
    await writeFile(repo, 'notes/input.md', '# 目标\n建个 CI/CD\n')
    const c = await commit(repo, '初始 manifests + notes')
    assert.equal(c.committed, true)
    assert.ok(c.hash && c.subject === '初始 manifests + notes')
    const files = await listFiles(repo)
    assert.ok(files.includes('manifests/deploy.yaml'))
    assert.ok(files.includes('notes/input.md'))
    assert.equal(await readFile(repo, 'manifests/deploy.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n')
    const log = await recentCommits(repo, 5)
    assert.equal(log.length, 1)
    assert.equal(log[0].subject, '初始 manifests + notes')
    assert.ok(log[0].ts > 0)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('路径禁闭:safeRelativePath 拒绝 越界/绝对/空字节/空', () => {
  const root = '/tmp/root'
  assert.throws(() => safeRelativePath(root, '../etc/passwd'), /越界/)
  assert.throws(() => safeRelativePath(root, 'a/../../../etc'), /越界/)
  assert.throws(() => safeRelativePath(root, '/etc/passwd'), /绝对/)
  assert.throws(() => safeRelativePath(root, 'a\0b'), /空字节/)
  assert.throws(() => safeRelativePath(root, ''), /为空/)
  // 合法路径规范化
  assert.equal(safeRelativePath(root, 'manifests/deploy.yaml'), 'manifests/deploy.yaml')
  assert.equal(safeRelativePath(root, 'a/../b.txt'), 'b.txt')
})

test('writeFile 拒绝路径穿越', async () => {
  const repo = await freshRepo()
  try {
    await assert.rejects(writeFile(repo, '../../escape.yaml', 'x'), /越界|绝对/)
    await assert.rejects(writeFile(repo, '/etc/escape', 'x'), /绝对/)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('withRepoLock:同 repo 串行,不交错', async () => {
  const repo = '/fake/repo-lock-test'
  const order = []
  const p1 = withRepoLock(repo, async () => { order.push('a-start'); await delay(20); order.push('a-end') })
  const p2 = withRepoLock(repo, async () => { order.push('b-start'); await delay(5); order.push('b-end') })
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('withRepoLock:fn 抛错不污染链,后续 op 仍跑', async () => {
  const repo = '/fake/repo-lock-err'
  await assert.rejects(withRepoLock(repo, async () => { throw new Error('boom') }))
  const ok = await withRepoLock(repo, async () => 'ok')
  assert.equal(ok, 'ok')
})

test('GIT_FAILED:非 repo 目录上跑 git log → 结构化错误', async () => {
  const nowhere = join(tmpdir(), `wb-nowhere-${Date.now()}`)
  await assert.rejects(recentCommits(nowhere, 5), (e) => e.code === 'GIT_FAILED' && Array.isArray(e.gitArgs))
})

test('hook 抑制:-c core.hooksPath=/dev/null 使 .git/hooks 不执行', async () => {
  const repo = await freshRepo()
  const sentinel = join(repo, 'SENTINEL_HOOK_RAN')
  try {
    // 种一个 pre-commit hook:若执行则建 sentinel 文件
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    await fsWrite(hook, `#!/bin/sh\ntouch "${sentinel}"\n`)
    await chmod(hook, 0o755)
    await writeFile(repo, 'x.txt', 'x')
    const c = await commit(repo, 'should not run hook')
    assert.equal(c.committed, true, 'commit 本身成功')
    let ran = false
    try { await (await import('node:fs/promises')).stat(sentinel); ran = true } catch { /* sentinel 不存在 = hook 没跑 */ }
    assert.equal(ran, false, 'hook 不应执行(hooksPath=/dev/null 生效)')
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('commit nothing-staged:无改动 → committed:false', async () => {
  const repo = await freshRepo()
  try {
    await writeFile(repo, 'a.txt', 'x'); await commit(repo, 'add a')
    const again = await commit(repo, 'nothing')
    assert.equal(again.committed, false)
    assert.equal(again.reason, 'nothing staged')
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('hasRepo / ensureGitAvailable', async () => {
  await ensureGitAvailable() // git 存在则不抛
  await ensureGitAvailable() // 缓存:二次也 ok
  const repo = await freshRepo()
  try {
    assert.equal(await hasRepo(repo), true)
    assert.equal(await hasRepo(join(tmpdir(), `wb-no-${Date.now()}`)), false)
  } finally { await rm(repo, { recursive: true, force: true }) }
})

// 回归(2026-08-16 write→apply 断链):write_project_file 只写盘不 commit,而 listFiles 旧实现
// git ls-files 只列已跟踪文件 → 刚写的 manifests/*.yaml 对 readManifests(apply_project_manifests
// 与 reconcile 的数据源)不可见。agent 会话内无任何 commit 路径(无 commit 工具、不自动 commit),
// 症状=「写成功能读回,apply 始终报 manifests/ 为空」。listFiles 须含未跟踪文件。
test('readManifests:刚写盘未 commit 的 yaml 即可见(apply 不依赖中间 commit)', async () => {
  const repo = await freshRepo()
  try {
    await writeFile(repo, 'manifests/deploy.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n')
    const files = await listFiles(repo)
    assert.ok(files.includes('manifests/deploy.yaml'), 'listFiles 应含未 commit 的新文件')
    const yaml = await readManifests(repo)
    assert.ok(yaml.includes('kind: ConfigMap'), '未 commit 的 manifests yaml 应被 readManifests 读到')
  } finally { await rm(repo, { recursive: true, force: true }) }
})

test('deleteFile:删工作树文件 + 空目录上溯清理;commit 记下删除;不存在抛 ENOENT;路径禁闭', async () => {
  const repo = await freshRepo()
  try {
    await writeFile(repo, 'manifests/deep/deploy.yaml', 'a: 1\n')
    await writeFile(repo, 'manifests/keep.yaml', 'b: 2\n')
    await commit(repo, 'init')
    await deleteFile(repo, 'manifests/deep/deploy.yaml')
    await assert.rejects(readFile(repo, 'manifests/deep/deploy.yaml'), /ENOENT/)
    // 空目录 manifests/deep 已上溯清掉;manifests/(还有 keep.yaml)保留
    const after = await listFiles(repo) // git ls-files:commit 前仍含已删文件? — ls-files 读 index,unlink 后未 add → 仍列出。删除进历史要 commit:
    const r = await commit(repo, 'rm deep/deploy.yaml')
    assert.equal(r.committed, true)
    const listed = await listFiles(repo)
    assert.ok(!listed.includes('manifests/deep/deploy.yaml'), 'commit 后 ls-files 不再含已删文件')
    assert.ok(listed.includes('manifests/keep.yaml'))
    assert.equal(after.length, 2, 'commit 前 index 仍含删除前状态(与 git 语义一致)')
    await assert.rejects(deleteFile(repo, 'manifests/deep/deploy.yaml'), /ENOENT/)
    await assert.rejects(deleteFile(repo, '../../escape.yaml'), /越界|绝对/)
  } finally { await rm(repo, { recursive: true, force: true }) }
})
