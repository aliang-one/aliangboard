import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { terminalApi, getSessionToken } from '@/api/client'
import { createWindowZAllocator } from '@/styles/zScale'
import { onPopupSync, GONE_GRACE_MS } from '@/utils/popupSync'

// 弹窗↔opener 对账分发(2026-09-01):popupWins 是内存态,opener 一刷新即失明。
// 弹窗页以 popupSync 信标/墓碑广播生死(见 popupSync.js 头注),这里即时跟随。
const popupSyncTargets = new Set()
onPopupSync(sig => { for (const fn of popupSyncTargets) fn(sig) })

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
  const popupWins = new Map()  // id → window 引用（用于 focus / 检测关闭；opener 刷新即丢,对账不依赖它）
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

  // 启动时从服务端加载（刷新恢复）。网络差时页面加载常失败——旧实现静默放弃,任务栏空到
  // 下次手动刷新(2026-09-03「终端记录消失」排查)。有界重试 5×3s;期间用户已开新终端则停。
  let loadRetryTimer = null
  let loadRetries = 0
  const LOAD_RETRY_MAX = 5
  async function loadPersisted() {
    clearTimeout(loadRetryTimer)
    try {
      const res = await terminalApi.list()
      const loaded = (res?.terminals || []).map(t => ({ ...t, status: 'minimized', zIndex: 0 })) // 刷新后全最小化
      terminals.value = loaded
      loadRetries = 0
      // 注:旧代码这里把 nextZ 跳到 100+N,刷新后浮窗越到 modal 层之上,已改由 allocator 保证带内
    } catch {
      if (terminals.value.length === 0 && loadRetries < LOAD_RETRY_MAX) {
        loadRetries++
        loadRetryTimer = setTimeout(loadPersisted, 3000)
      }
    }
  }

  // 创建（从任意 Pod 打开终端）。若同一 Pod+container 已有终端 → 聚焦它
  function openTerminal({ namespace, podName, container, command, name }) {
    const existing = terminals.value.find(t =>
      t.namespace === namespace && t.podName === podName && (t.container || '') === (container || ''))
    if (existing) {
      // 已在新标签页打开:聚焦那个标签页,绝不在本页复活浮窗(同会话双消费)。
      // 聚焦被 popup blocker 拦截时降级本页恢复——点了必须有反应。
      if (existing.status === 'external') {
        if (!focusExternal(existing.id)) restoreTerminal(existing.id)
        return existing
      }
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

  // 弹窗页 URL(sid 必传:网关 planExec 以 sid 判持久性,tmux 会话名 = label(token)-sid,
  // 缺了降级一次性 exec;弹窗刷新同 URL → 同 sid → 回放续跑)
  function popupUrl(t) {
    const params = new URLSearchParams({ ns: t.namespace, pod: t.podName, container: t.container, name: t.name, sid: t.id, token: getSessionToken() })
    return `${window.location.origin}/terminal-popup?${params}`
  }

  // 在新浏览器标签页打开：关闭浮动窗口 + 标记 external + 打开独立路由页。
  // 窗口名 = terminal.id(确定性):同一终端再点由浏览器复用/聚焦同一标签页,不再 _blank 多开。
  function openExternal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (!t) return
    const known = popupWins.get(id)
    if (known && !known.closed) { known.focus(); return }   // 幂等:已开着只聚焦
    popupWins.delete(id)
    t.status = 'external'
    persistUpdate(id, { status: 'external' })
    const win = window.open(popupUrl(t), t.id)
    if (win) { popupWins.set(id, win); startPolling() }
  }

  // 聚焦已打开的外部弹窗（任务栏/重入路径）。有内存引用直接 focus;没有(opener 刷新过/
  // 曾被拦截)则按确定性窗口名重开——标签页活着 → 浏览器复用并聚焦;真关了 → 同 sid 重开,
  // 网关回放续跑。两种情况都不在本页开浮窗。仅 window.open 被拦截时降级最小化并返回 false。
  function focusExternal(id) {
    const t = terminals.value.find(t => t.id === id)
    if (!t) return false
    const known = popupWins.get(id)
    if (known && !known.closed) {
      known.focus()
      if (t.status !== 'external') { t.status = 'external'; persistUpdate(id, { status: 'external' }) }
      return true
    }
    popupWins.delete(id)
    const win = window.open(popupUrl(t), t.id)
    if (!win) { t.status = 'minimized'; persistUpdate(id, { status: 'minimized' }); return false }
    popupWins.set(id, win)
    startPolling()
    if (t.status !== 'external') { t.status = 'external'; persistUpdate(id, { status: 'external' }) }
    return true
  }

  // —— 弹窗生死对账(popupSync 信标/墓碑,模块级 popupSyncTargets 分发)——
  const pendingGone = new Map()  // sid → 收尾定时器(墓碑宽限期,给 F5 留复活窗口)
  function onPopupSignal({ type, sid, meta }) {
    if (type === 'alive') {
      const timer = pendingGone.get(sid)
      if (timer) { clearTimeout(timer); pendingGone.delete(sid) }   // F5 复活 → 取消收尾
      let t = terminals.value.find(x => x.id === sid)
      if (!t && meta?.namespace) {   // opener 错过创建窗口期:按信标元数据重建,不失明
        t = { id: sid, name: meta.name || `${meta.podName || 'pod'}/${meta.container || 'main'}`, namespace: meta.namespace, podName: meta.podName || '', container: meta.container || '', command: 'sh', status: 'external', zIndex: 0, createdAt: Date.now() }
        terminals.value.push(t)
        persistCreate(t)
        return
      }
      if (t && t.status === 'minimized') { t.status = 'external'; persistUpdate(sid, { status: 'external' }) }   // 刷新恢复压成的最小化复位
      return
    }
    // 墓碑:弹窗标签页没了 → 即刻转最小化(chip 变灰),宽限期后移除(真关了)
    popupWins.delete(sid)
    const t = terminals.value.find(x => x.id === sid)
    if (t && t.status === 'external') t.status = 'minimized'
    const prev = pendingGone.get(sid)
    if (prev) clearTimeout(prev)
    pendingGone.set(sid, setTimeout(() => {
      pendingGone.delete(sid)
      const idx = terminals.value.findIndex(x => x.id === sid)
      if (idx !== -1) { terminals.value.splice(idx, 1); persistDelete(sid) }
    }, GONE_GRACE_MS))
  }
  popupSyncTargets.add(onPopupSignal)

  const openTerminals = computed(() => terminals.value.filter(t => t.status === 'open').sort((a, b) => a.zIndex - b.zIndex))
  const minimizedTerminals = computed(() => terminals.value.filter(t => t.status === 'minimized'))
  // 所有需要保持 DOM 挂载的终端（open + minimized，不含 external——external 在独立浏览器标签页）
  const allTerminals = computed(() => terminals.value.filter(t => t.status !== 'external'))

  return {
    terminals, openTerminals, minimizedTerminals, allTerminals,
    loadPersisted, openTerminal, closeTerminal, minimizeTerminal, restoreTerminal, renameTerminal, focusTerminal, openExternal, focusExternal,
  }
})
