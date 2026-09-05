// 终端生命周期唯一状态机(2026-09-05 方案 P1,spec §2):七操作独占写,全部幂等。
// 其余入口禁止裸 Map.delete/channel.close —— terminal-guard.test.mjs 静态守卫钉住。
import { createRingBuffer } from './terminal-sessions.mjs'   // Task 6 移入本文件后改本文件

export const TERMINAL_TRANSITIONS = {
  CREATING: ['ATTACHED', 'LOST', 'CLOSED'],
  ATTACHED: ['DETACHED', 'LOST', 'CLOSED'],
  DETACHED: ['ATTACHED', 'DETACHED_TIMEOUT', 'LOST', 'CLOSED'],
  DETACHED_TIMEOUT: ['ATTACHED', 'CLOSING', 'LOST', 'CLOSED'],
  CLOSING: ['CLOSED', 'DETACHED_TIMEOUT'],
  LOST: ['CLOSED'],
  CLOSED: [],
}
export const canTransition = (from, to) => (TERMINAL_TRANSITIONS[from] || []).includes(to)

export function createTerminalService({
  now = Date.now,
  ringMaxBytes = 4 * 1024 * 1024,
  onTransition = () => {},
  onIrreversible = () => {},
} = {}) {
  const map = new Map()

  function transition(t, to, reason) {
    const from = t.status
    if (from === to) return true
    if (!canTransition(from, to)) return false
    t.status = to
    t.statusVersion = (t.statusVersion || 0) + 1
    if (to === 'DETACHED') t.detachedSince = now()
    if (to === 'DETACHED_TIMEOUT') t.backendIdleSince = now()
    if (to === 'ATTACHED') { t.detachedSince = null; t.backendIdleSince = null }
    if (to === 'CLOSED' || to === 'LOST') releaseBackend(t)
    onIrreversible({ tid: t.id, event: to, reason, from })
    onTransition(t.id, from, to, reason)
    return true
  }

  function releaseBackend(t) {
    try { t.channel?.close?.() } catch { /* noop */ }
    try { t.release?.() } catch { /* noop */ }
    for (const a of t.connIds.values()) { try { a.socket.close() } catch { /* noop */ } }
    for (const sk of t.waiterSockets) { try { sk.close() } catch { /* noop */ } }
    t.connIds.clear()
    t.waiterSockets.clear()
    t.primary = null
  }

  function newTerminal({ id, owner, serverId, backend = 'ephemeral', title = '' }) {
    const t = {
      id, owner, serverId, backend, title,
      status: 'CREATING', lastError: null, statusVersion: 0,
      connIds: new Map(), waiterSockets: new Set(), primary: null,
      channel: null, release: null, ring: createRingBuffer(ringMaxBytes),
      ready: null, resolveReady: null, rejectReady: null, waiters: 0,
      createdAt: now(), lastActiveAt: now(),
      detachedSince: null, backendIdleSince: null,
      lastAttachAt: 0, lastDetachAt: 0, attachCount: 0,
    }
    // ready 即刻存在:等待者 attach 可先于 owner 的 readyForOwner 到达,不允许 await undefined
    t.ready = new Promise((resolve, reject) => { t.resolveReady = resolve; t.rejectReady = reject })
    return t
  }

  function getOrCreate(tid, factory) {
    let t = map.get(tid)
    if (t) return { terminal: t, existing: true }
    t = factory()
    map.set(tid, t)
    onTransition(t.id, null, 'CREATING', 'create')
    return { terminal: t, existing: false }
  }

  function get(tid) { return map.get(tid) || null }

  // —— 创建单飞支撑:owner 持 ready 控制权,等待者经 attach 排队(复审二 P0 abandon/单飞)——
  function readyForOwner(tid) {
    const t = map.get(tid)
    if (!t) return { resolve() {}, reject() {} }
    return {
      resolve: () => t.resolveReady?.({ status: t.status }),
      reject: e => {
        // ready 失败 = 后端建立失败:transition 内部已对 LOST 走 releaseBackend(等待者全收 LOST)
        t.lastError = String(e?.message || e)
        transition(t, 'LOST', 'backend-failed')
        t.rejectReady?.(e)
      },
    }
  }
  function bindChannel(tid, channel) { const t = map.get(tid); if (t) t.channel = channel }

  function doAttach(t, connId, socket) {
    const prev = t.connIds.get(connId)
    if (prev && prev.socket !== socket) { try { prev.socket.close() } catch { /* noop */ } }   // 同 connId 接管
    const first = t.connIds.size === 0
    t.connIds.set(connId, { socket, attachedAt: now() })
    t.primary = socket
    t.lastAttachAt = now(); t.attachCount++; t.lastActiveAt = now()
    if (first || t.status === 'CREATING') transition(t, 'ATTACHED', 'attach')
  }

  async function attach(tid, connId, socket) {
    const t = map.get(tid)
    if (!t) return { ok: false, status: 'CLOSED', reason: 'unknown-terminal' }
    if (t.status === 'CLOSED' || t.status === 'LOST' || t.status === 'CLOSING')
      return { ok: false, status: t.status, reason: t.lastError || 'terminal-' + t.status }
    const prev = t.connIds.get(connId)
    if (prev && prev.socket !== socket) { try { prev.socket.close() } catch { /* noop */ } }
    if (t.status === 'CREATING') {
      t.waiters++
      t.waiterSockets.add(socket)     // 释放面:LOST/CLOSED 时等待中的 socket 一并关闭
      try {
        await t.ready
      } catch (e) {
        return { ok: false, status: 'LOST', reason: String(e?.message || e) }
      } finally {
        t.waiterSockets.delete(socket)
        t.waiters = Math.max(0, t.waiters - 1)
      }
      if (t.status === 'CLOSED' || t.status === 'LOST') return { ok: false, status: t.status, reason: t.lastError || '' }
    }
    doAttach(t, connId, socket)
    return { ok: true, status: t.status, reason: null }
  }

  function detach(tid, connId, reason = 'detach') {
    const t = map.get(tid); if (!t) return
    const a = t.connIds.get(connId)
    if (!a) return                                        // 未知 connId:no-op(幂等)
    t.connIds.delete(connId)
    if (t.primary === a.socket) t.primary = ([...t.connIds.values()][0] || {}).socket || null
    t.lastDetachAt = now()
    if (t.connIds.size === 0) transition(t, 'DETACHED', reason)
  }

  function touch(tid) { const t = map.get(tid); if (t) t.lastActiveAt = now() }
  function markOutput(tid, chunk) { const t = map.get(tid); if (t) t.ring.push(chunk) }
  function broadcast(tid, type, payload, send = (socket, ty, pl) => socket.send?.(ty, pl)) {
    const t = map.get(tid); if (!t) return
    for (const a of t.connIds.values()) { try { send(a.socket, type, payload) } catch { /* noop */ } }
  }
  function attachments(tid) { return [...(map.get(tid)?.connIds || []).values()] }

  function markLost(tid, reason) {
    const t = map.get(tid); if (!t) return
    t.lastError = String(reason || '')
    transition(t, 'LOST', reason)     // transition 内部对 LOST 走 releaseBackend
  }

  function abandon(tid, connId) {
    const t = map.get(tid); if (!t) return
    if (t.status !== 'CREATING') { detach(tid, connId, 'abandon'); return }
    if ((t.waiters || 0) > 0) return                 // 交棒:等待中的重连者接管,会话保留
    markLost(tid, 'create-abandoned')                // 无人等待:LOST + releaseBackend
  }

  function claimClose(tid) {
    const t = map.get(tid)
    if (!t || t.status !== 'DETACHED_TIMEOUT' || t.closing) return false
    t.closing = true
    transition(t, 'CLOSING', 'reaped-backend-idle')
    return true
  }

  function close(tid, { reason = 'explicit', force = false } = {}) {
    const t = map.get(tid); if (!t) return { ok: false, error: 'unknown-terminal' }
    if (t.status === 'CLOSED' || t.closing) return { ok: true }   // 幂等
    // 软护栏:有人附着/正在建连 且 60s 内活跃 → 拒绝(前端转二次确认);force 越过
    if (!force && (t.connIds.size > 0 || t.waiters > 0) && now() - t.lastActiveAt < 60_000)
      return { ok: false, error: 'terminal-active' }
    t.closing = true
    transition(t, 'CLOSED', reason)
    return { ok: true }
  }

  function closeByServer(serverId, reason = 'server-deleted') {
    for (const t of map.values()) {
      if (t.serverId !== serverId || t.status === 'CLOSED') continue
      t.closing = true
      transition(t, 'CLOSED', reason)
    }
  }

  return { map, newTerminal, getOrCreate, get, readyForOwner, bindChannel, attach, detach, abandon, markLost, claimClose, close, closeByServer, touch, markOutput, broadcast, attachments }
}
