import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { createWindowZAllocator } from '@/styles/zScale'

// SSH 终端浮窗(工作台内)。sid 按 serverId 稳定存 localStorage——刷新后重开同 sid,
// 网关在保活窗口内回放续跑(spec §6「刷新不掉线」)。
export const useSshTerminalStore = defineStore('sshTerminals', () => {
  const windows = ref([])   // [{ id(=sid), serverId, name, status:'open'|'minimized', zIndex }]
  const zAlloc = createWindowZAllocator()
  const takeZ = () => zAlloc.nextZ(windows.value.filter(w => w.status === 'open'))
  const sidKey = serverId => `aliangboard.ssh.sid.${serverId}`
  function sidFor(serverId) {
    let sid = localStorage.getItem(sidKey(serverId))
    if (!sid) { sid = `ssh-${crypto.randomUUID()}`; localStorage.setItem(sidKey(serverId), sid) }
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
