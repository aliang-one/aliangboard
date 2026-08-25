import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { terminalApi, getSessionToken } from '@/api/client'
import { createWindowZAllocator } from '@/styles/zScale'

// 终端会话管理：多终端、重命名、最小化到任务栏、持久化（刷新不丢）。
// 每个终端 = 一个 {id, name, pod, container, command} 元数据 + 运行时的 InteractiveTerminal 组件实例。
// WebSocket exec 在终端 "open" 时活跃；最小化保持连接（后台继续）；关闭断开；刷新后从任务栏恢复（新 exec）。
export const useTerminalStore = defineStore('terminals', () => {
  const terminals = ref([])  // [{id, name, namespace, podName, container, command, status, zIndex, createdAt}]
  // status: 'open'(浮动窗口) | 'minimized'(任务栏) | 'external'(在新浏览器标签页打开)
  // 终端窗口恒在窗口带内(Z.windowBase..Z.windowMax,模态框 Z.modal 之下);
  // 越界自动 renumber 回带内——见 zScale。
  const zAlloc = createWindowZAllocator()
  const takeZ = () => zAlloc.nextZ(terminals.value.filter(t => t.status === 'open'))
  const popupWins = new Map()  // id → window 引用（用于 focus / 检测关闭）
  let pollTimer = null

  // 轮询检测弹窗是否被用户关闭
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      for (const [id, win] of popupWins.entries()) {
        if (win.closed) {
          popupWins.delete(id)
          const t = terminals.value.find(t => t.id === id)
          if (t && t.status === 'external') { t.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
        }
      }
      if (!popupWins.size) { clearInterval(pollTimer); pollTimer = null }
    }, 2000)
  }

  // 持久化到服务端
  async function persistCreate(term) { try { await terminalApi.create(term) } catch { /* 离线静默 */ } }
  async function persistUpdate(id, patch) { try { await terminalApi.update(id, patch) } catch { /* noop */ } }
  async function persistDelete(id) { try { await terminalApi.remove(id) } catch { /* noop */ } }

  // 启动时从服务端加载（刷新恢复）
  async function loadPersisted() {
    try {
      const res = await terminalApi.list()
      const loaded = (res?.terminals || []).map(t => ({ ...t, status: 'minimized', zIndex: 0 })) // 刷新后全最小化
      terminals.value = loaded
      // 注:旧代码这里把 nextZ 跳到 100+N,刷新后浮窗越到 modal 层之上,已改由 allocator 保证带内
    } catch { /* 离线模式静默 */ }
  }

  // 创建（从任意 Pod 打开终端）。若同一 Pod+container 已有终端 → 聚焦它
  function openTerminal({ namespace, podName, container, command, name }) {
    const existing = terminals.value.find(t =>
      t.namespace === namespace && t.podName === podName && (t.container || '') === (container || ''))
    if (existing) {
      existing.status = 'open'
      existing.zIndex = takeZ()
      persistUpdate(existing.id, { status: 'open' })
      return existing
    }
    const term = {
      id: `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name || `${podName}/${container || 'main'}`,
      namespace, podName,
      container: container || '',
      command: command || 'sh',
      status: 'open',
      zIndex: takeZ(),
      createdAt: Date.now(),
    }
    terminals.value.push(term)
    persistCreate(term)
    return term
  }

  // 关闭
  function closeTerminal(id) {
    const idx = terminals.value.findIndex(t => t.id === id)
    if (idx !== -1) {
      terminals.value.splice(idx, 1)
      persistDelete(id)
    }
  }

  // 最小化
  function minimizeTerminal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (t) { t.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
  }

  // 恢复
  function restoreTerminal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (t) { t.status = 'open'; t.zIndex = takeZ(); persistUpdate(id, { status: 'open' }) }
  }

  // 重命名
  function renameTerminal(id, name) {
    const t = terminals.value.find(t => t.id === id)
    if (t) { t.name = name; persistUpdate(id, { name }) }
  }

  // 聚焦（置顶）
  function focusTerminal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (t) t.zIndex = takeZ()
  }

  // 在新浏览器标签页打开：关闭浮动窗口 + 标记 external + 打开独立路由页
  function openExternal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (!t) return
    t.status = 'external'
    persistUpdate(id, { status: 'external' })
    const params = new URLSearchParams({ ns: t.namespace, pod: t.podName, container: t.container, name: t.name, token: getSessionToken() })
    const url = `${window.location.origin}/terminal-popup?${params}`
    const win = window.open(url, '_blank')
    if (win) { popupWins.set(id, win); startPolling() }
  }

  // 聚焦已打开的外部弹窗（任务栏点击 external 项时）
  function focusExternal(id) {
    const win = popupWins.get(id)
    if (win && !win.closed) { win.focus(); return true }
    // 弹窗已关闭 → 恢复为最小化，可重新打开
    popupWins.delete(id)
    const t = terminals.value.find(t => t.id === id)
    if (t) { t.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
    return false
  }

  const openTerminals = computed(() => terminals.value.filter(t => t.status === 'open').sort((a, b) => a.zIndex - b.zIndex))
  const minimizedTerminals = computed(() => terminals.value.filter(t => t.status === 'minimized'))
  // 所有需要保持 DOM 挂载的终端（open + minimized，不含 external——external 在独立浏览器标签页）
  const allTerminals = computed(() => terminals.value.filter(t => t.status !== 'external'))

  return {
    terminals, openTerminals, minimizedTerminals, allTerminals,
    loadPersisted, openTerminal, closeTerminal, minimizeTerminal, restoreTerminal, renameTerminal, focusTerminal, openExternal, focusExternal,
  }
})
