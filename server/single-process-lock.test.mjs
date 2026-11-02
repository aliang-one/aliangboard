// 单进程不变式守卫(2026-08-28 架构治理第四项):SQLite DatabaseSync + 内存 Map 会话/限流桶
// 都以「本进程是唯一网关」为前提,双进程同库 = 静默脑裂(会话互不可见/审计链分叉/限流各算各的)。
// 本测试固化锁语义:互斥拒绝(带持锁 pid)/陈旧接管/释放后可重取。
// 2026-11-02 v2(dev CrashLoop 954 次事故):容器里进程恒为 pid 1 且 pid namespace 每 pod 独立,
// 「pid 活性」跨容器世代不可靠——上个容器不干净死亡后残留锁写着 "1",新容器查 pid 1 = 查自己,
// 「死 pid 接管」永不生效。v2 锁文件落 {host,pid} JSON + 持锁心跳(touch 刷新 mtime):
// 跨主机接管以「心跳停更 > staleMs」为准 —— 活着的持有者 mtime 恒新鲜(滚动 surge 双活 → 拒绝),
// 真死的旧世代 mtime 变陈旧 → 自动接管;同主机仍走 pid 判定(同容器双启动是唯一同类场景)。
// 旧格式(裸 pid)过渡:pid 已死 → 接管;pid 活但 = 自己 pid(必为上一代容器残留)→ 走 mtime;
// pid 活且非自己 → 拒绝(同机活进程)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { acquireSingleProcessLock } from './single-process-lock.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'ab-lock-'))
const lockPath = join(tmp, 'gateway.lock')
const myHost = hostname()
const STALE_MS = 30_000
// 把锁文件 mtime 拨到 now-ageMs(模拟心跳停更/持锁始于多久前)
function ageLockFile(ageMs) {
  const t = new Date(Date.now() - ageMs)
  utimesSync(lockPath, t, t)
}
const mtimeAge = () => Date.now() - statSync(lockPath).mtimeMs

test.after(() => rmSync(tmp, { recursive: true, force: true }))

test('首次抢锁成功,锁文件落 {host,pid,t} JSON(v2)', () => {
  const l = acquireSingleProcessLock(lockPath)
  assert.equal(l.ok, true)
  const rec = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(rec.host, myHost)
  assert.equal(rec.pid, process.pid)
  assert.ok(typeof rec.t === 'number')
  assert.equal(typeof l.touch, 'function', '持锁者拿到心跳 touch')
  l.release()
})

test('同主机持锁者存活(pid 相同)→ 第二次抢锁被拒,报出持锁 pid', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, false)
  assert.equal(b.pid, process.pid, '当前进程即持锁者,应原样报出')
  assert.ok(b.error, '拒绝原因要说人话')
  a.release()
})

test('同主机持锁进程已死(pid 不存在)→ 陈旧锁被接管', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  // 模拟同容器另一进程崩溃未清锁:锁文件写同主机必不存在的 pid
  writeFileSync(lockPath, JSON.stringify({ host: myHost, pid: 999999999, t: Date.now() }))
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, true, '同主机死 pid 的陈旧锁应可接管')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  b.release()
})

test('跨主机持锁且心跳新鲜(≤staleMs)→ 拒绝:疑似滚动 surge 双活,接管=脑裂', () => {
  // 旧世代容器(另一 host/pod)持锁,心跳刚刷过(mtime 新鲜)→ 它可能还活着
  writeFileSync(lockPath, JSON.stringify({ host: 'old-pod-xyz', pid: 1, t: Date.now() }))
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false, '跨主机+新鲜心跳必须拒绝,接管会双进程同库')
  assert.equal(b.host, 'old-pod-xyz')
  assert.ok(b.error.includes('心跳'), '拒绝原因要点名心跳判据')
})

test('跨主机持锁且心跳停更(>staleMs)→ 自动接管:旧世代已死,无需人工清锁', () => {
  // dev 事故场景:旧 pod 不干净死亡,残留锁无人接管,新容器 CrashLoop 954 次
  writeFileSync(lockPath, JSON.stringify({ host: 'old-pod-xyz', pid: 1, t: Date.now() }))
  ageLockFile(STALE_MS + 10_000)
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, true, '跨主机+心跳停更=持有者已死,应自动接管')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).host, myHost)
  b.release()
})

test('旧格式(裸 pid)且 pid=自己:心跳新鲜 → 拒绝(可能处于滚动窗)', () => {
  writeFileSync(lockPath, String(process.pid)) // 上一代容器 pid 1 == 本代 pid 1,格式尚是 v1
  ageLockFile(5_000)
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false, 'v1 锁 + pid=自己 + 心跳窗内:无法排除上一代刚死不久,拒绝等下轮重试')
})

test('旧格式(裸 pid)且 pid=自己:mtime 陈旧 → 接管(本次 dev 事故的现网锁形态)', () => {
  // 现网形态:上一代容器 pid 1 写下 "1",本代容器进程也是 pid 1 —— 语义即「pid === 自己」。
  // 测试进程 pid 不是 1,故写 process.pid 模拟同号(容器里两者恒等,值本身无关紧要)。
  writeFileSync(lockPath, String(process.pid))
  ageLockFile(8 * 24 * 3600 * 1000) // 8 天前 —— 真实事故 mtime
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, true, '8 天前的裸 pid 残留锁必须能自动接管')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  b.release()
})

test('旧格式(裸 pid)且 pid 已死 → 接管(兼容原语义)', () => {
  writeFileSync(lockPath, '999999999')
  const b = acquireSingleProcessLock(lockPath)
  assert.equal(b.ok, true)
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  b.release()
})

test('锁文件内容损坏(非空但不可解析)→ 不盲接管:走 mtime 规则(新鲜拒绝/陈旧接管)', () => {
  // torn-write 场景:若损坏内容视同无锁而直接覆写,心跳防脑裂防线被绕过
  writeFileSync(lockPath, '{"host":"pod-a","pi') // 截断的 JSON
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false, '损坏锁 + mtime 新鲜:保守拒绝,不绕过心跳防线')
  ageLockFile(STALE_MS + 1)
  const c = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(c.ok, true, '损坏锁 + mtime 陈旧:接管')
  c.release()
})

test('touch() 只刷自己的锁:失权旧进程的心跳不会把接管者的锁洗新', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  // 模拟 A 失权:接管者覆写了锁文件
  writeFileSync(lockPath, JSON.stringify({ host: 'new-pod', pid: process.pid, t: Date.now() }))
  ageLockFile(STALE_MS + 1)
  a.touch() // A 的心跳定时器还活着,但不拥有锁
  assert.ok(mtimeAge() > STALE_MS, '他人锁的 mtime 不得被 A 的 touch 刷新')
  // 自己的锁照常刷新
  const c = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(c.ok, true)
  ageLockFile(20_000)
  c.touch()
  assert.ok(mtimeAge() < 5_000, 'own 锁 touch 生效')
  c.release()
})

test('同 pod 容器原地重启(同 host + v2 锁 pid=自己)→ 走 mtime 规则:陈旧接管(修复原事故形态回归)', () => {
  // OOM/liveness 杀容器:pod 不重建 → hostname 不变;新容器进程又是 pid 1。
  // 修复前:同 host 分支走 pid 活性 → 查到自己 → 永久拒启 = v1 事故原形复现(对抗审查双镜头活体复现)。
  writeFileSync(lockPath, JSON.stringify({ host: myHost, pid: process.pid, t: Date.now() }))
  ageLockFile(STALE_MS + 1)
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, true, '同 pod 容器重启后的上一代残留锁必须可接管')
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid)
  b.release()
})

test('同 pod 容器原地重启 + 心跳新鲜 → 保守拒绝,下轮 CrashLoop 自愈', () => {
  writeFileSync(lockPath, JSON.stringify({ host: myHost, pid: process.pid, t: Date.now() }))
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false, 'pid===自己 时 pid 活性不可判(查到自己),必须走 mtime 保守拒绝')
})

test('同容器双启动(pid 不同)仍走 pid 活性:活进程持锁拒绝', async () => {
  const cp = spawn('sleep', ['5'])
  writeFileSync(lockPath, JSON.stringify({ host: myHost, pid: cp.pid, t: Date.now() }))
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false, '同容器另一个活进程持锁必须拒绝(真双启动防护)')
  assert.equal(b.pid, cp.pid)
  cp.kill()
  // 等 sleep 真死再返回:后续用例对同一锁文件路径的判定依赖 cp.pid 已消失(毫秒级活性竞态)
  await new Promise(r => cp.on('exit', r))
})

test('touch() 刷新锁文件 mtime(心跳),跨主机判据随之保持「拒绝」', () => {
  const l = acquireSingleProcessLock(lockPath)
  assert.equal(l.ok, true)
  ageLockFile(20_000)
  assert.ok(mtimeAge() > 10_000)
  l.touch()
  assert.ok(mtimeAge() < 5_000, 'touch 后 mtime 应回到当下')
  l.release()
})

test('释放后可重新抢锁;release 幂等;release 不动他人锁', () => {
  const a = acquireSingleProcessLock(lockPath)
  assert.equal(a.ok, true)
  a.release()
  a.release() // 幂等,不抛
  // 模拟锁已被他人接管:release 不应删掉别人的锁
  writeFileSync(lockPath, JSON.stringify({ host: 'other', pid: 1, t: Date.now() }))
  const before = readFileSync(lockPath, 'utf8')
  const b = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(b.ok, false)
  b.release?.() // 拒绝态没有锁,release 可有可无,均不应抛
  assert.equal(readFileSync(lockPath, 'utf8'), before, '拒绝态/他人锁不可被 release 清除')
  // 正常重取:先把他人残留锁拨陈旧(跨主机判据),再抢
  ageLockFile(STALE_MS + 1)
  const c = acquireSingleProcessLock(lockPath, { staleMs: STALE_MS })
  assert.equal(c.ok, true)
  c.release()
})
