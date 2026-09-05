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
    t.connIds.clear()
    t.primary = null
  }

  function newTerminal({ id, owner, serverId, backend = 'ephemeral', title = '' }) {
    return {
      id, owner, serverId, backend, title,
      status: 'CREATING', lastError: null, statusVersion: 0,
      connIds: new Map(), primary: null,
      channel: null, release: null, ring: createRingBuffer(ringMaxBytes),
      ready: null, resolveReady: null, rejectReady: null, waiters: 0,
      createdAt: now(), lastActiveAt: now(),
      detachedSince: null, backendIdleSince: null,
      lastAttachAt: 0, lastDetachAt: 0, attachCount: 0,
    }
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

  return { map, newTerminal, getOrCreate, get }
}
