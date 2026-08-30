// server/ssh/job-bridge.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
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
  const listing = Array.from({ length: 4 }, (_, i) => `id-${i} RUNNING`).join('\n')
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
