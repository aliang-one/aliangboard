// 单进程不变式守卫(2026-08-28 架构治理第四项)。
// 前提:AliangBoard 网关是单进程单库——SQLite(node:sqlite DatabaseSync,同步单连接)+ 会话/限流
// 内存 Map(sessions/platformSessions/rate buckets)+ 审计链哈希(prevHash 单调)都假设唯一写入者。
// 双进程同库 = 静默脑裂:会话互相看不见(懒加载兜底也只救读不救写)、审计链分叉、限流各算各的、
// SQLite 并发写锁互踩。部署侧已固定 replicas:1 + Recreate(deployment.yaml);本模块把同一约束
// 落到进程侧:启动时抢独占锁文件;持锁者被判定活着 → 拒绝启动(exit 1);判定已死 → 接管陈旧锁。
//
// v2(2026-11-02,dev CrashLoop 954 次事故铸成):「pid 活性」在容器里跨世代不可靠——
// 容器进程恒为 pid 1 且 pid namespace 每 pod 独立,上个容器不干净死亡后残留锁写着 "1",
// 新容器 process.kill(1,0) 查到的是自己 → 「死 pid 接管」永不生效 → 无限拒启。
// v2 锁文件 = JSON {host, pid, t}(host=os.hostname(),K8s 下即 pod 名,每代唯一)+ 持锁心跳
// (acquire 返回 touch(),server 侧每 10s 刷锁文件 mtime)。接管判据:
//   · 跨 host(不同容器世代):锁文件 mtime 距今 > staleMs(默认 30s)→ 持有者已死(活着的
//     持有者心跳恒新鲜)→ 接管;心跳新鲜 → 拒绝(滚动 surge 双活窗口,接管=脑裂)。
//   · pid === 自己 pid(任何格式、与 host 无关):pid namespace 私有,本 ns 的 1 只可能是自己;
//     K8s 容器原地重启(OOMKill/liveness 杀/崩溃)不换 pod → hostname 跨世代不变、新进程又是
//     pid 1 —— 此形态只可能是「上一代残留(死)→ mtime 陈旧接管,容器重启自愈」或「本进程二次
//     接线(心跳恒新鲜)→ 保守拒绝」。绝不走 pid 活性(查到自己恒真 = v1 事故原形)。
//   · 同 host 且 pid 不同号(同容器双启动,唯一真正同类进程场景):pid 活性判定。
//   · v1 旧格式(裸 pid,无 host):pid 已死 → 接管;pid === 自己 → 同上走 mtime;
//     pid 活且非自己(同机活进程)→ 拒绝。
//   ⚠ v1→v2 过渡窗唯一缺口:v1 锁无心跳无 host,「pid===自己 + mtime 陈旧」无法区分「上一代已死
//   残留」与「上一代仍活着」——活 v1 的 mtime 同样停在它的启动时刻。滚动更新 surge 双活窗内(旧代
//   v1 pod 未被 SIGTERM 前新代已就绪),新 v2 会对活 v1 即刻接管 = 真脑裂;v1 旧代码同场景是保守
//   拒绝 = 安全停滞(2026-10-26 生产滚动 1.0.50 即踩中该形态,靠手动挪锁渡过,见
//   aliangboard.db.lock.stale.bak)。锁层不可修,只能部署侧把关:v2 首滚任何「活着的 v1 实例」前,
//   必须核对 live strategy=Recreate(或先删旧 pod 再换镜像);2026-11-02 生产 aliangboard 的
//   live RU 漂移已按此纠回 Recreate。
//   · 已知继承限制(v1 同款,非本版引入):acquire 的「读锁→分类→覆写」非原子,两进程在微秒窗内
//     同时启动理论上可双赢;现实部署(每容器单进程 + Recreate)不可达,守卫非密码学锁,不为此加复杂度。
// 语义(测试固化,server/single-process-lock.test.mjs):
//   acquireSingleProcessLock(lockPath, {staleMs}) → { ok:true, release(), touch() } | { ok:false, error, pid?, host? }
// 纯 fs 操作,零依赖,可单测(tmpdir 注入路径)。
import { writeFileSync, readFileSync, unlinkSync, utimesSync, statSync } from 'node:fs'
import { hostname } from 'node:os'

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true }         // 成功 = 活
  catch (e) {
    if (e.code === 'EPERM') return true             // 活着但属主不同
    return false                                    // ESRCH = 不存在
  }
}

// 读锁文件 → {kind:'v2', host, pid} | {kind:'v1', pid} | {kind:'corrupt'} | null(无锁/不可读)
// corrupt = 非空但不可识别(如 torn-write 截断的 JSON):绝不视同无锁——那会绕过心跳防脑裂检查,
// 一律走 mtime 规则(新鲜拒绝/陈旧接管)。
function readHolder(lockPath) {
  let raw = null
  try { raw = readFileSync(lockPath, 'utf8').trim() } catch { return null }
  if (!raw) return null
  try {
    const rec = JSON.parse(raw)
    if (rec && Number.isInteger(rec.pid) && rec.pid > 0 && typeof rec.host === 'string') {
      return { kind: 'v2', host: rec.host, pid: rec.pid }
    }
  } catch { /* v1 裸 pid 或损坏 */ }
  const pid = Number(raw)
  if (Number.isInteger(pid) && pid > 0) return { kind: 'v1', pid }
  return { kind: 'corrupt' }
}

// 锁文件 mtime 距今(ms)。心跳新鲜度判据:v2 持有者每 10s touch,v1 无心跳 → 以「上锁时刻」近似。
function lockAgeMs(lockPath) {
  try { return Date.now() - statSync(lockPath).mtimeMs } catch { return Infinity }
}

export function acquireSingleProcessLock(lockPath, { staleMs = 30_000 } = {}) {
  const mine = { host: hostname(), pid: process.pid }
  const holder = readHolder(lockPath)
  if (holder && holder.kind === 'corrupt') {
    // 损坏锁(torn-write 等):内容不可辨认,但「存在非空锁文件」本身说明曾有持有者。
    // 盲接管会绕过心跳防脑裂防线 → 与跨主机同判据:mtime 陈旧才接管。
    const age = lockAgeMs(lockPath)
    if (age > staleMs) {
      return takeover(`锁文件内容损坏且 mtime 已停更 ${Math.round(age / 1000)}s(> ${staleMs / 1000}s),判定无在世持有者,接管并重写锁`)
    }
    return {
      ok: false,
      error: `锁文件 ${lockPath} 内容损坏(torn-write?)且 mtime 新鲜(${Math.round(age / 1000)}s 前),保守拒绝以防误接管。CrashLoop 下一轮重试(mtime 陈旧后)即可接管;紧急处理可手动删除该文件。`,
    }
  }
  if (holder) {
    // 跨容器世代(host 不同):pid 不可跨 namespace 比较,唯一活据 = 心跳(mtime)。
    if (holder.kind === 'v2' && holder.host !== mine.host) {
      const age = lockAgeMs(lockPath)
      if (age > staleMs) {
        return takeover(`锁持有者主机 ${holder.host} 心跳已停更 ${Math.round(age / 1000)}s(> ${staleMs / 1000}s),判定已死亡,接管陈旧锁`)
      }
      return {
        ok: false,
        host: holder.host,
        pid: holder.pid,
        error: `锁持有者主机 ${holder.host}(pid ${holder.pid})心跳新鲜(${Math.round(age / 1000)}s 前),疑似仍在运行(滚动更新 surge 双活窗口?)。本服务依赖单进程单库(SQLite + 内存会话/限流),双进程同库会静默脑裂。请确认旧实例已终止,或换 ALIANG_DB 指向独立数据目录。`,
      }
    }
    // 同主机判定:pid===自己(与格式/host 无关 —— pid namespace 私有,本 ns 的 1 只可能是自己;
    // K8s 容器原地重启不换 pod → hostname 跨世代不变、pid 恒 1,v2 锁同样命中此形态)必为
    // 「上一代容器残留」或「本进程二次接线」,pid 活性不可判(查到自己恒真),一律走 mtime 心跳;
    // 同 host 且 pid 不同号 = 同容器真双启动,走 pid 活性。
    const generationSelf = holder.pid === process.pid
    if (holder.host === mine.host || generationSelf) {
      if (!generationSelf && isPidAlive(holder.pid)) {
        return {
          ok: false,
          pid: holder.pid,
          error: `检测到另一个网关进程(pid ${holder.pid})正持有 ${lockPath}。本服务依赖单进程单库(SQLite + 内存会话/限流),双进程同库会静默脑裂。请先停掉旧进程,或换 ALIANG_DB 指向独立数据目录。`,
        }
      }
      if (generationSelf) {
        const age = lockAgeMs(lockPath)
        if (age <= staleMs) {
          return {
            ok: false,
            pid: holder.pid,
            error: `锁文件为上一代容器残留(pid ${holder.pid} 与本进程同号,pid namespace 不可比),mtime 距今 ${Math.round(age / 1000)}s ≤ ${staleMs / 1000}s 心跳窗,保守拒绝。CrashLoop 下一轮重试即可接管;紧急处理可手动删除 ${lockPath}。`,
          }
        }
        return takeover(`锁文件为上一代容器残留(pid ${holder.pid} 与本进程同号),mtime 已停更 ${Math.round(lockAgeMs(lockPath) / 1000)}s,判定持锁容器已死亡,接管陈旧锁`)
      }
      return takeover(`同主机持锁进程(pid ${holder.pid})已不存在,接管陈旧锁`)
    }
    // v1 旧格式且 pid 活且非自己 = 同机活进程 → 拒绝(v1 原语义;pid 已死在上方 isPidAlive 分支接管)
    if (holder.kind === 'v1' && isPidAlive(holder.pid)) {
      return {
        ok: false,
        pid: holder.pid,
        error: `检测到另一个网关进程(pid ${holder.pid})正持有 ${lockPath}。本服务依赖单进程单库(SQLite + 内存会话/限流),双进程同库会静默脑裂。请先停掉旧进程,或换 ALIANG_DB 指向独立数据目录。`,
      }
    }
    return takeover(`持锁进程(pid ${holder.pid})已不存在,接管陈旧锁`)
  }

  function takeover(reason) {
    writeHolder()
    console.error(`[startup] 单进程锁:${reason}`)
    return makeHeld()
  }
  function writeHolder() {
    writeFileSync(lockPath, JSON.stringify({ ...mine, t: Date.now() }), { flag: 'w' }) // 覆写接管
  }
  function makeHeld() {
    let released = false
    return {
      ok: true,
      // 心跳:刷新锁文件 mtime。server 侧每 10s 调一次;跨容器世代的接管方以 mtime 新鲜度判活。
      // 属主核对:失权进程(锁已被他人接管/覆写)的心跳不得把他人锁「洗新」。
      touch() {
        if (released) return
        try {
          const h = readHolder(lockPath)
          const own = h && ((h.kind === 'v2' && h.host === mine.host && h.pid === mine.pid) || (h.kind === 'v1' && h.pid === mine.pid))
          if (!own) return
          const now = new Date(); utimesSync(lockPath, now, now)
        } catch { /* 锁被接管/已清:下轮心跳或接管流程收束 */ }
      },
      release() {
        if (released) return
        released = true
        try {
          const h = readHolder(lockPath)
          const own = h && ((h.kind === 'v2' && h.host === mine.host && h.pid === mine.pid) || (h.kind === 'v1' && h.pid === mine.pid))
          if (own) unlinkSync(lockPath)
        } catch { /* 已被清/被接管,幂等 */ }
      },
    }
  }
  writeHolder()
  return makeHeld()
}
