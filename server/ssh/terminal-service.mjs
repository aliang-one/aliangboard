// 终端生命周期唯一状态机(2026-09-05 方案 P1,spec §2):七操作独占写,全部幂等。
// 其余入口禁止裸 Map.delete/channel.close —— terminal-guard.test.mjs 静态守卫钉住
// (sweep 的残尸驱逐是 service 内唯一合法 map.delete,2026-09-05 审计#2)。
import { shouldReapSession } from './reap-policy.mjs'

// 环形缓冲(自 terminal-sessions.mjs 移入,2026-09-05 方案 P1 Task6):原始字节块+字节上限。
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
      if (total > maxBytes) {
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
    if (to === 'CLOSED' || to === 'LOST') {
      // 首次进入终态的时间(sweep 残尸驱逐锚点);clock=0 是合法时刻,须用 null 判而非真值判
      if (t.endedAt == null) t.endedAt = now()
      releaseBackend(t)
    }
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
      createdAt: now(), lastActiveAt: now(), lastOutputAt: 0,
      detachedSince: null, backendIdleSince: null, endedAt: null,
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
  // 池句柄挂到终端(2026-09-05 审计#1):LOST/CLOSED 时 releaseBackend 统一归还;
  // handler 创建分支在 isOwner 时调用(此前调用了一个不存在的方法,SSH 终端全死)。
  function bindRelease(tid, release) { const t = map.get(tid); if (t) t.release = release }

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
  function markOutput(tid, chunk) { const t = map.get(tid); if (t) { t.ring.push(chunk); t.lastOutputAt = now() } }
  function broadcast(tid, type, payload, send = (socket, ty, pl) => socket.send?.(ty, pl)) {
    const t = map.get(tid); if (!t) return
    for (const a of t.connIds.values()) { try { send(a.socket, type, payload) } catch { /* noop */ } }
  }
  function attachments(tid) { return [...(map.get(tid)?.connIds || []).values()] }

  // 二段式回收 + 残留治理(注入时钟,毫秒级可测):
  //   阶段〇  maxLifetimeMin(2026-09-05 审计#3 接回,v1.0.24 语义):任何活态超龄 → CAS → CLOSED
  //   阶段〇' attachedIdleMin(同上接回):ATTACHED 且完全静默(输出≠活动续命,口径同
  //          shouldReapSession 非对称时钟)→ CAS → CLOSED。决策复用 shouldReapSession 单源。
  //   阶段一  DETACHED 超时 → DETACHED_TIMEOUT(tmux 保留)
  //   阶段二  DETACHED_TIMEOUT 超时 → claimClose(CAS)→ CLOSED(transition 内 releaseBackend)
  //   驱逐    CLOSED/LOST 超 closedTombstoneMin(默认 30,幂等/对账观测窗)→ map.delete
  //          (service 内唯一合法删除点;静态守卫禁外部删)——审计#2:此前残尸永不出 map,
  //          list() 恒返 → 任务栏 ghost chip kill 无效、30s 复活、内存无界。
  const CLOSED_TOMBSTONE_MIN = 30
  function sweep(policy = {}, nowTs = now()) {
    const s1 = (policy.detachedIdleMin || 0) * 60000
    const s2 = (policy.backendIdleMin || 0) * 60000
    const tombstone = ((policy.closedTombstoneMin ?? CLOSED_TOMBSTONE_MIN) || 0) * 60000
    const events = []
    for (const t of map.values()) {
      // 终态残尸驱逐(先行:终态不做任何回收判定)
      if (t.status === 'CLOSED' || t.status === 'LOST') {
        if (tombstone > 0 && t.endedAt != null && nowTs - t.endedAt > tombstone) map.delete(t.id)
        continue
      }
      // 阶段〇/〇':复用 shouldReapSession(最长寿命 + 挂机回收;detached-idle 判定由下方
      // 两阶段接管,此处忽略其 detached 分支)。shouldReapSession 只产 max-lifetime 与
      // attached-idle 两类可执行判定(browserCount>0 时)。
      const verdict = shouldReapSession(
        { createdAt: t.createdAt, browserCount: t.connIds.size, lastActiveAt: t.lastActiveAt, lastOutputAt: t.lastOutputAt },
        policy, nowTs)
      if (verdict.reap && (verdict.reason === 'max-lifetime' || (verdict.reason === 'attached-idle' && t.status === 'ATTACHED'))) {
        t.closing = true                                   // CAS:与 close/claimClose 同一把认领闸
        transition(t, 'CLOSED', `reaped-${verdict.reason}`)
        events.push({ tid: t.id, action: `reaped-${verdict.reason}` })
        continue
      }
      if (t.status === 'DETACHED' && s1 > 0 && nowTs - (t.detachedSince ?? nowTs) > s1) {
        transition(t, 'DETACHED_TIMEOUT', 'reaped-detached-idle')
        events.push({ tid: t.id, action: 'timeout-stage1' })
      } else if (t.status === 'DETACHED_TIMEOUT' && s2 > 0 && nowTs - (t.backendIdleSince ?? nowTs) > s2) {
        if (claimClose(t.id)) {
          transition(t, 'CLOSED', 'reaped-backend-idle')
          events.push({ tid: t.id, action: 'timeout-stage2' })
        }
      }
    }
    return events
  }

  // boot 对账(listen 之前跑,单进程无并发写者):存活的 ATTACHED/DETACHED* → DETACHED,
  // 两段锚点=bootAt(不探测不建连,尊重 lazy;last_active_at 保留,阶段二锚点不被顺延);
  // CREATING → LOST('gateway-restart')。
  function reconcileOnBoot(bootAt) {
    let reattached = 0, lost = 0
    for (const t of map.values()) {
      if (t.status === 'CREATING') { t.lastError = 'gateway-restart'; transition(t, 'LOST', 'gateway-restart'); lost++; continue }
      if (t.status === 'ATTACHED' || t.status === 'DETACHED' || t.status === 'DETACHED_TIMEOUT') {
        t.status = 'DETACHED'
        t.detachedSince = bootAt
        t.backendIdleSince = bootAt
        t.statusVersion = (t.statusVersion || 0) + 1
        reattached++
      }
    }
    return { reattached, lost }
  }

  function markLost(tid, reason) {
    const t = map.get(tid); if (!t) return
    t.lastError = String(reason || '')
    transition(t, 'LOST', reason)     // transition 内部对 LOST 走 releaseBackend
  }

  // 后端建立失败(shell 起不来等):LOST + releaseBackend + 等待者全部收到 {ok:false, LOST}
  function markBackendFailed(tid, err) {
    const t = map.get(tid); if (!t) return
    t.lastError = String(err?.message || err)
    transition(t, 'LOST', 'backend-failed')
    t.rejectReady?.(err)
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

  // 观测端点/任务栏对账数据源(保持旧 registry.list 字段形状:sid/serverId/userId/browserCount/idleMs + status)
  function list() {
    return [...map.values()].map(t => ({
      sid: t.id, serverId: t.serverId, userId: t.owner, status: t.status,
      browserCount: t.connIds.size, idleMs: Math.max(0, now() - t.lastActiveAt),
      createdAt: t.createdAt, backend: t.backend, lastError: t.lastError,
    }))
  }
  function listByServer(serverId) { return list().filter(r => r.serverId === serverId) }
  function killSession(tid, reason = 'manual-kill') {
    const r = close(tid, { force: true, reason })
    return r.ok ? { ok: true } : null
  }

  return { map, newTerminal, getOrCreate, get, readyForOwner, bindChannel, bindRelease, attach, detach, abandon, markLost, markBackendFailed, claimClose, close, closeByServer, touch, markOutput, broadcast, attachments, sweep, reconcileOnBoot, list, listByServer, killSession }
}
