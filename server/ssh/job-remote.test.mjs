// server/ssh/job-remote.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  validateJobId, jobDir, launchScript, stdinWriteScript, readScript,
  parseSideband, listScript, parseListOutput, killScript, sweepScript, capBlocks,
} from './job-remote.mjs'
import { shQuote } from './readonly-classifier.mjs'

const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

// shQuote 的逃逸体(去掉首尾引号)。launchScript 里 inner→wrapper→setsid 是双层 shQuote 嵌套:
// 最终脚本中内层片段 = escape(shQuote(inner)),期望值用 shQuote 自身派生,不手写引号字面量。
const esc = x => shQuote(x).slice(1, -1)

test('validateJobId:uuid 过,路径注入/非 uuid 拒', () => {
  assert.equal(validateJobId(ID), true)
  assert.equal(validateJobId('../etc'), false)
  assert.equal(validateJobId('x; rm -rf /'), false)
  assert.equal(validateJobId(''), false)
  assert.equal(validateJobId(null), false)
})

test('launchScript:含 TTL 机会清理/meta/mkfifo/setsid/timeout/-dd 封顶/pid 回显', () => {
  const s = launchScript({
    jobId: ID, command: 'make all', timeoutMin: 30, maxOutMb: 64, ttlMin: 120,
    meta: { jobId: ID, projectId: 'p1', startedAt: 1, timeoutMin: 30, maxOutMb: 64 },
  })
  assert.ok(s.includes(`mkdir -p "/tmp/.ab-job/${ID}"`))
  assert.ok(s.includes('-mmin +120'))                     // 机会性 TTL 清理
  assert.ok(s.includes('mkfifo in'))
  assert.ok(s.includes('setsid sh -c '))
  assert.ok(s.includes('exec 9<> in'))                    // fifo 读写持有,防 EOF/阻塞
  assert.ok(s.includes('timeout --kill-after=10 30m'))
  // 内层脚本(命令 + .rc sidecar)整串经 shQuote 传给内层 sh -c;wrapper 再整体 shQuote 一次
  // → 最终脚本里是双层逃逸形状,期望值按同一复合由 shQuote 派生(命令与 sidecar 同串到达)
  const inner = 'make all\nprintf \'%s\' "$?" > .rc\n'
  assert.ok(s.includes(`sh -c ${esc(shQuote(inner))} <&9`))
  assert.ok(s.includes(`dd of=out bs=4096 count=${capBlocks(64)}`))
  assert.ok(s.includes('echo $! > pid'))
  // .rc 存在→mv 为 code(真退出码);不存在(dd SIGPIPE 杀命令)→141
  assert.ok(s.includes('[ -f .rc ]'))
  assert.ok(s.includes('echo 141 > code'))
})

test('launchScript:命令含单引号经 shQuote 正确逃逸', () => {
  const cmd = `echo 'it's fine'`
  const s = launchScript({
    jobId: ID, command: cmd, timeoutMin: 1, maxOutMb: 1, ttlMin: 120, meta: {},
  })
  // 期望值由 shQuote 自身派生:内层脚本(命令 + .rc sidecar)整串双层逃逸后仍完整成串,引号不破
  const inner = `${cmd}\nprintf '%s' "$?" > .rc\n`
  assert.ok(s.includes(`sh -c ${esc(shQuote(inner))} <&9`))
})

test('stdinWriteScript:O_RDWR 打开不阻塞;fifo 缺失 exit 3;文本经 shQuote', () => {
  const s = stdinWriteScript({ jobId: ID, text: 'y' })
  assert.ok(s.includes(`exec 9<>'/tmp/.ab-job/${ID}/in' 2>/dev/null || exit 3`))
  assert.ok(s.includes(`printf '%s\\n' 'y' >&9`))
})

test('readScript:tail 偏移 1-based + head 截断;sideband 走 stderr', () => {
  const s = readScript({ jobId: ID, offset: 100, maxBytes: 4096 })
  assert.ok(s.includes('tail -c +101'))
  assert.ok(s.includes('head -c 4096'))
  assert.ok(s.includes('1>&2'))
  assert.ok(s.includes('AB_SIZE='))
})

test('parseSideband:size/running/exitCode 解析;运行中 exitCode=null', () => {
  const running = parseSideband('AB_SIZE=2048 AB_RUNNING=1 AB_EXIT=\n')
  assert.deepEqual(running, { size: 2048, running: true, exitCode: null })
  const done = parseSideband('AB_SIZE=4096 AB_RUNNING=0 AB_EXIT=0\n')
  assert.deepEqual(done, { size: 4096, running: false, exitCode: 0 })
  const junk = parseSideband('')
  assert.deepEqual(junk, { size: 0, running: false, exitCode: null })
})

test('listScript/parseListOutput:RUNNING→null;非数字 code→null', () => {
  assert.ok(listScript().includes('/tmp/.ab-job/*/'))
  const rows = parseListOutput('aaa RUNNING\nbbb 0\nccc 141\n')
  assert.deepEqual(rows, [
    { jobId: 'aaa', exitCode: null },
    { jobId: 'bbb', exitCode: 0 },
    { jobId: 'ccc', exitCode: 141 },
  ])
})

test('killScript:TERM→1s→KILL 整进程组(负 pid);无 pid 不报错', () => {
  const s = killScript({ jobId: ID })
  assert.ok(s.includes('P=$(cat'))
  assert.ok(s.includes('kill -TERM -- -"$P"'))
  assert.ok(s.includes('kill -KILL -- -"$P"'))
  assert.ok(s.includes('sleep 1'))
  assert.ok(s.includes('NOJOB'))
})

test('sweepScript:按 ttl 找目录删;capBlocks 数学', () => {
  assert.ok(sweepScript({ ttlMin: 120 }).includes('-mmin +120'))
  assert.equal(capBlocks(64), 16384)
  assert.equal(capBlocks(1), 256)
})
