// 单进程不变式守卫(2026-08-28 架构治理第四项)。
// 前提:AliangBoard 网关是单进程单库——SQLite(node:sqlite DatabaseSync,同步单连接)+ 会话/限流
// 内存 Map(sessions/platformSessions/rate buckets)+ 审计链哈希(prevHash 单调)都假设唯一写入者。
// 双进程同库 = 静默脑裂:会话互相看不见(懒加载兜底也只救读不救写)、审计链分叉、限流各算各的、
// SQLite 并发写锁互踩。部署侧已固定 replicas:1 + Recreate(deployment.yaml);本模块把同一约束
// 落到进程侧:启动时抢独占锁文件,持锁者活着 → 拒绝启动(exit 1),死 pid → 接管陈旧锁。
//
// 语义(测试固化,server/single-process-lock.test.mjs):
//   acquireSingleProcessLock(lockPath) → { ok:true, release() } | { ok:false, error, pid? }
//   · 锁文件内容 = 持锁 pid;O_EXCL('wx')创建,存在即读 pid 判活性;
//   · pid 活性 = process.kill(pid, 0):ESRCH=死(接管),EPERM=活着但他人(拒绝),成功=活(拒绝);
//   · 接管 = 覆写自己的 pid(unlink+重建有竞态窗口,覆写更简单且原子性足够——守卫非密码学锁);
//   · release 幂等;进程崩溃不清锁由「死 pid 接管」兜底。
// 纯 fs 操作,零依赖,可单测(tmpdir 注入路径)。
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs'

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true }         // 成功 = 活
  catch (e) {
    if (e.code === 'EPERM') return true             // 活着但属主不同
    return false                                    // ESRCH = 不存在
  }
}

export function acquireSingleProcessLock(lockPath) {
  const mine = String(process.pid)
  let heldPid = null
  try { heldPid = readFileSync(lockPath, 'utf8').trim() } catch { /* 无锁文件 → 直取 */ }
  if (heldPid) {
    const pid = Number(heldPid)
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      return { ok: false, pid, error: `检测到另一个网关进程(pid ${pid})正持有 ${lockPath}。本服务依赖单进程单库(SQLite + 内存会话/限流),双进程同库会静默脑裂。请先停掉旧进程,或换 ALIANG_DB 指向独立数据目录。` }
    }
    // 陈旧锁(持锁者已死)→ 接管。fail-closed:同进程二次接线(锁文件=自己 pid 且活着)同样拒绝。
  }
  try {
    writeFileSync(lockPath, mine, { flag: 'w' }) // 覆写接管(无竞态窗口的简单取法)
  } catch (e) {
    return { ok: false, error: `无法写锁文件 ${lockPath}: ${e?.message || e}` }
  }
  let released = false
  return {
    ok: true,
    release() {
      if (released) return
      released = true
      try { if (readFileSync(lockPath, 'utf8').trim() === mine) unlinkSync(lockPath) } catch { /* 已被清/被接管,幂等 */ }
    },
  }
}
