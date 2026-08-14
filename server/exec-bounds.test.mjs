// P1a 测试(2026-08-14 审计):runBoundedCollect —— AI exec 路径的超时 + 流式字节上限。
// 纯逻辑:fake conn(EventEmitter + close)+ 真 Writable sink,无 k8s 依赖。
// 背景:execCapture 原实现 `await conn.on('close')` 无超时,tail -f/sleep 类命令会把
// MCP tools/call 永久挂死(审计停在 reserved);输出先全量缓冲再截断,cat 大文件先吃满内存。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { runBoundedCollect } from './exec-bounds.mjs'

// fake conn:close() 记录 + 触发 close 事件;neverClose=true 模拟「close 后也不出事件」的挂死连接
function fakeConn({ neverClose = false } = {}) {
  const c = new EventEmitter()
  c.closed = false
  c.close = () => { if (c.closed) return; c.closed = true; if (!neverClose) c.emit('close') }
  return c
}

// Writable.write 的完成回调形式(保证 chunk 已进 _write)
const write = (sink, data) => new Promise((r) => sink.write(data, r))

test('runBoundedCollect: 正常完成 → 收齐 stdout/stderr,无标志', async () => {
  let so, se
  const conn = fakeConn()
  const p = runBoundedCollect({ openConn: (a, b) => { so = a; se = b; return Promise.resolve(conn) } })
  await write(so, 'hello '); await write(so, 'world'); await write(se, 'boom')
  conn.close()
  const r = await p
  assert.equal(r.stdout.toString(), 'hello world')
  assert.equal(r.stderr.toString(), 'boom')
  assert.equal(r.timedOut, false)
  assert.equal(r.truncated, false)
  assert.equal(conn.closed, true, 'close 幂等,不重复触发')
})

test('runBoundedCollect: 超时 → 主动 close conn,timedOut=true,已收数据保留', async () => {
  let so
  const conn = fakeConn({ neverClose: true }) // 挂死:close 后也不出事件,只能靠 timer 收场
  const p = runBoundedCollect({ openConn: (a) => { so = a; return Promise.resolve(conn) }, timeoutMs: 30 })
  await write(so, 'partial-output')
  const r = await p
  assert.equal(r.timedOut, true)
  assert.equal(conn.closed, true, '超时必须主动 close(释放 ws 连接)')
  assert.equal(r.stdout.toString(), 'partial-output', '超时前收到的数据不丢')
  assert.equal(r.truncated, false)
})

test('runBoundedCollect: 字节超限 → 丢超出 chunk + close conn,truncated=true', async () => {
  let so
  const conn = fakeConn()
  const p = runBoundedCollect({ openConn: (a) => { so = a; return Promise.resolve(conn) }, maxBytes: 10 })
  await write(so, '12345')                        // 5B,进门
  await write(so, '67890ABCDE', )                 // 10B,5+10>10 → 整块丢 + close
  const r = await p
  assert.equal(r.truncated, true)
  assert.equal(conn.closed, true, '达流式上限应立刻 close(防 cat 大文件继续冲)')
  assert.equal(r.stdout.toString(), '12345', '缓冲不超上限')
  assert.equal(r.timedOut, false)
})

test('runBoundedCollect: 不传 bounds(timeoutMs/maxBytes=0)→ 无界,交互路径行为不变', async () => {
  let so
  const conn = fakeConn()
  const p = runBoundedCollect({ openConn: (a) => { so = a; return Promise.resolve(conn) } })
  await write(so, 'x'.repeat(1000)) // 远超任何默认上限,但未设限 → 不截断
  conn.close()
  const r = await p
  assert.equal(r.truncated, false)
  assert.equal(r.timedOut, false)
  assert.equal(r.stdout.length, 1000)
})
