// server/ssh/job-bridge.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createSshJobBridge, _resetSweepSeenServersForTest } from './job-bridge.mjs'

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
          s.stderr = new EventEmitter()
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

const JID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

test('run:none 策略免审启动,返 jobId/pid;keyMode+readonly 策略拦非白名单', async () => {
  const sink = []
  // 第 1 次 exec=listScript(空表),第 2 次=launch(pid 行 + OK 确认行)
  const pool = fakePool([{ stdout: '' }, { stdout: '42\nOK\n' }], sink)
  const r = await bridge(pool).run({ server: 'dev-1', command: 'apt install -y htop' })
  assert.ok(r.jobId && /^[0-9a-f-]{36}$/.test(r.jobId))
  assert.equal(r.pid, '42')
  assert.equal(sink[0][1], 'srv1'); assert.equal(sink[0][2], 'wb:p1')
  assert.ok(sink.some(c => c[0] === 'exec' && c[1].includes('setsid sh -c')))
  assert.ok(sink.some(c => c[0] === 'exec' && c[1].includes('timeout --kill-after=10 30m')))
})

test('run:并发上限——远端 4 个 RUNNING 时拒', async () => {
  const listing = Array.from({ length: 4 }, () => `${randomUUID()} RUNNING`).join('\n')
  const pool = fakePool([{ stdout: listing }, { stdout: '1\n' }])
  const r = await bridge(pool).run({ server: 'dev-1', command: 'x' })
  assert.ok(/并发/.test(r.error))
})

test('run:clamp——timeoutMin 999→120;maxOutMb 0→64', async () => {
  const sink = []
  const pool = fakePool([{ stdout: '1\n' }], sink)
  await bridge(pool).run({ server: 'dev-1', command: 'x', timeoutMin: 999, maxOutMb: 0 })
  const cmd = sink.filter(c => c[0] === 'exec').find(c => c[1].includes('timeout'))[1]
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

// 终审 C1:guard 曾看 exec 退出码(readScript 末命令是 echo ⇒ 远端退出码恒 0),
// TTL 清掉的/跨服务器错配的任务返回成功形空结果,AI 误报「任务已结束无输出」。
// 合法 UUID 形状但目录不存在,正是 guard 该拦而不拦的场景(../../etc 在更早处已被拦)。
test('jobOut:合法 UUID 但远端目录不存在 → 明确报错(不再成功形空结果)', async () => {
  // 「目录不存在」签名:size 0 + 未在跑 + 无退出码,且 exec 本身成功退出(退出码 0)
  const pool = fakePool([{ stdout: '', stderr: 'AB_SIZE=0 AB_RUNNING=0 AB_EXIT=\n', exitCode: 0 }])
  const r = await bridge(pool).jobOut({ server: 'dev-1', jobId: JID })
  assert.ok(/任务不存在或输出已被清理/.test(r.error || ''), JSON.stringify(r))
})

test('jobOut:真任务的 0 输出不得误报缺任务——运行中(size 0)与刚结束(code 0)都成功形', async () => {
  const running = await bridge(fakePool([{ stdout: '', stderr: 'AB_SIZE=0 AB_RUNNING=1 AB_EXIT=\n', exitCode: 0 }]))
    .jobOut({ server: 'dev-1', jobId: JID })
  assert.equal(running.error, undefined); assert.equal(running.running, true)
  const done = await bridge(fakePool([{ stdout: '', stderr: 'AB_SIZE=0 AB_RUNNING=0 AB_EXIT=0\n', exitCode: 0 }]))
    .jobOut({ server: 'dev-1', jobId: JID })
  assert.equal(done.error, undefined); assert.equal(done.exitCode, 0); assert.equal(done.running, false)
})

// 终审 I1:acquire 失败必须包装成桥的错误形状,而非把 ssh2 原始错误抛给上层(AI 可见)。
test('acquire 拒绝 → 返回 {error:"SSH 连接失败(...)"} 而非抛出(errorKind 透传,未知归 unknown)', async () => {
  const mkPool = err => ({ acquire: async () => { throw err } })
  const kinded = new Error('connect ECONNREFUSED 1.2.3.4:22'); kinded.errorKind = 'unreachable'
  const r1 = await bridge(mkPool(kinded)).run({ server: 'dev-1', command: 'x' })
  assert.ok(/SSH 连接失败\(unreachable\)/.test(r1.error || ''), JSON.stringify(r1))
  const r2 = await bridge(mkPool(kinded)).jobOut({ server: 'dev-1', jobId: JID })
  assert.ok(/SSH 连接失败\(unreachable\)/.test(r2.error || ''), JSON.stringify(r2))
  const plain = await bridge(mkPool(new Error('boom'))).jobWrite({ server: 'dev-1', jobId: JID, text: 'y' })
  assert.ok(/SSH 连接失败\(unknown\)/.test(plain.error || ''), JSON.stringify(plain))
  const kl = await bridge(mkPool(kinded)).jobKill({ server: 'dev-1', jobId: JID })
  assert.ok(/SSH 连接失败/.test(kl.error || ''), JSON.stringify(kl))
  const ls = await bridge(mkPool(kinded)).jobList({ server: 'dev-1' })
  assert.ok(/SSH 连接失败/.test(ls.error || ''), JSON.stringify(ls))
  assert.ok(!JSON.stringify(r1).includes('1.2.3.4'), '错误文案不回显 host')
})

// 终审 I1:超时死亡处置——stream 已拿到(命令慢)只 close 流,不拆共享客户端;exec 回调从未
// 触发(死连接,stream==null)才 client.end()。此前两者都不做,半死连接还池,后续任务操作全烧满 15s。
test('execOnce 超时:stream 已拿到 → close 流且不拆池化客户端(跨会话杀伤防线)', async (t) => {
  const calls = []
  const pool = { acquire: async () => ({ client: {
    exec: (cmd, cb) => { const s = new EventEmitter(); s.stderr = new EventEmitter(); s.close = () => calls.push('stream-close'); cb(null, s) /* 拿到流但永不结束 */ },
    end: () => calls.push('end') }, release: () => calls.push('release') }) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = bridge(pool).jobOut({ server: 'dev-1', jobId: JID })
    await new Promise(r => setImmediate(r))   // 让 acquire/exec 回调先跑(setImmediate 不在 fake 范围)
    t.mock.timers.tick(15000)
    const r = await p
    assert.ok(/读取超时/.test(r.error || ''), `超时应以错误呈现,实际: ${JSON.stringify(r)}`)
    assert.ok(calls.includes('stream-close'), '本命令的流被关')
    assert.ok(calls.includes('release'), '池句柄归还')
    assert.ok(!calls.includes('end'), '共享客户端不拆(该服务器其他会话存活)')
  } finally { t.mock.timers.reset() }
})

test('execOnce 超时:exec 回调从未触发(死连接)→ client.end 拆客户端', async (t) => {
  const calls = []
  const pool = { acquire: async () => ({ client: { exec: () => { calls.push('exec-no-cb') } /* cb 永不回调 */, end: () => calls.push('end') }, release: () => calls.push('release') }) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = bridge(pool).jobOut({ server: 'dev-1', jobId: JID })
    await new Promise(r => setImmediate(r))
    t.mock.timers.tick(15000)
    const r = await p
    assert.ok(/读取超时/.test(r.error || ''), `超时应以错误呈现,实际: ${JSON.stringify(r)}`)
    assert.ok(calls.includes('end'), '死连接客户端被拆')
    assert.ok(calls.includes('release'), '池句柄归还')
  } finally { t.mock.timers.reset() }
})

test('run 超时文案:报「连接或执行超时」,不再误报「远端不支持 setsid/Linux」', async (t) => {
  const pool = { acquire: async () => ({ client: { exec: () => {} /* 永不回调 → 烧满超时 */, end: () => {} }, release: () => {} }) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = bridge(pool).run({ server: 'dev-1', command: 'apt install -y htop' })
    await new Promise(r => setImmediate(r))
    t.mock.timers.tick(15000)              // 第 1 次 exec(list)超时
    await new Promise(r => setImmediate(r)) // 第 2 次 exec(launch)的定时器此刻才被安装
    t.mock.timers.tick(15000)
    const r = await p
    assert.ok(/连接或执行超时/.test(r.error || ''), JSON.stringify(r))
    assert.ok(!/setsid|Linux/.test(r.error || ''), '死连接不得误报为服务器不支持 Linux')
  } finally { t.mock.timers.reset() }
})

// 终审 I2:banner 噪音不虚增并发计数——banner + 3 真任务 ≠ 「并发已达上限」(maxPerServer=4)。
test('run 并发上限:banner 噪音行不计入 RUNNING,不误报并发上限', async () => {
  const listing = ['Connected to 203.0.113.7.', 'Welcome to Ubuntu 22.04 LTS',
    `${JID} RUNNING`, '1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 RUNNING',
    '2f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 RUNNING'].join('\n')
  const sink = []
  const pool = fakePool([{ stdout: listing }, { stdout: '42\nOK\n' }], sink)
  const r = await bridge(pool).run({ server: 'dev-1', command: 'x' })
  assert.ok(!/并发/.test(r.error || ''), `3 真任务 + banner 应放行,实际: ${JSON.stringify(r)}`)
  assert.ok(r.jobId)
  // 对照:第 4 个真 RUNNING 任务(无 banner)即触发上限
  const full = Array.from({ length: 4 }, () => `${randomUUID()} RUNNING`).join('\n')
  const r2 = await bridge(fakePool([{ stdout: full }])).run({ server: 'dev-1', command: 'x' })
  assert.ok(/并发/.test(r2.error || ''))
})

// 终审 I2:pid 只接受纯数字行——banner 曾被当 pid 回显给 AI(它会拿去 kill)。
test('run pid:跳过 banner 行取纯数字行;全是噪音则不采信(pid 空)', async () => {
  const withBanner = fakePool([{ stdout: '' }, { stdout: 'Welcome to Ubuntu 22.04\n42\nOK\n' }])
  const r = await bridge(withBanner).run({ server: 'dev-1', command: 'x' })
  assert.equal(r.pid, '42')
  const noisy = fakePool([{ stdout: '' }, { stdout: 'Connected to 203.0.113.7.\nOK\n' }])
  const r2 = await bridge(noisy).run({ server: 'dev-1', command: 'x' })
  assert.equal(r2.pid, '', `banner 文本不得当 pid,实际: ${JSON.stringify(r2.pid)}`)
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

// T6 审查加固:sweepSeenServers 是模块级集合——run 成功登记,供网关级 sweep 专用实例读取。
// 复位钩子防止既有 run 用例静默污染后续断言(与用例顺序解耦)。
test('sweepServerIds:run 成功登记 serverId;复位钩子清空;sweepServer 单台失败不抛', async () => {
  _resetSweepSeenServersForTest()
  assert.deepEqual(createSshJobBridge({ db: fakeDb(), pool: fakePool([]), projectId: 'p1', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }) }).sweepServerIds(), [])
  // run 成功(与上面 run 用例同款两段 exec:list + launch)→ 名单含解析出的 serverId
  const pool = fakePool([{ stdout: '' }, { stdout: '42\nOK\n' }])
  await bridge(pool).run({ server: 'dev-1', command: 'apt install -y htop' })
  assert.deepEqual(createSshJobBridge({ db: fakeDb(), pool, projectId: '__sweep__', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }) }).sweepServerIds(), ['srv1'])
  // 复位后恒空:跨实例语义(网关重启=清空,该轮不扫)
  _resetSweepSeenServersForTest()
  assert.deepEqual(createSshJobBridge({ db: fakeDb(), pool, projectId: '__sweep__', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }) }).sweepServerIds(), [])
  // sweepServer:远端 sweep 失败被吞(单台失败不阻断整轮)
  const badPool = { acquire: async () => { throw new Error('conn refused') } }
  await createSshJobBridge({ db: fakeDb(), pool: badPool, projectId: '__sweep__', getPolicy: () => ({ ttlMin: 120, maxPerServer: 4 }) }).sweepServer('srv1')
})

// 2026-08-31 工具链审计修复②:异步任务输出(chunk)同样接 maskSensitiveText——
// 构建日志里泄漏的 JWT/PEM/AKIA 不再原样进 LLM 上下文+trace 落库。
test('修复②:jobOut chunk 脱敏(PEM 不明文回传)', async () => {
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\nabc=\n-----END PRIVATE KEY-----\n'
  const pool = fakePool([{ stdout: `build ok\n${PEM}`, stderr: 'AB_SIZE=100 AB_RUNNING=1 AB_EXIT=\n' }])
  const r = await bridge(pool).jobOut({ server: 'dev-1', jobId: JID, offset: 0 })
  assert.ok(r.chunk.includes('[redacted-private-key]'), `chunk 应脱敏,收到: ${JSON.stringify(r.chunk)}`)
  assert.equal(r.chunk.includes('PRIVATE KEY'), false)
  assert.equal(r.size, 100, '边带元数据不受脱敏影响')
})
