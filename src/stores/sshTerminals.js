import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { createWindowZAllocator } from '@/styles/zScale'
import { sshApi } from '@/api/client'
import { onPopupSync, GONE_GRACE_MS } from '@/utils/popupSync'

// SSH 终端浮窗(全局宿主 AppLayout,2026-08-29 任务栏化改造;2026-09-01 弹窗状态对账):
// - 多开:同服务器可开多个终端,每窗独立 sid(网关侧同一条池化连接多路 shell 通道)。
//   打开语义分两个入口:openOrFocus=服务器行按钮(无窗开新/有窗聚焦,防误触);
//   openNew=任务栏分组 chip 的「+」(总是新开)。
// - 刷新恢复:窗口元数据持久化 localStorage,启动时全部恢复为最小化(与 pod 终端
//   loadPersisted 同款体验);点任务栏恢复 → 同 sid 重连 → 网关保活窗口内回放续跑。
// - 弹窗生死对账:弹窗页以 popupSync 信标/墓碑广播(见 popupSync.js),不再纯靠 opener
//   内存引用。杀会话收敛为「显式关闭按钮」专属(2026-09-04 关闭语义收敛):浮窗×/任务栏×/
//   会话菜单×/全部关闭/弹窗页「关闭窗口」钮;其余生命周期(F5/墓碑收尾/最小化/标签页丢弃)
//   一律不杀——未附着会话由网关 detachedIdle(默认 10min)兜底回收,多开场景不再被别处的
//   刷新/关窗误杀。
const LS_KEY = 'aliangboard.ssh.windows'

// 最近本地关闭的会话(任务栏 reconcile 降噪):两类来源——①显式关闭按钮(会话已被 kill,
// 掩护 kill 与网关 /api/ssh/sessions 快照之间的竞态/失败窗口);②墓碑收尾(会话按新语义
// 继续活着到网关 reap,窗口须盖过 detachedIdle 默认 10min + 60s sweep,否则「明明关了
// 还标红」)。管理员调大 detachedIdleMin 时,超窗后仍会如实标红(会话确实还活着)。
const RECENT_CLOSED_MS = 12 * 60 * 1000
const recentlyClosed = new Map()   // sid → closedAt
function markRecentlyClosed(sid) {
  const nowTs = Date.now()
  recentlyClosed.set(sid, nowTs)
  for (const [k, at] of recentlyClosed) if (nowTs - at > RECENT_CLOSED_MS) recentlyClosed.delete(k)
}
function isRecentlyClosed(sid) {
  const at = recentlyClosed.get(sid)
  if (!at) return false
  if (Date.now() - at > RECENT_CLOSED_MS) { recentlyClosed.delete(sid); return false }
  return true
}
// best-effort:网关会话随手收(404=清道夫已收走,照样静默;离线/403 同样不炸)
function killSessionBestEffort(sid) { Promise.resolve().then(() => sshApi.killSession(sid)).catch(() => {}) }

// 弹窗↔opener 对账分发(模块级,同文件头 storageSyncTargets 模式)
const popupSyncTargets = new Set()
onPopupSync(sig => { for (const fn of popupSyncTargets) fn(sig) })

// sid 三级降级:randomUUID 仅安全上下文(HTTPS/localhost),局域网 HTTP 下是
// undefined(2026-08-28 真机事故)→ getRandomValues 拼 UUID → 时间戳兜底。
function genSid() {
  const c = globalThis.crypto
  if (c?.randomUUID) return `ssh-${c.randomUUID()}`
  if (c?.getRandomValues) {
    const b = new Uint8Array(16)
    c.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `ssh-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function loadPersisted() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
    return (Array.isArray(arr) ? arr : [])
      .filter(r => r && r.id && r.serverId)
      .map(r => ({ id: r.id, serverId: r.serverId, name: r.name || r.serverId, status: 'minimized', zIndex: 0 }))
  } catch { return [] }
}

// 跨标签页同步(2026-08-29 泄漏审计):storage 事件只在「其他」标签页触发。此前两个 app
// 标签页各持一份内存登记表互相失明——A 页开的会话在 B 页任务栏不可见也不可关。现借
// storage 事件对账:他页新增的窗口以最小化收编、他页已关的窗口摘除;本页 status/zIndex
// 恒不被覆盖(他页只持久化元数据)。模块级监听 + 活跃 store 注册,免随 pinia 重建反复挂监听。
const storageSyncTargets = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key && e.key !== LS_KEY) return   // key=null 即 clear(),也同步
    for (const fn of storageSyncTargets) fn()
  })
}

export const useSshTerminalStore = defineStore('sshTerminals', () => {
  const windows = ref(loadPersisted())   // [{ id(=sid), serverId, name, status:'open'|'minimized', zIndex }]
  const zAlloc = createWindowZAllocator()
  const takeZ = () => zAlloc.nextZ(windows.value.filter(w => w.status === 'open'))

  // 元数据(不含 status/zIndex——刷新后恒最小化)同步落盘:每个变更入口显式调用
  // (watch 默认异步 flush,时序不可控;显式调用让「关窗后立刻刷新」也不丢)
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(windows.value.map(({ id, serverId, name }) => ({ id, serverId, name }))))
    } catch { /* 隐私模式等存储不可用:降级为会话内有效 */ }
  }

  // storage 事件对账(见文件头 storageSyncTargets 注释):以 localStorage 为准重建,
  // 已知 id 仅跟随元数据(status/zIndex 留本地),不在表中的 id(他页已关)自然摘除。
  function syncFromStorage() {
    const byId = new Map(windows.value.map(w => [w.id, w]))
    windows.value = loadPersisted().map(r => {
      const cur = byId.get(r.id)
      byId.delete(r.id)
      return cur ? { ...cur, serverId: r.serverId, name: r.name } : r
    })
  }
  storageSyncTargets.add(syncFromStorage)

  function addWindow(server) {
    const w = { id: genSid(), serverId: server.id, name: server.name, status: 'open', zIndex: takeZ() }
    windows.value.push(w)
    persist()
    return w
  }

  // 服务器行按钮:无窗开新;有窗聚焦置顶(不多开,防误触)。external → 聚焦弹窗标签页,
  // 绝不在本页复活浮窗(同 sid 双消费)。
  function openOrFocus(server) {
    const existing = windows.value.find(w => w.serverId === server.id)
    if (existing) {
      if (existing.status === 'external') focusExternal(existing.id)
      else focusWindow(existing.id)
      return existing
    }
    return addWindow(server)
  }
  // 任务栏分组「+」:总是新开一个终端
  const openNew = server => addWindow(server)

  // 显式关闭 = 本地记录 + 网关会话一起收;recentlyClosed 供任务栏 reconcile 降噪
  const closeWindow = id => {
    windows.value = windows.value.filter(w => w.id !== id)
    persist()
    markRecentlyClosed(id)
    killSessionBestEffort(id)
  }

  // —— 新标签页打开(pod terminals.openExternal 同款)——
  // external 状态:浮动宿主(AppLayout)不再挂载该窗(其 WS 随组件卸载而断),
  // 弹窗标签页用同一 sid 自建 WS → 网关保活会话回放续跑;弹窗关闭 → 回任务栏最小化。
  const popupWins = new Map()
  let pollTimer = null
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      for (const [id, win] of popupWins.entries()) {
        if (win.closed) {
          popupWins.delete(id)
          const w = windows.value.find(x => x.id === id)
          if (w && w.status === 'external') w.status = 'minimized'
        }
      }
      if (!popupWins.size) { clearInterval(pollTimer); pollTimer = null }
    }, 2000)
  }
  const popupUrl = w => {
    const params = new URLSearchParams({ serverId: w.serverId, sid: w.id, name: w.name })
    return `${window.location.origin}/ssh-terminal-popup?${params}`
  }
  // 窗口名 = sid(确定性):再点由浏览器复用/聚焦同一标签页,不再 _blank 多开
  function openExternal(id) {
    const w = windows.value.find(x => x.id === id)
    if (!w) return
    const known = popupWins.get(id)
    if (known && !known.closed) { known.focus(); return }   // 幂等:已开着只聚焦
    popupWins.delete(id)
    w.status = 'external'
    persist()
    const win = window.open(popupUrl(w), w.id)
    if (win) { popupWins.set(id, win); startPolling() }
  }
  // 有内存引用直接 focus;没有(opener 刷新过/曾被拦截)按确定性窗口名重开——标签页活着 →
  // 浏览器复用聚焦;真关了 → 同 sid 重开,网关回放续跑。仅 window.open 被拦截时降级最小化。
  function focusExternal(id) {
    const w = windows.value.find(x => x.id === id)
    if (!w) return false
    const known = popupWins.get(id)
    if (known && !known.closed) {
      known.focus()
      if (w.status !== 'external') { w.status = 'external'; persist() }
      return true
    }
    popupWins.delete(id)
    const win = window.open(popupUrl(w), w.id)
    if (!win) { w.status = 'minimized'; persist(); return false }
    popupWins.set(id, win)
    startPolling()
    if (w.status !== 'external') { w.status = 'external'; persist() }
    return true
  }

  // —— 弹窗生死对账(popupSync 信标/墓碑)——
  const pendingGone = new Map()  // sid → 收尾定时器(墓碑宽限期,给 F5 留复活窗口)
  function onPopupSignal({ type, kind, sid, meta }) {
    if (kind !== 'ssh') return   // kind 分发(2026-09-04):本 store 只认 ssh 弹窗,不信 id 前缀巧合
    if (type === 'alive') {
      const timer = pendingGone.get(sid)
      if (timer) { clearTimeout(timer); pendingGone.delete(sid) }   // F5 复活 → 取消收尾
      let w = windows.value.find(x => x.id === sid)
      if (!w && meta?.serverId) {   // opener 错过创建窗口期:按信标元数据重建,不失明
        w = { id: sid, serverId: meta.serverId, name: meta.name || meta.serverId, status: 'external', zIndex: 0 }
        windows.value.push(w)
        persist()
        return
      }
      if (w && w.status === 'minimized') { w.status = 'external'; persist() }   // 刷新恢复压成的最小化复位
      return
    }
    // 墓碑:弹窗标签页没了 → 即刻最小化(chip 变灰),宽限期后仅摘本地记录。
    // 不杀会话(2026-09-04 收敛):pagehide ≠ 关闭意图(F5/标签页丢弃也发墓碑),杀会话是
    // 弹窗页「关闭窗口」按钮专属;会话未附着后由网关 detachedIdle 兜底回收。
    popupWins.delete(sid)
    const w = windows.value.find(x => x.id === sid)
    if (w && w.status === 'external') w.status = 'minimized'
    const prev = pendingGone.get(sid)
    if (prev) clearTimeout(prev)
    pendingGone.set(sid, setTimeout(() => {
      pendingGone.delete(sid)
      const before = windows.value.length
      windows.value = windows.value.filter(x => x.id !== sid)
      if (windows.value.length !== before) {
        persist()
        markRecentlyClosed(sid)
      }
    }, GONE_GRACE_MS))
  }
  popupSyncTargets.add(onPopupSignal)
  const minimizeWindow = id => { const w = windows.value.find(w => w.id === id); if (w) w.status = 'minimized' }
  const restoreWindow = id => { const w = windows.value.find(w => w.id === id); if (w) { w.status = 'open'; w.zIndex = takeZ() } }
  function focusWindow(id) { const w = windows.value.find(w => w.id === id); if (w) w.zIndex = takeZ() }

  const openWindows = computed(() => windows.value.filter(w => w.status === 'open').sort((a, b) => a.zIndex - b.zIndex))
  // 浮动宿主应挂载的窗(open + minimized;external 在独立标签页,不挂浮动组件——其 WS 随卸载断开)
  const attachedWindows = computed(() => windows.value.filter(w => w.status !== 'external'))
  // 任务栏分组数据源:同 serverId 聚合
  const groups = computed(() => {
    const map = new Map()
    for (const w of windows.value) {
      const g = map.get(w.serverId) || { serverId: w.serverId, name: w.name, windows: [] }
      g.windows.push(w)
      map.set(w.serverId, g)
    }
    return [...map.values()].map(g => ({ serverId: g.serverId, name: g.name, count: g.windows.length, windows: g.windows }))
  })

  return { windows, openWindows, attachedWindows, groups, openOrFocus, openNew, openExternal, focusExternal, closeWindow, minimizeWindow, restoreWindow, focusWindow, isRecentlyClosed }
})
