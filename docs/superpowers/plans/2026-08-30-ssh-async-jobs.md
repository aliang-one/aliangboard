# SSH 异步任务层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 通过 5 个新工具对已暴露 SSH 服务器执行长时任务(启动/读输出/stdin 应答/列任务/终止),并修复「提示词列了 SSH 工具但实际工具数组没有」的同源 bug。

**Architecture:** 远端 shell 原语(fifo+setsid+timeout+dd)承载任务,远端 `/tmp/.ab-job/<jobId>/` 文件目录即事实源;网关侧 `job-bridge.mjs` 全部操作走一次性 exec(复用现有连接池),纯函数拼装/解析独立在 `job-remote.mjs`。规格:`docs/superpowers/specs/2026-08-30-ssh-async-jobs-design.md`。

**Tech Stack:** node:25(node:sqlite,node --test)、ssh2(经现有池)、无新依赖。

## Global Constraints

- 测试跑法:server 侧一律 `node --test <file>`;提交前跑该 task 全部相关测试文件。
- `job-remote.mjs` 必须纯(无 IO/无 Date.now 依赖),命令拼装只做字符串合成。
- 远端命令只依赖 POSIX sh + coreutils(setsid/timeout/dd/find/tail/head/wc/kill);目标仅 Linux。
- jobId 在**任何**路径拼接前必须过 `validateJobId`(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`)。
- 错误/结果对象绝不含凭据与 host;not-found/not-exposed 文案与 `agent-bridge.mjs` refusal() 同款(不回显 host)。
- 文案:server 模块字符串沿现有惯例 zh-only(tool description/promptHint/error),不新增 i18n 键;若实现中确需前端键则 en/zh 双语齐并跑 `npm run i18n:check`。
- 提交:作者 repo config(aliangone),提交信息不带 AI 尾注。
- clamps(写死在 job-bridge,常量导出供测试):`TIMEOUT_MIN_MIN=1, TIMEOUT_MAX_MIN=120, TIMEOUT_DEFAULT_MIN=30, OUTMB_MIN=1, OUTMB_MAX=512, OUTMB_DEFAULT=64, OUTBYTES_DEFAULT=16384, OUTBYTES_MAX=32768, WRITE_TEXT_MAX=4096`。

---

### Task 1: job-remote.mjs——远端命令拼装与解析(纯函数)

**Files:**
- Create: `server/ssh/job-remote.mjs`
- Test: `server/ssh/job-remote.test.mjs`

**Interfaces:**
- Consumes: `shQuote` from `./readonly-classifier.mjs`
- Produces(后续任务按这些签名消费):
  - `validateJobId(id) -> boolean`
  - `jobDir(id) -> "/tmp/.ab-job/<id>"`
  - `launchScript({ jobId, command, timeoutMin, maxOutMb, ttlMin, meta }) -> string`(meta 为可 JSON.stringify 的对象)
  - `stdinWriteScript({ jobId, text }) -> string`
  - `readScript({ jobId, offset, maxBytes }) -> string`
  - `parseSideband(stderrText) -> { size:number, running:boolean, exitCode:number|null }`
  - `listScript() -> string`;`parseListOutput(stdoutText) -> [{ jobId, exitCode:number|null }]`
  - `killScript({ jobId }) -> string`;`sweepScript({ ttlMin }) -> string`
  - `capBlocks(maxOutMb) -> number`(= ceil(maxOutMb*1024*1024/4096))

- [ ] **Step 1: 写失败测试**

```js
// server/ssh/job-remote.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  validateJobId, jobDir, launchScript, stdinWriteScript, readScript,
  parseSideband, listScript, parseListOutput, killScript, sweepScript, capBlocks,
} from './job-remote.mjs'

const ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

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
  assert.ok(s.includes(`D=/tmp/.ab-job/${ID}`))
  assert.ok(s.includes('-mmin +120'))                     // 机会性 TTL 清理
  assert.ok(s.includes('mkfifo in'))
  assert.ok(s.includes('setsid sh -c '))
  assert.ok(s.includes('exec 9<> in'))                    // fifo 读写持有,防 EOF/阻塞
  assert.ok(s.includes('timeout --kill-after=10 30m'))
  assert.ok(s.includes(`sh -c ${`'make all\nprintf '%s' "$?" > .rc\n'`}`)) // 退出码经 .rc sidecar,shQuote 形状
  assert.ok(s.includes(`dd of=out bs=4096 count=${capBlocks(64)}`))
  assert.ok(s.includes('echo $! > pid'))
  // .rc 存在→mv 为 code(真退出码);不存在(dd SIGPIPE 杀命令)→141
  assert.ok(s.includes('[ -f .rc ]'))
  assert.ok(s.includes('echo 141 > code'))
})

test('launchScript:命令含单引号经 shQuote 正确逃逸', () => {
  const s = launchScript({
    jobId: ID, command: `echo 'it's fine'`, timeoutMin: 1, maxOutMb: 1, ttlMin: 120, meta: {},
  })
  // shQuote 输出形状:'...'\''...' —— 拼进的内层脚本不破引号
  assert.ok(s.includes(`'echo 'it'\\''s fine''\nprintf '%s' "$?" > .rc\n'`))
})

test('stdinWriteScript:O_RDWR 打开不阻塞;fifo 缺失 exit 3;文本经 shQuote', () => {
  const s = stdinWriteScript({ jobId: ID, text: 'y' })
  assert.ok(s.includes(`exec 9<>"/tmp/.ab-job/${ID}/in" 2>/dev/null || exit 3`))
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
  assert.ok(s.includes('kill -TERM -- -"$(cat'))
  assert.ok(s.includes('kill -KILL -- -"$(cat'))
  assert.ok(s.includes('sleep 1'))
  assert.ok(s.includes('NOJOB'))
})

test('sweepScript:按 ttl 找目录删;capBlocks 数学', () => {
  assert.ok(sweepScript({ ttlMin: 120 }).includes('-mmin +120'))
  assert.equal(capBlocks(64), 16384)
  assert.equal(capBlocks(1), 256)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/ssh/job-remote.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 job-remote.mjs**

```js
// SSH 异步任务远端命令拼装/解析(纯函数,零 IO)。规格 2026-08-30 §3。
// 铁律:jobId 拼路径前必过 validateJobId;所有脚本只依赖 POSIX sh + coreutils(Linux)。
import { shQuote } from './readonly-classifier.mjs'

export const JOB_ROOT = '/tmp/.ab-job'
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function validateJobId(id) { return typeof id === 'string' && JOB_ID_RE.test(id) }
export function jobDir(id) {
  if (!validateJobId(id)) throw new Error('bad jobId')
  return `${JOB_ROOT}/${id}`
}
export const capBlocks = mb => Math.ceil((Number(mb) * 1024 * 1024) / 4096)

// 启动:机会性 TTL 清理 → 建目录/meta/fifo → setsid 后台 wrapper(远端 timeout 强制寿命;
// 退出码经 .rc sidecar 精确落 code,dd SIGPIPE 杀命令时落 141)→ pid 落盘并回显。
export function launchScript({ jobId, command, timeoutMin, maxOutMb, ttlMin, meta }) {
  const D = jobDir(jobId)
  const inner = `${String(command)}\nprintf '%s' "$?" > .rc\n`
  const wrapper = `exec 9<> in; timeout --kill-after=10 ${Number(timeoutMin)}m sh -c ${shQuote(inner)} <&9 2>&1 | dd of=out bs=4096 count=${capBlocks(maxOutMb)} 2>/dev/null; if [ -f .rc ]; then mv .rc code; else echo 141 > code; fi; rm -f .rc`
  return [
    `find ${JOB_ROOT} -maxdepth 1 -type d -mmin +${Number(ttlMin)} -exec rm -rf {} + 2>/dev/null`,
    `mkdir -p "${D}" && cd "${D}" || exit 1`,
    `printf '%s\\n' ${shQuote(JSON.stringify(meta))} > meta`,
    `mkfifo in || exit 1`,
    `setsid sh -c ${shQuote(wrapper)} < /dev/null > /dev/null 2>&1 &`,
    `echo $! > pid`,
    `echo OK`,
  ].join('\n')
}

// stdin 应答:O_RDWR 打开永不阻塞(自己即读端);fifo 缺失 = 任务已结束/清理 → exit 3。
export function stdinWriteScript({ jobId, text }) {
  const D = jobDir(jobId)
  return `exec 9<>"/tmp/.ab-job/${D.split('/').pop()}/in" 2>/dev/null || exit 3; printf '%s\\n' ${shQuote(String(text))} >&9`
}

// 读输出:stdout=原始字节(tail 1-based 偏移 + head 截断);stderr 边带一行元数据。
export function readScript({ jobId, offset, maxBytes }) {
  const D = jobDir(jobId)
  return [
    `tail -c +${Number(offset) + 1} "${D}/out" 2>/dev/null | head -c ${Number(maxBytes)}`,
    `echo "AB_SIZE=$(wc -c < "${D}/out" 2>/dev/null || echo 0) AB_RUNNING=$([ ! -f "${D}/code" ] && kill -0 "$(cat "${D}/pid" 2>/dev/null)" 2>/dev/null && echo 1 || echo 0) AB_EXIT=$(cat "${D}/code" 2>/dev/null || echo '')" 1>&2`,
  ].join('\n')
}

export function parseSideband(stderrText) {
  const m = /AB_SIZE=(\d+)\s+AB_RUNNING=(\d)\s+AB_EXIT=(\d*)/.exec(String(stderrText || ''))
  if (!m) return { size: 0, running: false, exitCode: null }
  return { size: Number(m[1]), running: m[2] === '1', exitCode: m[3] === '' ? null : Number(m[3]) }
}

export function listScript() {
  return `for d in ${JOB_ROOT}/*/; do [ -d "$d" ] || continue; echo "$(basename "$d") $(cat "$d/code" 2>/dev/null || echo RUNNING)"; done; echo LIST-END`
}

export function parseListOutput(stdoutText) {
  return String(stdoutText || '').split('\n').filter(l => l && !l.includes('LIST-END')).map(l => {
    const [jobId, code] = l.trim().split(/\s+/)
    const n = Number(code)
    return { jobId, exitCode: code === 'RUNNING' || !Number.isFinite(n) ? null : n }
  })
}

export function killScript({ jobId }) {
  const D = jobDir(jobId)
  return `P=$(cat "${D}/pid" 2>/dev/null); if [ -z "$P" ]; then echo NOJOB; exit 0; fi; kill -TERM -- -"$P" 2>/dev/null; sleep 1; kill -KILL -- -"$P" 2>/dev/null; echo KILLED`
}

export function sweepScript({ ttlMin }) {
  return `find ${JOB_ROOT} -maxdepth 1 -type d -mmin +${Number(ttlMin)} -exec rm -rf {} + 2>/dev/null; echo OK`
}
```

注意 `stdinWriteScript` 里的目录片段写法要直白(直接用 `jobDir(jobId)` 的返回值内插即可,上面绕了一道是为了示范;实现时直接:

```js
export function stdinWriteScript({ jobId, text }) {
  const D = jobDir(jobId)
  return `exec 9<>${shQuote(D + '/in')} 2>/dev/null || exit 3; printf '%s\\n' ${shQuote(String(text))} >&9`
}
```

若改用此形态,**同步修正 Step 1 测试**的断言形状为 `exec 9<>'/tmp/.ab-job/<ID>/in'`(引号形状以实现为准,测试锁行为:O_RDWR 打开 + exit 3 + shQuote 文本)。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/ssh/job-remote.test.mjs`
Expected: PASS(9 tests)

- [ ] **Step 5: Commit**

```bash
git add server/ssh/job-remote.mjs server/ssh/job-remote.test.mjs
git commit -m "feat(ssh): 异步任务远端命令拼装/解析纯函数——launch/stdin/tail+边带/list/kill/sweep"
```

---

### Task 2: job-policy.mjs——任务策略(设置>env>默认)

**Files:**
- Create: `server/ssh/job-policy.mjs`
- Test: `server/ssh/job-policy.test.mjs`

**Interfaces:**
- Produces: `resolveJobPolicy(getFn, env) -> { ttlMin:number, maxPerServer:number }`;默认 `{ ttlMin: 120, maxPerServer: 4 }`;设置键 `ssh.job.ttlMin` / `ssh.job.maxPerServer`;env `SSH_JOB_TTL_MIN` / `SSH_JOB_MAX_PER_SERVER`。范围:ttlMin 1..10080,maxPerServer 1..16,越界回落默认。

- [ ] **Step 1: 写失败测试**

```js
// server/ssh/job-policy.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { resolveJobPolicy } from './job-policy.mjs'

test('默认值;设置>env>默认;越界回落默认', () => {
  assert.deepEqual(resolveJobPolicy(() => null, {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(() => null, { SSH_JOB_TTL_MIN: '60' }), { ttlMin: 60, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '30' : null), { SSH_JOB_TTL_MIN: '60' }),
    { ttlMin: 30, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.maxPerServer' ? '8' : null), {}),
    { ttlMin: 120, maxPerServer: 8 })
  // 越界/NaN 回落
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '0' : null), {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.maxPerServer' ? 'x' : null), {}), { ttlMin: 120, maxPerServer: 4 })
})
```

- [ ] **Step 2: 跑测试确认失败** — `node --test server/ssh/job-policy.test.mjs` → FAIL

- [ ] **Step 3: 实现**(镜像 `reap-policy.mjs` 的 resolvePolicy 形状)

```js
// SSH 异步任务策略:设置>env>默认(每跳现读,改动即时生效)。规格 2026-08-30 §4。
const DEFAULTS = { ttlMin: 120, maxPerServer: 4 }
const clamp = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : fb }
const read = (getFn, env, key, envKey, lo, hi) =>
  clamp(getFn?.(key), lo, hi, clamp(env?.[envKey], lo, hi, DEFAULTS[key === 'ssh.job.ttlMin' ? 'ttlMin' : 'maxPerServer']))

export function resolveJobPolicy(getFn, env = {}) {
  return {
    ttlMin: read(getFn, env, 'ssh.job.ttlMin', 'SSH_JOB_TTL_MIN', 1, 10080),
    maxPerServer: read(getFn, env, 'ssh.job.maxPerServer', 'SSH_JOB_MAX_PER_SERVER', 1, 16),
  }
}
```

- [ ] **Step 4: 跑测试确认通过** — `node --test server/ssh/job-policy.test.mjs` → PASS
- [ ] **Step 5: Commit**

```bash
git add server/ssh/job-policy.mjs server/ssh/job-policy.test.mjs
git commit -m "feat(ssh): 异步任务策略 resolveJobPolicy——设置>env>默认,TTL/每服务器并发"
```

---

### Task 3: job-bridge.mjs——异步任务桥(5 方法 + 审批 + keyMode)

**Files:**
- Create: `server/ssh/job-bridge.mjs`
- Test: `server/ssh/job-bridge.test.mjs`

**Interfaces:**
- Consumes: Task 1 全部纯函数;`listSshServers` from `./store.mjs`;`resolveServerRef` from `./agent-bridge.mjs`(已导出,直接复用);`classifyReadonly` from `./readonly-classifier.mjs`;Task 2 `resolveJobPolicy`
- Produces:
  - `createSshJobBridge({ db, pool, projectId, getPolicy, keyMode = false })` → `{ listExposed, needsApproval, run, jobOut, jobWrite, jobList, jobKill, sweep }`
  - `run(args: {server, command, timeoutMin?, maxOutMb?}) -> { jobId, pid, server, startedAt } | { error }`
  - `jobOut(args: {server, jobId, offset?, maxBytes?}) -> { server, jobId, chunk:string, size, offset, running, exitCode, durationMs } | { error }`
  - `jobWrite(args: {server, jobId, text}) -> { ok:true, server, jobId } | { error }`
  - `jobList(args: {server}) -> { server, jobs:[{jobId, exitCode, projectId?}] } | { error }`
  - `jobKill(args: {server, jobId}) -> { ok:true, server, jobId } | { error }`
  - `sweepServerIds() -> string[]`(内存 map 中出现过的 serverId 去重;供 index.mjs sweep 定时器遍历)
  - `sweepServer(id) -> Promise<void>`(对单台跑 sweepScript;失败静默)
  - `sweep() -> Promise<void>`(便捷组合:遍历 sweepServerIds 逐台 sweepServer)
  - 内部 `execOnce(pool, serverId, label, cmd) -> { stdout:Buffer, stderr:string, exitCode, timedOut }`(settle 单次结算闩模式,总定时器 15s,覆盖死连接;与 agent-bridge exec 同款但**不改它**——那是经过 sudo/stdin 审计的已测代码, duplication 是有意决策)

- [ ] **Step 1: 写失败测试**(沿用 agent-bridge.test.mjs 的 fakeDb + fakeStream 模式)

```js
// server/ssh/job-bridge.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createSshJobBridge } from './job-bridge.mjs'

const ROW = [{ id: 'srv1', name: 'dev-1', exposeToAi: 1, aiApprovalPolicy: 'none' }]
const fakeDb = (rows = ROW) => ({
  prepare: sql => /exposeToAi=1/.test(sql)
    ? { all: () => rows.filter(r => r.exposeToAi) }
    : { all: () => rows },
})

// 可编程 fake:execs = [{ stdout, stderr, exitCode }],按调用序消费
function fakePool(execs, sink = []) {
  let i = 0
  return {
    acquire: async (serverId, label) => {
      sink.push(['acquire', serverId, label])
      const cur = execs[Math.min(i++, execs.length - 1)]
      const client = {
        exec: (cmd, cb) => {
          sink.push(['exec', cmd])
          const s = new EventEmitter()
          s.write = () => {}
          cb(null, s)
          setImmediate(() => {
            if (cur.stdout) s.emit('data', Buffer.from(cur.stdout))
            if (cur.stderr) s.stderr.emit('data', Buffer.from(cur.stderr))
            s.emit('exit', cur.exitCode ?? 0); s.emit('close')
          })
        },
        end: () => {},
      }
      return { client, release: () => sink.push(['release']) }
    },
  }
}

const bridge = (pool, keyMode = false) => createSshJobBridge({
  db: fakeDb(), pool, projectId: 'p1', keyMode, getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }),
})

test('run:none 策略免审启动,返 jobId/pid;keyMode+readonly 策略拦非白名单', async () => {
  const sink = []
  const pool = fakePool([{ stdout: '42\n' }], sink)
  const r = await bridge(pool).run({ server: 'dev-1', command: 'apt install -y htop' })
  assert.ok(r.jobId && /^[0-9a-f-]{36}$/.test(r.jobId))
  assert.equal(r.pid, '42')
  assert.equal(sink[0][1], 'srv1'); assert.equal(sink[0][2], 'wb:p1')
  assert.ok(sink.some(c => c[0] === 'exec' && c[1].includes('setsid sh -c')))
  assert.ok(sink.some(c => c[0] === 'exec' && c[1].includes('timeout --kill-after=10 30m')))
})

test('run:并发上限——远端 4 个 RUNNING 时拒', async () => {
  const listing = Array.from({ length: 4 }, (_, i) => `id-${i} RUNNING`).join('\n')
  const pool = fakePool([{ stdout: listing }, { stdout: '1\n' }])
  const r = await bridge(pool).run({ server: 'dev-1', command: 'x' })
  assert.ok(/并发/.test(r.error))
})

test('run:clamp——timeoutMin 999→120;maxOutMb 0→64', async () => {
  const sink = []
  const pool = fakePool([{ stdout: '1\n' }], sink)
  await bridge(pool).run({ server: 'dev-1', command: 'x', timeoutMin: 999, maxOutMb: 0 })
  const cmd = sink.find(c => c[0] === 'exec')[1]
  assert.ok(cmd.includes('timeout --kill-after=10 120m'))
  assert.ok(cmd.includes('count=16384'))
})

test('jobOut:chunk/size/offset/running;边带来自 stderr', async () => {
  const pool = fakePool([{ stdout: 'hello', stderr: 'AB_SIZE=100 AB_RUNNING=1 AB_EXIT=\n' }])
  const r = await bridge(pool).jobOut({ server: 'dev-1', jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', offset: 0 })
  assert.equal(r.chunk, 'hello'); assert.equal(r.size, 100); assert.equal(r.running, true); assert.equal(r.exitCode, null)
  assert.equal(r.offset, 100) // 返回推进后的 offset(= size)
})

test('jobOut:jobId 非法直接拒(路径注入防线)', async () => {
  const r = await bridge(fakePool([{ stdout: '' }])).jobOut({ server: 'dev-1', jobId: '../../etc' })
  assert.ok(r.error)
})

test('jobWrite:none 免审 ok;readonly 策略 needsApproval=true;keyMode 恒拒', async () => {
  const sink = []
  const pool = fakePool([{ stdout: '' }], sink)
  await bridge(pool).jobWrite({ server: 'dev-1', jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', text: 'y' })
  const cmd = sink.find(c => c[0] === 'exec')[1]
  assert.ok(cmd.includes("'y'"))
  // 审批语义
  const ro = createSshJobBridge({
    db: fakeDb([{ id: 'srv1', name: 'dev-1', exposeToAi: 1, aiApprovalPolicy: 'readonly' }]),
    pool, projectId: 'p1', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }),
  })
  assert.equal(await ro.needsApproval('wb_ssh_job_write', { server: 'dev-1' }), true)
  assert.equal(await ro.needsApproval('wb_ssh_run', { server: 'dev-1', command: 'cat /etc/hostname' }), false)
  assert.equal(await ro.needsApproval('wb_ssh_run', { server: 'dev-1', command: 'apt install x' }), true)
  const km = bridge(pool, true)
  const err = await km.jobWrite({ server: 'dev-1', jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', text: 'y' })
  assert.ok(err.error)
})

test('jobList:远端行 + 内存 meta 合并 projectId', async () => {
  const b = bridge(fakePool([{ stdout: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 RUNNING\n' }]))
  const b2 = b
  await b2.run({ server: 'dev-1', command: 'x' }) // 塞内存 map(jobId 随机,不影响断言)
  const r = await b2.jobList({ server: 'dev-1' })
  assert.equal(r.server, 'dev-1')
  assert.equal(r.jobs[0].jobId, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')
  assert.equal(r.jobs[0].exitCode, null)
})

test('jobKill:none 免审 ok;keyMode 拒', async () => {
  const pool = fakePool([{ stdout: 'KILLED' }])
  const r = await bridge(pool).jobKill({ server: 'dev-1', jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' })
  assert.equal(r.ok, true)
  const err = await bridge(pool, true).jobKill({ server: 'dev-1', jobId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0' })
  assert.ok(err.error)
})

test('needsApproval:server 解析失败→true(安全默认);out/list 不被咨询(静态 false 由 registry 保证)', async () => {
  const b = bridge(fakePool())
  assert.equal(await b.needsApproval('wb_ssh_run', { server: 'ghost', command: 'x' }), true)
})

test('not-exposed 不泄露 host', async () => {
  const b = createSshJobBridge({
    db: fakeDb([{ id: 'h', name: 'hid', exposeToAi: 0, aiApprovalPolicy: 'none', host: '9.9.9.9' }]),
    pool: fakePool([{ stdout: '' }]), projectId: 'p1', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }),
  })
  const r = await b.run({ server: 'hid', command: 'x' })
  assert.ok(r.error); assert.ok(!JSON.stringify(r).includes('9.9.9.9'))
})
```

- [ ] **Step 2: 跑测试确认失败** — `node --test server/ssh/job-bridge.test.mjs` → FAIL

- [ ] **Step 3: 实现 job-bridge.mjs**

```js
// AI↔SSH 异步任务桥(规格 2026-08-30 §3-5):启动/读输出/stdin 应答/列表/终止。
// 铁律:全一次性 exec(复用池,零长连接);远端目录=事实源;jobId 拼路径前必 validateJobId;
// 凭据/host 绝不出现在结果;keyMode(MCP/API-key)fail-closed——write/kill 恒拒,run 按策略。
import { randomUUID } from 'node:crypto'
import { listSshServers } from './store.mjs'
import { resolveServerRef } from './agent-bridge.mjs'
import { classifyReadonly } from './readonly-classifier.mjs'
import { resolveJobPolicy } from './job-policy.mjs'
import {
  validateJobId, jobDir, launchScript, stdinWriteScript, readScript, parseSideband,
  listScript, parseListOutput, killScript, sweepScript,
  // Global Constraints 常量也从此模块导出(见下)
} from './job-remote.mjs'

export const TIMEOUT_MIN_MIN = 1, TIMEOUT_MAX_MIN = 120, TIMEOUT_DEFAULT_MIN = 30
export const OUTMB_MIN = 1, OUTMB_MAX = 512, OUTMB_DEFAULT = 64
export const OUTBYTES_DEFAULT = 16384, OUTBYTES_MAX = 32768, WRITE_TEXT_MAX = 4096
const EXEC_ONCE_TIMEOUT_MS = 15000

const clampN = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : fb }

// 单次结算闩:超时/exec 回调/close/error 谁先到谁赢(与 agent-bridge exec 同款语义;
// 有意不复用其函数——那里缠着 sudo/stdin/审计,是已测代码,不动)。
function execOnce(pool, serverId, label, cmd) {
  return pool.acquire(serverId, label).then(conn => new Promise(resolveP => {
    let done = false, timer = null
    let out = Buffer.alloc(0), errBuf = ''
    const settle = r => { if (done) return; done = true; clearTimeout(timer); try { conn.release() } catch {} ; resolveP(r) }
    timer = setTimeout(() => settle({ stdout: out, stderr: errBuf, exitCode: null, timedOut: true }), EXEC_ONCE_TIMEOUT_MS)
    conn.client.exec(cmd, (err, s) => {
      if (err) return settle({ stdout: out, stderr: String(err.message || err), exitCode: null, timedOut: false })
      s.on('data', d => { out = Buffer.concat([out, d]) })
      s.stderr?.on?.('data', d => { errBuf += d.toString('utf8') })
      s.on('exit', code => { settle({ stdout: out, stderr: errBuf, exitCode: code, timedOut: false }) })
      s.on('error', e2 => settle({ stdout: out, stderr: String(e2.message || e2), exitCode: null, timedOut: false }))
    })
  }))
}

export function createSshJobBridge({ db, pool, projectId, getPolicy = () => resolveJobPolicy(), keyMode = false }) {
  const label = `wb:${projectId}`
  const memory = new Map() // jobId -> { serverId, projectId, startedAt }
  const resolve = ref => resolveServerRef(
    db.prepare('SELECT id,name,host,port,username,authMethod,exposeToAi,aiApprovalPolicy FROM ssh_servers').all(), ref)
  const refusal = r => r.reason === 'not-found' ? '未找到该服务器,可用清单见系统提示'
    : r.reason === 'not-exposed' ? '该服务器未暴露给 AI'
    : r.reason === 'ambiguous' ? `名称对应多台服务器,请让用户明确,候选 id:${r.candidates.map(c => c.id).join(',')}`
    : '服务器不可用'
  const listExposed = () => listSshServers(db, { exposedOnly: true })
    .map(s => ({ id: s.id, name: s.name, description: s.description || '', clusterRef: s.clusterRef || '' }))

  async function needsApproval(name, args) {   // 纯(同步 DB 读),agent-runner checkpoint/resume 两处咨询
    const r = resolve(args?.server)
    if (!r.ok) return true
    const p = r.row.aiApprovalPolicy
    if (name === 'wb_ssh_job_write') return p !== 'none'
    if (name === 'wb_ssh_run') {
      if (p === 'none') return false
      if (p === 'readonly') return !classifyReadonly(args?.command)
      return true
    }
    return true
  }

  async function run(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const cmd = String(args?.command || '')
    if (!cmd.trim()) return { error: 'command 为空' }
    const policy = getPolicy()
    const timeoutMin = clampN(args?.timeoutMin, TIMEOUT_MIN_MIN, TIMEOUT_MAX_MIN, TIMEOUT_DEFAULT_MIN)
    const maxOutMb = clampN(args?.maxOutMb, OUTMB_MIN, OUTMB_MAX, OUTMB_DEFAULT)
    if (keyMode) {
      const p = r.row.aiApprovalPolicy || 'always'
      if (p === 'always') return { error: '该服务器审批策略为 always(启动需人审),key 通道无人审不可启动;将策略调为 none/readonly 后重试' }
      if (p === 'readonly' && !classifyReadonly(cmd)) return { error: '该服务器审批策略为 readonly(仅只读命令免审),key 通道无人审,非只读任务已拒' }
    }
    // 并发上限:远端 RUNNING 数
    const lst = await execOnce(pool, r.row.id, label, listScript())
    const runningCount = parseListOutput(lst.stdout.toString('utf8')).filter(j => j.exitCode === null).length
    if (runningCount >= policy.maxPerServer) return { error: `该服务器运行中任务已达上限(${policy.maxPerServer}),请先等待或终止部分任务` }
    const jobId = randomUUID()
    const startedAt = Date.now()
    const s = await execOnce(pool, r.row.id, label, launchScript({
      jobId, command: cmd, timeoutMin, maxOutMb, ttlMin: policy.ttlMin,
      meta: { jobId, projectId, startedAt, timeoutMin, maxOutMb },
    }))
    if (s.timedOut || !/OK/.test(s.stdout.toString('utf8'))) return { error: '任务启动失败(远端不支持 setsid/timeout?异步任务仅支持 Linux 服务器)' }
    memory.set(jobId, { serverId: r.row.id, projectId, startedAt })
    return { jobId, pid: s.stdout.toString('utf8').trim(), server: r.row.name, startedAt, timeoutMin, maxOutMb }
  }

  async function jobOut(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const offset = clampN(args?.offset, 0, Number.MAX_SAFE_INTEGER, 0)
    const maxBytes = clampN(args?.maxBytes, 1, OUTBYTES_MAX, OUTBYTES_DEFAULT)
    const started = Date.now()
    const s = await execOnce(pool, r.row.id, label, readScript({ jobId, offset, maxBytes }))
    if (s.timedOut) return { error: '读取超时' }
    const sb = parseSideband(s.stderr)
    if (sb.size === 0 && s.exitCode !== 0) return { error: '任务不存在或输出已被清理(TTL),请用 wb_ssh_job_list 确认' }
    return {
      server: r.row.name, jobId, chunk: s.stdout.toString('utf8'),
      size: sb.size, offset: Math.min(sb.size, offset + maxBytes),
      running: sb.running, exitCode: sb.exitCode, durationMs: Date.now() - started,
    }
  }

  async function jobWrite(args) {
    if (keyMode) return { error: 'stdin 应答仅工作台 AI 支持(需人审),key 通道不可用' }
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const text = String(args?.text ?? '')
    if (!text.length) return { error: 'text 为空' }
    if (text.length > WRITE_TEXT_MAX) return { error: `text 超长(上限 ${WRITE_TEXT_MAX})` }
    const s = await execOnce(pool, r.row.id, label, stdinWriteScript({ jobId, text }))
    if (s.exitCode === 3) return { error: '任务 stdin 已关闭(任务已结束或被清理)' }
    if (s.timedOut) return { error: '写入超时' }
    return { ok: true, server: r.row.name, jobId }
  }

  async function jobList(args) {
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const s = await execOnce(pool, r.row.id, label, listScript())
    const jobs = parseListOutput(s.stdout.toString('utf8')).map(j => ({
      ...j, projectId: memory.get(j.jobId)?.projectId || undefined,
    }))
    return { server: r.row.name, jobs }
  }

  async function jobKill(args) {
    if (keyMode) return { error: '任务终止仅工作台 AI 支持,key 通道不可用' }
    const r = resolve(args?.server)
    if (!r.ok) return { error: refusal(r) }
    const jobId = args?.jobId
    if (!validateJobId(jobId)) return { error: 'jobId 非法' }
    const s = await execOnce(pool, r.row.id, label, killScript({ jobId }))
    if (/NOJOB/.test(s.stdout.toString('utf8'))) return { error: '任务不存在(已结束或 pid 文件缺失)' }
    memory.delete(jobId)
    return { ok: true, server: r.row.name, jobId }
  }

  async function sweepServer(id) {
    try { await execOnce(pool, id, 'wb:__sweep__', sweepScript({ ttlMin: getPolicy().ttlMin })) } catch { /* 单台失败不阻断 */ }
  }
  const sweepServerIds = () => [...new Set([...memory.values()].map(v => v.serverId))]
  async function sweep() { for (const id of sweepServerIds()) await sweepServer(id) }

  return { listExposed, needsApproval, run, jobOut, jobWrite, jobList, jobKill, sweep, sweepServer, sweepServerIds }
}
```

实现时把 Global Constraints 的 clamp 常量**放本文件导出**(上方代码已含),Task 1 测试无需引用它们。

- [ ] **Step 4: 跑测试确认通过** — `node --test server/ssh/job-bridge.test.mjs` → PASS(10 tests)
- [ ] **Step 5: Commit**

```bash
git add server/ssh/job-bridge.mjs server/ssh/job-bridge.test.mjs
git commit -m "feat(ssh): 异步任务桥——run/out/write/list/kill 五方法+审批语义+keyMode fail-closed+并发上限"
```

---

### Task 4: 注册表登记——5 工具 + SSH_HIDDEN_TOOLS 扩容与导出

**Files:**
- Modify: `server/tool-registry.mjs`(WB 数组尾部、`SSH_HIDDEN_TOOLS`)
- Test: `server/tool-registry.test.mjs`(若无则新建)

**Interfaces:**
- Consumes: Task 3 的方法名(run/jobOut/jobWrite/jobList/jobKill),经 `ctx.sshJobs.*` 调用
- Produces:
  - `SSH_HIDDEN_TOOLS` 变为 **exported** const,内容 = 既有 4 项 + 新 5 项:`['wb_ssh_exec','wb_ssh_read_file','read_server_ledger','write_server_notes','wb_ssh_run','wb_ssh_job_out','wb_ssh_job_write','wb_ssh_job_list','wb_ssh_job_kill']`
  - 5 个新注册项(name/requiresApproval/exec 挂载点如下,Task 5/6 依赖)
  - `workbenchExcludeTools` 行为零变化(零暴露时隐藏全部 9 个 SSH 工具)

- [ ] **Step 1: 写失败测试**

```js
// server/tool-registry.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { registry, workbenchExcludeTools, SSH_HIDDEN_TOOLS } from './tool-registry.mjs'

test('SSH 9 工具在册;新 5 工具审批位与 exec 挂载正确', () => {
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(registry.get(n), `${n} 应在册`)
  assert.equal(registry.get('wb_ssh_run').requiresApproval, true)
  assert.equal(registry.get('wb_ssh_job_write').requiresApproval, true)
  assert.equal(registry.get('wb_ssh_job_out').requiresApproval, false)
  assert.equal(registry.get('wb_ssh_job_list').requiresApproval, false)
  assert.equal(registry.get('wb_ssh_job_kill').requiresApproval, false)
  assert.equal(typeof registry.get('wb_ssh_run').exec, 'function')
})

test('workbenchExcludeTools:零暴露隐藏全部 9 个;有暴露返回 null', () => {
  const ex = workbenchExcludeTools({ hasCluster: true, sshExposedCount: 0 })
  for (const n of SSH_HIDDEN_TOOLS) assert.ok(ex.has(n))
  assert.equal(workbenchExcludeTools({ hasCluster: true, sshExposedCount: 2 }), null)
})

test('SSH_HIDDEN_TOOLS 单一事实源导出(供 workbench-prompt 同源)', () => {
  assert.equal(Object.isFrozen(SSH_HIDDEN_TOOLS) || Array.isArray(SSH_HIDDEN_TOOLS), true)
  assert.ok(SSH_HIDDEN_TOOLS.includes('wb_ssh_run') && SSH_HIDDEN_TOOLS.includes('wb_ssh_job_kill'))
})
```

- [ ] **Step 2: 跑测试确认失败** — `node --test server/tool-registry.test.mjs` → FAIL

- [ ] **Step 3: 修改 tool-registry.mjs**

(a) WB 数组(`wb_ssh_read_file` 条目之后、`.map(t => ({ ...t, principal: 'platform', exec: t.exec }))` 之前)追加:

```js
  { name: 'wb_ssh_run', requiresApproval: true,
    description: '在平台托管的 SSH 服务器上启动长时/交互任务(后台运行,立即返回 jobId)。适用:装包/构建/备份等超 120s 的命令、需要应答的安装器(配合 wb_ssh_job_write)。服务器按其审批策略在启动时审一次;寿命上限远端强制(默认 30min,上限 120);输出封顶(默认 64MB,超出会终止任务并记 code=141)。不支持 sudo 长任务(密码会与交互应答抢 stdin)。轮询输出用 wb_ssh_job_out。',
    promptHint: 'SSH 服务器长时任务(装包/构建/交互安装器)。server=服务器名称;启动即返 jobId,用 wb_ssh_job_out 轮询(建议 2-5s)、wb_ssh_job_write 应答、wb_ssh_job_kill 终止。启动按服务器策略可能展示给用户审批。',
    inputSchema: { type: 'object', properties: { server: { type: 'string', description: 'SSH 服务器名称(见系统提示清单)' }, command: { type: 'string', description: '非交互起跑的命令;交互应答交给 wb_ssh_job_write' }, timeoutMin: { type: 'number', description: '任务寿命上限(分钟),默认 30,上限 120,远端强制' }, maxOutMb: { type: 'number', description: '输出封顶(MB),默认 64,超出终止任务' } }, required: ['server', 'command'] },
    exec: async (ctx, args) => { try { return await ctx.sshJobs.run(args) } catch (e) { return { error: e.message } } } },
  { name: 'wb_ssh_job_out', requiresApproval: false,
    description: '读取 SSH 异步任务的输出块(增量):传上次返回的 offset 取新数据,返回体含 size/running/exitCode。免审。任务由 wb_ssh_run 启动。',
    promptHint: '读长任务输出(增量轮询,建议 2-5s 一次)。offset=上次返回的 offset;看 running/exitCode 判断是否结束,结束前别急着下结论。',
    inputSchema: { type: 'object', properties: { server: { type: 'string' }, jobId: { type: 'string', description: 'wb_ssh_run 返回的 jobId' }, offset: { type: 'number', description: '字节偏移,上次返回值;缺省 0' }, maxBytes: { type: 'number', description: '本次最多读多少字节,默认 16384,上限 32768' } }, required: ['server', 'jobId'] },
    exec: async (ctx, args) => { try { return await ctx.sshJobs.jobOut(args) } catch (e) { return { error: e.message } } } },
  { name: 'wb_ssh_job_write', requiresApproval: true,
    description: '向 SSH 异步任务的 stdin 写一行应答(自动补换行)。用于交互安装器(y/n/回车)或 REPL 输入。审批随服务器策略(none 免审;readonly/always 每条人审——应答会改变任务执行流)。',
    promptHint: '给长任务的交互提示写应答(安装器 y/n、REPL 输入)。中高审批策略下每条应答都需用户批准,所以应答要一次给准。',
    inputSchema: { type: 'object', properties: { server: { type: 'string' }, jobId: { type: 'string' }, text: { type: 'string', description: '一行应答,如 "y" 或 SQL 语句' } }, required: ['server', 'jobId', 'text'] },
    exec: async (ctx, args) => { try { return await ctx.sshJobs.jobWrite(args) } catch (e) { return { error: e.message } } } },
  { name: 'wb_ssh_job_list', requiresApproval: false,
    description: '列出某 SSH 服务器上的异步任务(远端目录扫描,含网关重启前的任务)。免审。',
    promptHint: '列服务器上的异步任务与状态。网关重启后靠它找回 jobId。',
    inputSchema: { type: 'object', properties: { server: { type: 'string' } }, required: ['server'] },
    exec: async (ctx, args) => { try { return await ctx.sshJobs.jobList(args) } catch (e) { return { error: e.message } } } },
  { name: 'wb_ssh_job_kill', requiresApproval: false,
    description: '终止 SSH 服务器上的异步任务(kill 整进程组)。免审——止损是安全动作,恒审计。',
    promptHint: '终止失控/不再需要的长任务。发现任务卡死或用户改主意时用。',
    inputSchema: { type: 'object', properties: { server: { type: 'string' }, jobId: { type: 'string' } }, required: ['server', 'jobId'] },
    exec: async (ctx, args) => { try { return await ctx.sshJobs.jobKill(args) } catch (e) { return { error: e.message } } } },
```

(b) `SSH_HIDDEN_TOOLS` 改导出并扩容:

```js
// 零暴露时整组隐藏(工具定义 + 提示词文档 + 透明面板共用此单一事实源)
export const SSH_HIDDEN_TOOLS = ['wb_ssh_exec', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes',
  'wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_write', 'wb_ssh_job_list', 'wb_ssh_job_kill']
```

- [ ] **Step 4: 跑测试确认通过** — `node --test server/tool-registry.test.mjs` → PASS;回归 `node --test server/workbench-agent.test.mjs server/agent-runner-workbench.test.mjs` → PASS(零暴露隐藏语义不变)
- [ ] **Step 5: Commit**

```bash
git add server/tool-registry.mjs server/tool-registry.test.mjs
git commit -m "feat(ssh): 注册表登记异步任务 5 工具+SSH_HIDDEN_TOOLS 扩容导出(单一事实源)"
```

---

### Task 5: P0 同源修复——提示词与透明面板不再「虚列」SSH 工具

**Files:**
- Modify: `server/workbench-prompt.mjs:32-40`
- Modify: `server/routes/workbench-conversations.mjs:127-136`(ai-config 端点 `tools` 列表)
- Test: `server/workbench-prompt.test.mjs`(追加用例)

**Interfaces:**
- Consumes: Task 4 导出的 `SSH_HIDDEN_TOOLS`
- Produces: `buildWorkbenchSystemPrompt({ sshServers: [] })` 的产物**不含任何** SSH_HIDDEN_TOOLS 工具名;`sshServers` 非空时含。透明面板 `tools` 数组同语义。

- [ ] **Step 1: 写失败测试**(追加到现有 `server/workbench-prompt.test.mjs`)

```js
test('P0 同源:零暴露时提示词不出现任何 SSH 工具名;有暴露时出现', () => {
  const SSH_NAMES = ['wb_ssh_exec', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes',
    'wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_write', 'wb_ssh_job_list', 'wb_ssh_job_kill']
  const p0 = buildWorkbenchSystemPrompt({ sshServers: [] })
  for (const n of SSH_NAMES) assert.equal(p0.includes(n), false, `零暴露提示词不应含 ${n}`)
  const p1 = buildWorkbenchSystemPrompt({ sshServers: [{ id: 'a', name: 'dev-1' }] })
  assert.ok(p1.includes('wb_ssh_exec'))
  assert.ok(p1.includes('wb_ssh_run'))
})
```

(按该测试文件现有 import 形状引入 `buildWorkbenchSystemPrompt`;若它是逐字断言风格,新用例独立成 test 块即可。)

- [ ] **Step 2: 跑测试确认失败** — `node --test server/workbench-prompt.test.mjs` → 新用例 FAIL(零暴露提示词含 wb_ssh_exec 等)

- [ ] **Step 3: 修改 workbench-prompt.mjs**

```js
import { registry, SSH_HIDDEN_TOOLS } from './tool-registry.mjs'
```

`buildWorkbenchSystemPrompt` 内,tools 行改为(SSH 清单 `list` 计算之后):

```js
  // P0 同源(2026-08-30):工具文档段与实际 offering 同一事实源——零暴露时 SSH 工具
  // 不进提示词(此前虚列导致 AI「说明里有、工具里没有」的自我矛盾,用户被误导功能缺失)。
  const sshless = list.length === 0
  const tools = registry.workbenchTools()
    .filter(t => !disabled.has(t.name))
    .filter(t => !(sshless && SSH_HIDDEN_TOOLS.includes(t.name)))
```

(原 `const tools = ...` 与 `const list = ...` 的先后顺序调整:list 先算,tools 后算。)

- [ ] **Step 4: 修改 workbench-conversations.mjs ai-config 端点**

```js
      const sshServers = sshPromptServers()
      const sshless = sshServers.length === 0
      sendJson(res, 200, {
        effectivePrompt: buildWorkbenchSystemPrompt({ ...cfg, sshServers }),
        tools: registry.workbenchTools()
          .filter(t => !(sshless && SSH_HIDDEN_TOOLS.includes(t.name)))
          .map(t => ({ name: t.name, description: t.description, requiresApproval: t.requiresApproval, enabled: !disabled.has(t.name) })),
        additionalInstructions: cfg.additionalInstructions,
        model: getLlmConfig().model,
      })
```

(顶部 import 处加 `SSH_HIDDEN_TOOLS`。)

- [ ] **Step 5: 跑测试确认通过** — `node --test server/workbench-prompt.test.mjs server/routes/` 下相关路由测试 → PASS;回归 `node --test server/workbench-prompt.test.mjs`
- [ ] **Step 6: Commit**

```bash
git add server/workbench-prompt.mjs server/workbench-prompt.test.mjs server/routes/workbench-conversations.mjs
git commit -m "fix(workbench): 提示词/透明面板与工具 offering 同源——零暴露不再虚列 SSH 工具(P0,AI 自我矛盾根因)"
```

---

### Task 6: 接线——ctx.sshJobs + 动态审批路由 + 审计 + sweep

**Files:**
- Modify: `server/index.mjs`(buildWbCtx、getSshJobPolicy、sweep 定时器、createMcpServer 调用点)
- Modify: `server/workbench-agent.mjs:155-167 与 245-256`(两处 run 装配)
- Modify: `server/agent-runner.mjs:13 与 52`(WRITE_TOOLS、ctx)
- Test: `server/agent-runner-workbench.test.mjs`(追加审批路由用例)

**Interfaces:**
- Consumes: Task 2/3(`createSshJobBridge`、`resolveJobPolicy`)、Task 4(工具名)
- Produces:
  - `buildWbCtx(project)` 返回的 ctx 增 `sshJobs`(Task 4 的 `ctx.sshJobs.*` 由此到达)
  - agent-runner ctx 增 `sshJobs: workbench?.sshJobs || null`
  - dynamicApproval 复合路由:`wb_ssh_job_*` → jobBridge.needsApproval,其余 → 原逻辑
  - 审计:run/write/kill = write,out/list = read;resource 沿用 `SshServer/<server>` 分支(run 发生时尚无 jobId;jobId 已含于 requestSummary 的 args JSON)

- [ ] **Step 1: 写失败测试**(追加到 `server/agent-runner-workbench.test.mjs`,沿用其现有 fake 形状)

```js
test('动态审批路由:wb_ssh_job_* 走 sshJobs.needsApproval,其余走 ssh.needsApproval', async () => {
  // 该文件现有 createAgentRunner fake 组装处,给 workbench 传两个 stub:
  const calls = []
  const workbench = {
    ssh: { needsApproval: async (n) => { calls.push(['ssh', n]); return n === 'wb_exec' } },
    sshJobs: { needsApproval: async (n) => { calls.push(['jobs', n]); return n === 'wb_ssh_run' } },
  }
  const { run } = createAgentRunner({ llmClient: fakeLlm(), workbench, audit: null })
  // needsApproval 不直接导出;经 needsApprovalFn 行为验证——用 registry.requiringApproval() 中的
  // 静态 true 工具名分别咨询。若该测试文件的 runner 组装不暴露钩子,则改为对 agent.mjs 的
  // needsApproval 注入做 spy(沿用该文件现有的 spy 手法)。
  // 断言:'wb_ssh_run' → ['jobs','wb_ssh_run'] 且 true;'wb_ssh_exec' → ['ssh',...] 且 false
})
```

(实现者按该测试文件现有的 runner 驱动方式落地此用例——文件里已有 approval 路径的测试可照抄驱动方式;断言核心是**路由分流**,不是审批值本身。)

- [ ] **Step 2: 跑测试确认失败** — `node --test server/agent-runner-workbench.test.mjs` → FAIL(ctx.sshJobs 不存在/路由不分流)

- [ ] **Step 3: 修改 index.mjs**

(a) import 区(`server/ssh/agent-bridge.mjs` import 旁):

```js
import { createSshJobBridge } from './ssh/job-bridge.mjs'
import { resolveJobPolicy } from './ssh/job-policy.mjs'
```

(b) `getSshSessionPolicy` 定义旁(index.mjs:225 附近):

```js
// SSH 异步任务策略:设置>env>默认,每跳现读(规格 2026-08-30 §4)
const getSshJobPolicy = () => resolveJobPolicy(getSetting, process.env)
```

(c) buildWbCtx 的 `ssh: createSshAgentBridge({...})` 之后(index.mjs:1445):

```js
      // SSH 异步任务桥(规格 2026-08-30):wb_ssh_run/out/write/list/kill 经 ctx.sshJobs 到达
      sshJobs: createSshJobBridge({ db, pool: sshPool, projectId: project.id, getPolicy: getSshJobPolicy }),
```

(d) TTL 清理挂靠既有 reap 定时器(规格 §4)。在 `sshTerminals` 声明附近(index.mjs:2089 后)建专用 sweep 实例,并在既有 `setInterval(() => { sshTerminals.reapByPolicy(...) ... })`(index.mjs:2092)回调体内追加:

```js
// SSH 异步任务 TTL 清理(规格 2026-08-30 §4):对内存 map 里活跃过的服务器逐台远端 find。
// 网关重启后内存为空 → 该轮不扫;孤儿目录由下次该服务器 run() 的机会性清理兜底(launchScript 已含)。
const jobBridgeForSweep = createSshJobBridge({ db, pool: sshPool, projectId: '__sweep__', getPolicy: getSshJobPolicy })
```

定时器回调体内追加(该回调已有 try 包裹的话并入,否则自带 catch):

```js
    ;(async () => {
      for (const id of jobBridgeForSweep.sweepServerIds())
        await jobBridgeForSweep.sweepServer(id)
    })().catch(() => {})
```

(sweep 只依赖 pool/db,projectId 无关;专用实例避免逐 project 遍历。)

(e) `createMcpServer({...})` 调用点(index.mjs:568)追加 dep:`getJobPolicy: getSshJobPolicy`(Task 7 消费)。

- [ ] **Step 4: 修改 workbench-agent.mjs(两处装配同改)**

`runConversation` 与 `resumeConversation` 中,原:

```js
      const sshBridge = ctx.ssh || null
      const exposedCount = sshBridge ? sshBridge.listExposed().length : 0
```

改为:

```js
      const sshBridge = ctx.ssh || null
      const sshJobs = ctx.sshJobs || null
      const exposedCount = sshBridge ? sshBridge.listExposed().length : 0
```

原 `dynamicApproval: sshBridge ? (n, args) => sshBridge.needsApproval(n, args) : undefined,` 改为:

```js
        // 动态审批复合路由(2026-08-30):wb_ssh_job_* 由任务桥按其策略裁决,其余走同步桥
        dynamicApproval: (sshBridge || sshJobs) ? async (n, args) =>
          n.startsWith('wb_ssh_job_')
            ? (sshJobs ? sshJobs.needsApproval(n, args) : true)
            : (sshBridge ? sshBridge.needsApproval(n, args) : true)
        : undefined,
```

- [ ] **Step 5: 修改 agent-runner.mjs**

(a) WRITE_TOOLS(line 13)追加 `'wb_ssh_run', 'wb_ssh_job_write'`(`wb_ssh_job_kill` 语义上是 write verb——也加入;kick 三个都算变更类):

```js
const WRITE_TOOLS = new Set(['wb_scale', 'wb_restart', 'wb_update_image', 'wb_rollout_undo', 'wb_exec', 'wb_ssh_exec', 'write_server_notes', 'write_project_file', 'apply_project_manifests', 'propose_learning', 'bootstrap_ledger',
  'wb_ssh_run', 'wb_ssh_job_write', 'wb_ssh_job_kill'])
```

(b) ctx(line 52)追加:

```js
  const ctx = { apiKeyTools, keyRow, cluster, wb: workbench, ssh: workbench?.ssh || null, sshJobs: workbench?.sshJobs || null }
```

(c) wbAuditIntent 不改(资源归因沿用 `args.server` → `SshServer/<server>` 分支;run 时 jobId 尚不存在,jobId 已在 requestSummary 的 args JSON 里——此为对规格 §5 的落地解释,写进提交信息)。

- [ ] **Step 6: 跑测试** — `node --test server/agent-runner-workbench.test.mjs server/workbench-agent.test.mjs server/ssh/job-bridge.test.mjs` → PASS
- [ ] **Step 7: Commit**

```bash
git add server/index.mjs server/workbench-agent.mjs server/agent-runner.mjs server/agent-runner-workbench.test.mjs server/ssh/job-bridge.mjs
git commit -m "feat(ssh): 异步任务接线——ctx.sshJobs/动态审批分流/审计 WRITE_TOOLS/sweep 挂靠 reap 定时器(资源归因沿用 SshServer/<server>,jobId 在 requestSummary)"
```

---

### Task 7: MCP/API-key 通道——SSH_KEY_TOOLS 扩容 + 分派 + per-key 任务桥

**Files:**
- Modify: `server/authorize.mjs:35`
- Modify: `server/mcp.mjs:60-77 与 96-103`
- Test: `server/mcp.test.mjs`(追加)、`server/authorize.test.mjs`(若含 SSH 名单守卫则同步)

**Interfaces:**
- Consumes: Task 3 `createSshJobBridge({..., keyMode: true})`;Task 4 工具名(registry.toMeta 自动带新工具 meta)
- Produces:
  - `SSH_KEY_TOOLS = ['read_server_ledger', 'wb_ssh_exec', 'wb_ssh_read_file', 'wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_list']`(write/kill 不入——keyMode 无人审)
  - mcp.mjs 增 `sshJobBridgeFor(keyRow)`(per-key 惰性 map,`projectId: '__key__'`,`getPolicy` 来自新 dep `getJobPolicy`)

- [ ] **Step 1: 写失败测试**(追加到 `server/mcp.test.mjs`,沿用其 handleMcpMessage 驱动方式)

```js
test('MCP:sshAccess key 可列可调 wb_ssh_run/job_out/job_list;write/kill 不在列且被拒', async () => {
  // tools/list 断言含 wb_ssh_run、wb_ssh_job_out、wb_ssh_job_list,不含 wb_ssh_job_write/kill
  // tools/call wb_ssh_job_write → isError(「仅工作台」文案)
  // tools/call wb_ssh_run 走 jobBridge.run(keyMode fail-closed 在桥内已测,此处断言分派到达:
  //   fake sshJobBridgeFor 返回 spy 桥,断言 run 被调且审计 intent.verb==='write')
})
```

(用例主体按 mcp.test.mjs 现有 SSH 用例的 fake keyRow/bridge 组装逐字扩写;断言四点:列得出、分派到达、verb 正确、write/kill 被拒。)

- [ ] **Step 2: 跑测试确认失败** — `node --test server/mcp.test.mjs` → FAIL

- [ ] **Step 3: 修改 authorize.mjs**

```js
export const SSH_KEY_TOOLS = ['read_server_ledger', 'wb_ssh_exec', 'wb_ssh_read_file',
  'wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_list']
```

- [ ] **Step 4: 修改 mcp.mjs**

(a) import:

```js
import { createSshJobBridge } from './ssh/job-bridge.mjs'
import { resolveJobPolicy } from './ssh/job-policy.mjs'
```

(b) `handleMcpMessage` 的 deps 增 `sshJobBridgeFor = () => { throw new Error('ssh job bridge unavailable') }`;SSH 分派分支内,`const out = ...` 改:

```js
      const isJobTool = name === 'wb_ssh_run' || name === 'wb_ssh_job_out' || name === 'wb_ssh_job_list'
      const intent = { owner: keyRow.owner || keyRow.prefix || 'key', clusterId: keyRow.clusterId || null,
        verb: (name === 'wb_ssh_exec' || name === 'wb_ssh_run') ? 'write' : 'read',
        resource: args?.server ? `SshServer/${args.server}` : 'SshLedger',
        tool: name, source: 'mcp', requestSummary: JSON.stringify(args).slice(0, 120) }
      reserveAudit(db, intent)
      try {
        const out = name === 'read_server_ledger' ? bridge.readLedger(args)
          : name === 'wb_ssh_read_file' ? await bridge.readFile(args)
          : name === 'wb_ssh_run' ? await sshJobBridgeFor(keyRow).run(args)
          : name === 'wb_ssh_job_out' ? await sshJobBridgeFor(keyRow).jobOut(args)
          : name === 'wb_ssh_job_list' ? await sshJobBridgeFor(keyRow).jobList(args)
          : await bridge.exec(args)
```

(原 `bridge` 变量保留给 readLedger/readFile/exec;isJobTool 若未用到可删,分派按名直连。)

(c) `createMcpServer({ db, apiKeyTools, cryptKey, sshPool, getSetting = ..., setSetting = ... })` 增参 `getJobPolicy = () => resolveJobPolicy(getSetting, process.env)`;sshBridges map 旁增:

```js
  const sshJobBridges = new Map()
  function sshJobBridgeFor(keyRow) {
    const id = keyRow?.prefix || keyRow?.owner || '__key__'
    if (!sshJobBridges.has(id)) sshJobBridges.set(id, createSshJobBridge({
      db, pool: sshPool, projectId: '__key__', keyMode: true,
      getPolicy: () => getJobPolicy?.() || resolveJobPolicy(getSetting, process.env),
    }))
    return sshJobBridges.get(id)
  }
```

(d) `createMcpServer` 返回/handle 调用处(index.mjs:126 的 `handleMcpMessage(msg, { keyRow, cluster, apiKeyTools, db, sshBridgeFor })`)补 `sshJobBridgeFor`。

- [ ] **Step 5: 跑测试确认通过** — `node --test server/mcp.test.mjs server/authorize.test.mjs` → PASS
- [ ] **Step 6: Commit**

```bash
git add server/authorize.mjs server/mcp.mjs server/mcp.test.mjs
git commit -m "feat(ssh): MCP 通道异步任务——SSH_KEY_TOOLS 扩 3 项+per-key 任务桥 fail-closed 分派"
```

---

### Task 8: admin 任务策略路由——GET/PUT /api/admin/ssh-job-policy

**Files:**
- Modify: `server/routes/admin.mjs`(session-policy 路由旁)
- Modify: `server/index.mjs`(admin routes deps 增 `getSshJobPolicy`)
- Test: `server/ssh/job-policy-routes.test.mjs`(新建,镜像 `session-policy-routes.test.mjs` 的 harness)

**Interfaces:**
- Consumes: Task 2 `resolveJobPolicy`;admin.mjs 现有 deps(`getSshSessionPolicy` 注入模式,index.mjs:1479)
- Produces: `GET /api/admin/ssh-job-policy` → `{ ttlMin, maxPerServer }`;`PUT` 部分更新(键 `ttlMin`/`maxPerServer`,范围校验 1..10080 / 1..16),审计 tool=`ssh_job_policy`;设置键 `ssh.job.ttlMin` / `ssh.job.maxPerServer`

- [ ] **Step 1: 写失败测试**(复制 `session-policy-routes.test.mjs` 的 harness,替换路由与键)

```js
// server/ssh/job-policy-routes.test.mjs —— 断言:
// GET 返回 resolveJobPolicy 现值;PUT {ttlMin:60} 部分更新(maxPerServer 不动);
// PUT ttlMin=0 / maxPerServer=99 → 400 且不落库;非 admin 401;PUT 落审计(tool=ssh_job_policy)。
// harness 逐字取自 server/ssh/session-policy-routes.test.mjs,仅改:路由路径、keys、
// fake getSetting/setSetting 键名、断言值。
```

(测试体按被复制文件的实际结构填写——该文件是本仓同类路由的既定测试形状,复制后替换 6 处标识符即可,禁止凭空新造 harness。)

- [ ] **Step 2: 跑测试确认失败** — `node --test server/ssh/job-policy-routes.test.mjs` → FAIL(404)
- [ ] **Step 3: 实现**(admin.mjs,session-policy PUT 路由块之后,结构逐字镜像):

```js
    if (url.pathname === '/api/admin/ssh-job-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getSshJobPolicy())
      return true
    }
    if (url.pathname === '/api/admin/ssh-job-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const keys = ['ttlMin', 'maxPerServer']
        const range = { ttlMin: [1, 10080], maxPerServer: [1, 16] }
        for (const k of keys) {
          if (input[k] === undefined) continue
          const [lo, hi] = range[k]; const n = Number(input[k])
          if (!Number.isFinite(n) || n < lo || n > hi) { sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: k }) }); return true }
        }
        for (const k of keys) if (input[k] !== undefined) setSetting(`ssh.job.${k}`, String(input[k]))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'ssh_job_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getSshJobPolicy() })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
```

(createAdminRoutes 的 deps 解构处加 `getSshJobPolicy`;index.mjs 组 deps 对象处加同名键。)

- [ ] **Step 4: 跑测试确认通过** — `node --test server/ssh/job-policy-routes.test.mjs server/ssh/session-policy-routes.test.mjs` → PASS(后者回归)
- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.mjs server/index.mjs server/ssh/job-policy-routes.test.mjs
git commit -m "feat(ssh): admin 任务策略端点——GET/PUT /api/admin/ssh-job-policy 部分更新+范围校验+审计"
```

---

### Task 9: e2e + 门禁 + 运维清单

**Files:**
- Create: `scripts/ssh-jobs-e2e.mjs`(镜像 `scripts/key-ssh-e2e.mjs` 的连接与断言风格)
- Create: `docs/superpowers/specs/2026-08-30-ssh-async-jobs-ops.md`

**Interfaces:**
- Consumes: 全部前序任务的成品(经真实 sshd 的完整链路)
- Produces: e2e 通过记录 + 运维清单文档

- [ ] **Step 1: 写 e2e 脚本**

复制 `scripts/key-ssh-e2e.mjs` 的连接方式(其 env/鉴权形状照抄),目标主机用 env `SSHJOBS_E2E_HOST`(缺省 127.0.0.1,可指向本机 sshd 或 kind 节点)。断言序列(每步打印 ✓,失败 exit 1):

1. `wb_ssh_run` 启动 `printf 'ready\n'; sleep 60` → 返回 jobId
2. `wb_ssh_job_list` 能看到该 jobId 且 RUNNING
3. `wb_ssh_run` 启动 `wc -l`(读 stdin 的交互形态)→ `wb_ssh_job_write {text:'hello'}` → `job_out` 最终含 `1 hello` 且 exitCode 0(stdin 应答真通)
4. `job_out` offset 推进二次读取只拿增量
5. Task 3 之 kill:终止步骤 1 的任务 → `job_list` 状态改变/进程消失
6. `job_out`/`jobWrite` 用 jobId `../../etc` → 明确报错(注入防线)
7. `PUT /api/admin/ssh-job-policy {ttlMin:1}` → 200;再设回 120
8. 非法 `timeoutMin:999` 启动 → 实际拼装含 `120m`(从 job_list/远端 meta 验证)

- [ ] **Step 2: 跑 e2e** — `node scripts/ssh-jobs-e2e.mjs` → 全断言 ✓(环境无 sshd 时记录 SKIP 原因到 ops 文档,不阻塞门禁)
- [ ] **Step 3: 全量门禁**

```bash
node --test server/ && npm run i18n:check && npm run build
```
Expected: 全绿(本特性零新 i18n 键)

- [ ] **Step 4: 写运维清单** `docs/superpowers/specs/2026-08-30-ssh-async-jobs-ops.md`

内容(照规格 §8 展开,每条带验证命令/页面路径):
1. 集群实例镜像更新(SSH 桥已在 origin/main):pull 最新镜像 + rollout restart
2. 集群实例服务器页登记美国服务器 → 暴露 AI → 策略建议 readonly
3. 验证:工作台对话让 AI `read_server_ledger` 有返回
4. 清理:僵尸网关 PID 2118725(worktree 已删)与 :5199 僵尸 preview
5. 任务产物位置/清理语义(`/tmp/.ab-job`,TTL 120min,admin 可调 `PUT /api/admin/ssh-job-policy`)
6. 已知边界:Linux-only、无 sudo 长任务、输出 64MB 封顶

- [ ] **Step 5: Commit**

```bash
git add scripts/ssh-jobs-e2e.mjs docs/superpowers/specs/2026-08-30-ssh-async-jobs-ops.md
git commit -m "test(ssh): 异步任务 e2e 脚本+运维清单(集群实例基线修复+任务产物治理)"
```

---

## 任务依赖

Task 1 → Task 3;Task 2 → Task 3;Task 3 → Task 4 → Task 5 / Task 6 → Task 7 / Task 8 → Task 9。Task 5 只依赖 Task 4 的导出,可与 Task 6/7/8 并行。

## Self-Review 记录

- 规格覆盖:§2 P0→Task 5;§3 布局→Task 1;§4 生命周期→Task 1/2/3/6;§5 工具面→Task 4/7;§6 错误→Task 3;§7 测试→各任务+Task 9;§8 运维→Task 9。规格 §5 「resource=SshJob/<jobId>」落地裁决:run 时 jobId 不存在,资源归因沿用 `SshServer/<server>`,jobId 在 requestSummary(Task 6 提交信息注明)。
- 占位符:无 TBD/TODO;两处「沿用现有文件 harness 形状」是显式指令(复制+替换标识符),非占位。
- 类型一致性:`ctx.sshJobs` 全链统一;`SSH_HIDDEN_TOOLS` 单一导出源;clamp 常量单点导出于 job-bridge.mjs。
