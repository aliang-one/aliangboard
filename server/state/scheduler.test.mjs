// server/state/scheduler.test.mjs
// 清扫驱动:注册节奏/单 sweep 失败隔离(不殃及其他)/失败可见(lastError + console.error)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSweep, sweepsSnapshot, _clearSchedulerForTest } from './scheduler.mjs'

// 等条件成立(轮询至期限,满足即早退):负载下 timer 首个 tick 可能迟于 cadence,
// 固定短睡是时间敏感 flaky(实测 35ms 窗口只跑到 1 次),故不用固定 sleep。
async function waitFor(cond, timeoutMs = 2000) {
  for (let deadline = Date.now() + timeoutMs; !cond() && Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 10))
  }
}

test('重名 throw;sweepsSnapshot 暴露运行计数', async () => {
  _clearSchedulerForTest()
  registerSweep({ name: 't1', cadenceMs: 10, fn: () => {} })
  assert.throws(() => registerSweep({ name: 't1', cadenceMs: 10, fn: () => {} }))
  await waitFor(() => sweepsSnapshot()[0].runs >= 2)
  const s = sweepsSnapshot()[0]
  assert.equal(s.name, 't1')
  assert.ok(s.runs >= 2, `runs=${s.runs}`)
  assert.equal(s.lastError, null)
  assert.ok(s.lastRunAt > 0)
})

test('失败隔离:一个 sweep 抛错只记 lastError,另一个照常跑', async () => {
  _clearSchedulerForTest()
  let good = 0
  registerSweep({ name: 'bad', cadenceMs: 5, fn: () => { throw new Error('boom') } })
  registerSweep({ name: 'good', cadenceMs: 5, fn: () => { good++ } })
  await waitFor(() => (sweepsSnapshot().find(s => s.name === 'bad')?.runs >= 2) && good >= 2)
  const snap = Object.fromEntries(sweepsSnapshot().map(s => [s.name, s]))
  assert.ok(snap.bad.lastError.includes('boom'))
  assert.ok(snap.bad.runs >= 2)
  assert.ok(good >= 2, 'good sweep 不被 bad 殃及')
})
