import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { createWindowZAllocator } from '@/styles/zScale'

// SSH 终端浮窗(工作台内)。sid 按 serverId 稳定存 localStorage——刷新后重开同 sid,
// 网关在保活窗口内回放续跑(spec §6「刷新不掉线」)。
// sid 生成三级降级:randomUUID 仅安全上下文可用(HTTPS/localhost),局域网 HTTP 下是
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

export const useSshTerminalStore = defineStore('sshTerminals', () => {
  const windows = ref([])   // [{ id(=sid), serverId, name, status:'open'|'minimized', zIndex }]
  const zAlloc = createWindowZAllocator()
  const takeZ = () => zAlloc.nextZ(windows.value.filter(w => w.status === 'open'))
  const sidKey = serverId => `aliangboard.ssh.sid.${serverId}`
  function sidFor(serverId) {
    let sid = localStorage.getItem(sidKey(serverId))
    if (!sid) { sid = genSid(); localStorage.setItem(sidKey(serverId), sid) }
    return sid
  }
  // 同一服务器只开一个浮窗:再次打开 = 置顶恢复
  function openTerminal(server) {
    const existing = windows.value.find(w => w.serverId === server.id)
    if (existing) { existing.status = 'open'; existing.zIndex = takeZ(); return existing }
    const w = { id: sidFor(server.id), serverId: server.id, name: server.name, status: 'open', zIndex: takeZ() }
    windows.value.push(w)
    return w
  }
  const closeWindow = id => { windows.value = windows.value.filter(w => w.id !== id) }
  const minimizeWindow = id => { const w = windows.value.find(w => w.id === id); if (w) w.status = 'minimized' }
  const restoreWindow = id => { const w = windows.value.find(w => w.id === id); if (w) { w.status = 'open'; w.zIndex = takeZ() } }
  const focusWindow = id => { const w = windows.value.find(w => w.id === id); if (w) w.zIndex = takeZ() }
  const openWindows = computed(() => windows.value.filter(w => w.status === 'open').sort((a, b) => a.zIndex - b.zIndex))
  return { windows, openWindows, openTerminal, closeWindow, minimizeWindow, restoreWindow, focusWindow }
})
