// P1a 测试(2026-08-14 审计):runBoundedCollect —— AI exec 路径的超时 + 流式字节上限。
// 纯逻辑:fake conn(EventEmitter + close)+ 真 Writable sink,无 k8s 依赖。
// 背景:execCapture 原实现 `await conn.on('close')` 无超时,tail -f/sleep 类命令会把
// MCP tools/call 永久挂死(审计停在 reserved);输出先全量缓冲再截断,cat 大文件先吃满内存。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { runBoundedCollect, toExecArgv, k8sStatusToExitCode } from './exec-bounds.mjs'

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

// --- toExecArgv(2026-08-25 exec 字符串命令 bug):exec API 的 argv 必须以数组传 ---
// 根因:client-node 用 querystring.stringify({command}) 编码——字符串只产单个
// command=cat%20--%20%2Fetc 参数(kubelet 收到单元素 argv,整串被当二进制名 →
// executable not found in $PATH);数组才产重复 command= 参数(一词一参)。
// toExecArgv 把字符串归一成 ['sh','-c',cmd](shell 语义,exec_pod/wb_exec 的契约),
// execCapture 入口兜底 + 字符串调用方显式使用;数组调用方透传。
test('toExecArgv: 字符串 → ["sh","-c",str](shell 语义包装)', () => {
  assert.deepEqual(toExecArgv('nc -zv mysql 3306'), ['sh', '-c', 'nc -zv mysql 3306'])
  assert.deepEqual(toExecArgv('ls'), ['sh', '-c', 'ls'])
})

test('toExecArgv: 数组 → 同一引用透传(已正确的 argv 形态不动)', () => {
  const argv = ['cat', '--', '/etc/hosts']
  assert.equal(toExecArgv(argv), argv)
})

test('toExecArgv: 空串/空白串/空数组/非命令类型 → 抛(防 sh -c "" 幽灵命令)', () => {
  assert.throws(() => toExecArgv(''), /command/)
  assert.throws(() => toExecArgv('   '), /command/)
  assert.throws(() => toExecArgv([]), /command/)
  assert.throws(() => toExecArgv(null), /command/)
  assert.throws(() => toExecArgv(123), /command/)
})

// --- k8sStatusToExitCode(2026-08-26 exit=[object Object] bug):exec status 回调是 V1Status 对象 ---
// 根因:client-node exec 的 status 回调收到的是 K8s Status 对象而非数字——成功
// `{status:'Success'}`(码隐含 0);非零退出 `{status:'Failure',reason:'NonZeroExitCode',
// details:{causes:[{reason:'ExitCode',message:'126'}]}}`(码在 causes[].message,
// kubectl/client-go 同款语义)。wb_exec/exec_pod 把整个对象塞进 exitCode → 前端
// fmtExec 模板插值渲染成 exit=[object Object],LLM/MCP 收到结构噪音。
test('k8sStatusToExitCode: Success → 0;null/undefined → null(未知)', () => {
  assert.equal(k8sStatusToExitCode({ status: 'Success' }), 0)
  assert.equal(k8sStatusToExitCode(null), null)
  assert.equal(k8sStatusToExitCode(undefined), null)
})

test('k8sStatusToExitCode: NonZeroExitCode → 码取 details.causes[reason=ExitCode].message(126/127 等)', () => {
  const nonZero = (code) => ({
    kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NonZeroExitCode',
    message: `command terminated with non-zero exit code: ${code}`,
    details: { causes: [{ reason: 'ExitCode', message: String(code) }] },
  })
  assert.equal(k8sStatusToExitCode(nonZero(126)), 126)
  assert.equal(k8sStatusToExitCode(nonZero(1)), 1)
  // 用户实测样本:db-migrate 失败(exit 1)
  assert.equal(k8sStatusToExitCode(nonZero(127)), 127)
})

test('k8sStatusToExitCode: Failure 无 ExitCode cause(协议层错误等)→ null;数字防御透传', () => {
  assert.equal(k8sStatusToExitCode({ status: 'Failure', reason: 'BadRequest', message: 'x' }), null)
  assert.equal(k8sStatusToExitCode({ status: 'Failure' }), null)
  // 防御:若未来 client-node 版本改成回传数字,原样透传
  assert.equal(k8sStatusToExitCode(0), 0)
  assert.equal(k8sStatusToExitCode(42), 42)
})
