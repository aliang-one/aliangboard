// SSH 终端网关侧保活(spec §6):浏览器 WS 断开 ≠ 会话死亡;输出持续进环形缓冲;
// 重连同 sid 先回放(snapshot)再接直播。无浏览器且空闲超阈才 reap(纯逻辑,时钟注入可测)。
export function createRingBuffer(maxLines = 4000) {
  const lines = []
  let tail = ''                       // 半行残段(跨 chunk)
  return {
    push(chunk) {
      // ring 按 utf8 行切分:跨 chunk 的多字节字符由 tail 拼接兜底;但二进制流回放可能有损(按行重 join)。
      // 仅影响 CH_REPLAY 快照;直播帧(CH_STDOUT)原样转发不受影响。
      const text = (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      const parts = (tail + text).split('\n')
      tail = parts.pop()
      for (const l of parts) { lines.push(l); if (lines.length > maxLines) lines.shift() }
    },
    snapshot() { const out = tail ? [...lines, tail] : [...lines]; return Buffer.from(out.join('\n'), 'utf8') },
    lineCount() { return lines.length },
  }
}

export function createTerminalRegistry({ idleReapMs = 600000, now = Date.now } = {}) {
  const map = new Map()   // sid → session { sid, serverId, userId, ring, browserCount, lastActiveAt, extra }
  function ensure(sid, meta, factory) {
    let s = map.get(sid)
    if (s) return s
    s = { sid, serverId: meta.serverId || '', userId: meta.userId || '', ring: createRingBuffer(), browserCount: 0, lastActiveAt: now(), extra: {} }
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
  function reapIdle(onReap) {
    for (const [sid, s] of map) {
      if (s.browserCount === 0 && now() - s.lastActiveAt > idleReapMs) { map.delete(sid); try { onReap?.(s) } catch {} }
    }
  }
  function close(sid, onReap) { const s = map.get(sid); if (!s) return null; map.delete(sid); try { onReap?.(s) } catch {}; return s }
  function closeByServer(serverId, onClose) {
    for (const [sid, sess] of [...map]) {
      if (sess.serverId === serverId) { map.delete(sid); try { onClose?.(sess) } catch { /* noop */ } }
    }
  }
  const count = () => map.size
  return { ensure, get, attach, detachBrowser, touch, reapIdle, close, closeByServer, count }
}
