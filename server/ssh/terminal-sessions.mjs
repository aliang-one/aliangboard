// SSH 终端网关侧保活(spec §6):浏览器 WS 断开 ≠ 会话死亡;输出持续进环形缓冲;
// 重连同 sid 先回放(snapshot)再接直播。无浏览器且空闲超阈才 reap(纯逻辑,时钟注入可测)。

// 环形缓冲(2026-09-04 重设计):原始字节块 + 字节上限。旧版按 utf8 行切分再重 join——
// TUI/二进制流(ANSI 定位、\r 进度条、无换行大流、超长单行)回放失真,且 tail 与单行长度
// 无界可打爆网关堆(审计 P1)。现按到达字节原样保存:超预算丢最老块、单块超预算保尾截断,
// 回放保真 + 内存有界。
export function createRingBuffer(maxBytes = 4 * 1024 * 1024) {
  const chunks = []
  let total = 0
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)   // string/Uint8Array → utf8
      if (!buf.length) return
      chunks.push(buf)
      total += buf.length
      while (total > maxBytes && chunks.length > 1) { total -= chunks[0].length; chunks.shift() }
      if (total > maxBytes) {                       // 单块即超预算:保尾截断,释放对大 buf 的引用
        const tail = Buffer.from(buf.subarray(buf.length - maxBytes))
        chunks.length = 0
        chunks.push(tail)
        total = tail.length
      }
    },
    snapshot() { return Buffer.concat(chunks) },
    byteLength() { return total },
  }
}

import { shouldReapSession } from './reap-policy.mjs'

export function createTerminalRegistry({ now = Date.now, ringMaxBytes } = {}) {
  const map = new Map()   // sid → session { sid, serverId, userId, ring, browserCount, lastActiveAt, createdAt, lastOutputAt, extra }
  function ensure(sid, meta, factory) {
    let s = map.get(sid)
    if (s) return s
    s = { sid, serverId: meta.serverId || '', userId: meta.userId || '', ring: createRingBuffer(ringMaxBytes), browserCount: 0, lastActiveAt: now(), createdAt: now(), lastOutputAt: 0, extra: {} }
    s.extra = factory(s) || {}
    map.set(sid, s)
    return s
  }
  const get = sid => map.get(sid) || null
  function attach(sid, userId = null) {
    const s = map.get(sid)
    if (!s) return null
    if (userId && s.userId && s.userId !== userId) return null   // sid 属主校验:不得附到他人 shell(2026-08-29 审计)
    s.browserCount++; s.lastActiveAt = now(); return s
  }
  function detachBrowser(sid) { const s = map.get(sid); if (s) s.browserCount = Math.max(0, s.browserCount - 1) }
  function touch(sid) { const s = map.get(sid); if (s) s.lastActiveAt = now() }
  function markOutput(sid) { const s = map.get(sid); if (s) s.lastOutputAt = now() }
  // 策略化回收(2026-08-29 spec):阈值来自每跳现读的全局策略,判定纯函数见 reap-policy.mjs
  function reapByPolicy(policy, onReap) {
    for (const [sid, s] of map) {
      const { reap, reason } = shouldReapSession(s, policy, now())
      if (reap) { map.delete(sid); try { onReap?.(s, reason) } catch {} }
    }
  }
  function close(sid, onReap) { const s = map.get(sid); if (!s) return null; map.delete(sid); try { onReap?.(s) } catch {}; return s }
  function closeByServer(serverId, onClose) {
    for (const [sid, sess] of [...map]) {
      if (sess.serverId === serverId) { map.delete(sid); try { onClose?.(sess) } catch { /* noop */ } }
    }
  }
  const count = () => map.size
  // 存活会话快照(观测端点/任务栏对账数据源):idleMs 由 now 与 lastActiveAt 现算,避免存派生值
  const list = () => [...map.values()].map(s => ({
    sid: s.sid, serverId: s.serverId, userId: s.userId,
    browserCount: s.browserCount, lastActiveAt: s.lastActiveAt,
    createdAt: s.createdAt, lastOutputAt: s.lastOutputAt,
    idleMs: Math.max(0, now() - s.lastActiveAt),
  }))
  return { ensure, get, attach, detachBrowser, touch, markOutput, reapByPolicy, close, closeByServer, count, list }
}
