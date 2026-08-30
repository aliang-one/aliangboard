// server/ssh/job-remote.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateJobId, jobDir, launchScript, stdinWriteScript, readScript,
  parseSideband, listScript, parseListOutput, killScript, sweepScript, sweepSnippet, capBlocks,
} from './job-remote.mjs'
import { shQuote } from './readonly-classifier.mjs'

const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const ID2 = '1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const ID3 = '2f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const ID4 = '3f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const ID5 = '4f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

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
  // 终审 C2:机会性清理与 sweep 同款「终态才删」判定,不再是按目录 mtime 的 find(会删在跑任务)
  assert.ok(s.includes('for f in /tmp/.ab-job/*/code'))
  assert.ok(!s.includes('-type d -mmin'))
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

test('listScript/parseListOutput:RUNNING→null;非数字 code→null;非 jobId 行丢弃', () => {
  assert.ok(listScript().includes('/tmp/.ab-job/*/'))
  const rows = parseListOutput(`${ID} RUNNING\n${ID2} 0\n${ID3} 141\n`)
  assert.deepEqual(rows, [
    { jobId: ID, exitCode: null },
    { jobId: ID2, exitCode: 0 },
    { jobId: ID3, exitCode: 141 },
  ])
})

// 终审 I2:sshd Banner/motd 也会在 exec 通道输出。解析不了的行必须**丢弃**——曾映射成
// {jobId:<文本>,exitCode:null} 被桥数成 RUNNING(一行 banner 即虚增并发计数,误报并发上限),
// 还会以假任务形态喂给 AI(它会去 kill)。运行中判定(并发上限)依赖 exitCode===null,故
// 「banner 行不计入 RUNNING」是这条防线的核心断言。
test('parseListOutput:banner/motd 噪音行不计入 RUNNING,也不喂给 AI', () => {
  const noisy = [
    'Connected to 203.0.113.7.', 'Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0 x86_64)', '',
    ` * Documentation:  https://help.ubuntu.com`, `0 updates can be applied immediately`, `${ID} RUNNING`,
    `${ID2} 0`, 'LIST-END', '', '',
  ].join('\n')
  const rows = parseListOutput(noisy)
  assert.deepEqual(rows, [
    { jobId: ID, exitCode: null },
    { jobId: ID2, exitCode: 0 },
  ])
  assert.equal(rows.filter(j => j.exitCode === null).length, 1, 'banner 行不得数成 RUNNING')
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
  const s = sweepScript({ ttlMin: 120 })
  assert.ok(s.includes('-mmin +120'))
  assert.ok(s.endsWith('echo OK'))
  assert.ok(s.includes('for f in /tmp/.ab-job/*/code'))
  assert.equal(capBlocks(64), 16384)
  assert.equal(capBlocks(1), 256)
})

// 终审 C2:老实现 `find -maxdepth 1 -type d -mmin +N` 按目录年龄删——目录 mtime 在启动时就定格
// (结束才因 `mv .rc code` 再变),在跑任务超 TTL 即被删;launchScript 的机会性清理还会让同服务器
// 后启动的任务静默删掉已有任务的输出(→ 不可见、不可 kill、job_out 报干净空结束)。
// 这里对真 sh 跑片段,验证「只删已达终态的目录」:
//   在跑(无 code 且 pid 活)超 TTL 不删 / code 新鲜不删 / code 超龄删 / kill 残留(无 code 且 pid 死)超 TTL 删。
test('sweep:真 sh——在跑任务超 TTL 不删;已结束(code 超龄)才删;kill 残留(pid 死)也删', () => {
  const root = mkdtempSync(join(tmpdir(), 'ab-job-sweep-'))
  const mk = (id, { code, pid, ageMin }) => {
    const d = join(root, id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'out'), 'x')
    writeFileSync(join(d, 'pid'), String(pid ?? ''))
    if (code != null) writeFileSync(join(d, 'code'), String(code))
    backdate(d, ageMin)                          // 目录 mtime 定格在启动时刻(C2 事故的触发形态)
    if (code != null) backdate(join(d, 'code'), ageMin) // code 文件年龄 = 结束时刻
    return d
  }
  const running = mk(ID, { pid: process.pid, ageMin: 90 })   // 在跑:目录已超 TTL,但 pid 活
  const fresh = mk(ID2, { code: 0, ageMin: 0 })              // 刚结束:code 新鲜
  const stale = mk(ID3, { code: 0, ageMin: 90 })             // 结束已超 TTL
  const killed = mk(ID4, { pid: spawnSync('true').pid, ageMin: 90 }) // kill 残留:无 code 且 pid 死
  const r = spawnSync('sh', ['-c', sweepScript({ ttlMin: 5, root })], { encoding: 'utf8' })
  assert.equal(r.status, 0, `sweep 脚本须成功: stderr=${r.stderr}`)
  assert.equal(existsSync(running), true, '在跑任务(无 code 且 pid 活)不得被 TTL 清掉')
  assert.equal(existsSync(fresh), true, 'code 未超 TTL 不得删')
  assert.equal(existsSync(stale), false, 'code 超龄才删')
  assert.equal(existsSync(killed), false, 'kill 残留(无 code 且 pid 死)超 TTL 应删')
  rmSync(root, { recursive: true, force: true })
})

test('sweep:真 sh——空/不存在 root 不炸(glob 无匹配);活 pid 守卫;无主残骸清掉', () => {
  // 空目录:glob 不展开成字面路径,[ -f ]/[ -d ] 守卫兜底
  const empty = mkdtempSync(join(tmpdir(), 'ab-job-sweep-empty-'))
  const r = spawnSync('sh', ['-c', sweepSnippet(5, empty)], { encoding: 'utf8' })
  assert.equal(r.status, 0, `空 root: stderr=${r.stderr}`)
  // 不存在的 root 同理
  const r2 = spawnSync('sh', ['-c', sweepSnippet(5, join(empty, 'nope'))], { encoding: 'utf8' })
  assert.equal(r2.status, 0, `不存在 root: stderr=${r2.stderr}`)
  const root = mkdtempSync(join(tmpdir(), 'ab-job-sweep-pid-'))
  const live = join(root, ID5)
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'pid'), String(process.pid))
  backdate(live, 90)
  spawnSync('sh', ['-c', sweepSnippet(5, root)])
  assert.equal(existsSync(live), true, '无 code 但 pid 活(在跑)不得被删')
  // 无 code 且 pid 文件缺失 = 启动残骸(无主,无从 kill)→ 超 TTL 可清
  const orphan = join(root, ID4)
  mkdirSync(orphan, { recursive: true })
  backdate(orphan, 90)
  spawnSync('sh', ['-c', sweepSnippet(5, root)])
  assert.equal(existsSync(orphan), false, '无 code 且无 pid 的启动残骸应清')
  rmSync(empty, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function backdate(p, ageMin) { const t = new Date(Date.now() - ageMin * 60000); utimesSync(p, t, t) }
