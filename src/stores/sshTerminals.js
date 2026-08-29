import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { createWindowZAllocator } from '@/styles/zScale'

// SSH 终端浮窗(全局宿主 AppLayout,2026-08-29 任务栏化改造):
// - 多开:同服务器可开多个终端,每窗独立 sid(网关侧同一条池化连接多路 shell 通道)。
//   打开语义分两个入口:openOrFocus=服务器行按钮(无窗开新/有窗聚焦,防误触);
//   openNew=任务栏分组 chip 的「+」(总是新开)。
// - 刷新恢复:窗口元数据持久化 localStorage,启动时全部恢复为最小化(与 pod 终端
//   loadPersisted 同款体验);点任务栏恢复 → 同 sid 重连 → 网关保活窗口内回放续跑。
const LS_KEY = 'aliangboard.ssh.windows'

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

  function addWindow(server) {
    const w = { id: genSid(), serverId: server.id, name: server.name, status: 'open', zIndex: takeZ() }
    windows.value.push(w)
    persist()
    return w
  }

  // 服务器行按钮:无窗开新;有窗聚焦置顶(不多开,防误触)
  function openOrFocus(server) {
    const existing = windows.value.find(w => w.serverId === server.id)
    if (existing) { focusWindow(existing.id); return existing }
    return addWindow(server)
  }
  // 任务栏分组「+」:总是新开一个终端
  const openNew = server => addWindow(server)

  const closeWindow = id => { windows.value = windows.value.filter(w => w.id !== id); persist() }

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
  function openExternal(id) {
    const w = windows.value.find(x => x.id === id)
    if (!w) return
    w.status = 'external'
    persist()
    const params = new URLSearchParams({ serverId: w.serverId, sid: w.id, name: w.name })
    const win = window.open(`${window.location.origin}/ssh-terminal-popup?${params}`, '_blank')
    if (win) { popupWins.set(id, win); startPolling() }
  }
  function focusExternal(id) {
    const win = popupWins.get(id)
    if (win && !win.closed) { win.focus(); return true }
    popupWins.delete(id)
    const w = windows.value.find(x => x.id === id)
    if (w) { w.status = 'minimized'; persist() }
    return false
  }
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

  return { windows, openWindows, attachedWindows, groups, openOrFocus, openNew, openExternal, focusExternal, closeWindow, minimizeWindow, restoreWindow, focusWindow }
})
