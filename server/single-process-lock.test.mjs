// 单进程不变式守卫(2026-08-28 架构治理第四项):SQLite DatabaseSync + 内存 Map 会话/限流桶
// 都以「本进程是唯一网关」为前提,双进程同库 = 静默脑裂(会话互不可见/审计链分叉/限流各算各的)。
// 本测试固化锁语义:互斥拒绝(带持锁 pid)/陈旧接管/释放后可重取。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingleProcessLock } from './single-process-lock.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ab-lock-'))
const lockPath = join(tmp, 'gateway.lock')
test.after(() => rmSync(tmp, { recursive: true, force: true }))

test('首次抢锁成功,锁文件落当前 pid', () => {
  const l = acquireSingleProcessLock(lockPath)
  assert.equal(l.ok, true)
  assert.equal(readFileSync(lockPath, 'utf8').trim(), String(process.pid))
  l.release()
})

test('持锁者存活时第二次抢锁被拒,报出持锁 pid', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, false)
  assert.equal(b.pid, process.pid, '当前进程即持锁者,应原样报出')
  assert.ok(b.error, '拒绝原因要说人话')
  a.release()
})

test('持锁进程已死(pid 不存在)→ 陈旧锁被接管', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  // 模拟持锁者崩溃未清锁:锁文件写一个必不存在的 pid
  writeFileSync(lockPath, '999999999')
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, true, '死 pid 的陈旧锁应可接管')
  assert.equal(readFileSync(lockPath, 'utf8').trim(), String(process.pid))
  b.release()
})

test('释放后可重新抢锁;release 幂等', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  a.release()
  a.release() // 幂等,不抛
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, true)
  b.release()
})
