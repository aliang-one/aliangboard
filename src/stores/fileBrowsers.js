// 文件浏览窗口管理:照 terminals 平行(浮动窗口/最小化任务栏/SQLite 持久化刷新恢复)。
// 窗口体(FileBrowserBody)经 AppLayout v-show 挂载,最小化不销毁 → 树展开/选中状态天然同步。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fileBrowserApi } from '@/api/client'
import { createWindowZAllocator } from '@/styles/zScale'

// 跨标签页对账镜像(2026-09-04,与 terminals/sshTerminals 同款):仅身份字段,status/zIndex 属本地
const LS_KEY = 'aliangboard.fbWindows'
const storageSyncTargets = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key && e.key !== LS_KEY) return
    for (const fn of storageSyncTargets) fn()
  })
}

export const useFileBrowserStore = defineStore('fileBrowsers', () => {
  const browsers = ref([])   // [{id, name, namespace, podName, container, status, zIndex, createdAt}]
  // 与终端同一窗口带(Z.windowBase..Z.windowMax,模态框 Z.modal 之下);越界自动 renumber——见 zScale
  const zAlloc = createWindowZAllocator()
  const takeZ = () => zAlloc.nextZ(browsers.value.filter(b => b.status === 'open'))

  async function persistCreate(b) { try { await fileBrowserApi.create(b) } catch { /* 离线静默 */ } }
  async function persistUpdate(id, patch) { try { await fileBrowserApi.update(id, patch) } catch { /* noop */ } }
  async function persistDelete(id) { try { await fileBrowserApi.remove(id) } catch { /* noop */ } }

  function persistMirror() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(browsers.value.map(({ id, namespace, podName, container, name }) => ({ id, namespace, podName, container, name }))))
    } catch { /* 存储不可用:降级为单页有效 */ }
  }

  // storage 事件对账(与 terminals store 同款):他页新增收编为最小化,他页已关摘除,本地状态不覆盖
  function syncFromStorage() {
    let rows = []
    try { rows = JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { rows = [] }
    if (!Array.isArray(rows)) rows = []
    const byId = new Map(browsers.value.map(b => [b.id, b]))
    const merged = []
    for (const r of rows) {
      const cur = byId.get(r.id)
      byId.delete(r.id)
      merged.push(cur || {
        id: r.id, namespace: r.namespace || '', podName: r.podName || '', container: r.container || '',
        name: r.name || `${r.podName || 'pod'}/${r.container || 'main'}`,
        status: 'minimized', zIndex: 0, createdAt: Date.now(),
      })
    }
    for (const orphan of byId.values()) {
      locallyDeleted.add(orphan.id)
      persistDelete(orphan.id)
    }
    browsers.value = merged
  }
  storageSyncTargets.add(syncFromStorage)

  // 有界重试 5×3s(2026-09-03,与 terminals store 同款):网络差时页面加载失败不再静默空到下次刷新
  let loadRetryTimer = null
  let loadRetries = 0
  // 本页显式关闭过的 id:防在途 list 的旧快照把已关记录复活(与 terminals store 同款,2026-09-04)
  const locallyDeleted = new Set()
  async function loadPersisted() {
    clearTimeout(loadRetryTimer)
    try {
      const res = await fileBrowserApi.list()
      const loaded = (res?.browsers || []).map(b => ({ ...b, status: 'minimized', zIndex: 0 }))  // 刷新后全最小化
      // merge 而非整表覆盖(2026-09-04 竞态修复,与 terminals store 同款):慢回包不抹掉
      // 启动窗口期已开的窗口;服务端新记录补入;本页已显式关闭的 id 不复活。
      const known = new Set(browsers.value.map(b => b.id))
      browsers.value = [...browsers.value, ...loaded.filter(l => !known.has(l.id) && !locallyDeleted.has(l.id))]
      persistMirror()
      loadRetries = 0
      // 注:旧代码这里把 nextZ 跳到 100+N,刷新后浮窗越到 modal 层之上,已改由 allocator 保证带内
    } catch {
      if (browsers.value.length === 0 && loadRetries < 5) {
        loadRetries++
        loadRetryTimer = setTimeout(loadPersisted, 3000)
      }
    }
  }

  // 打开(同 pod+container 去重聚焦)
  function openBrowser({ namespace, podName, container }) {
    const existing = browsers.value.find(b =>
      b.namespace === namespace && b.podName === podName && (b.container || '') === (container || ''))
    if (existing) {
      existing.status = 'open'
      existing.zIndex = takeZ()
      persistUpdate(existing.id, { status: 'open' })
      persistMirror()
      return existing
    }
    const b = {
      id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${podName}/${container || 'main'}`,
      namespace, podName, container: container || '',
      status: 'open', zIndex: takeZ(), createdAt: Date.now(),
    }
    browsers.value.push(b)
    persistCreate(b)
    persistMirror()
    return b
  }

  function closeBrowser(id) {
    locallyDeleted.add(id)
    const idx = browsers.value.findIndex(b => b.id === id)
    if (idx !== -1) { browsers.value.splice(idx, 1); persistDelete(id) }
    persistMirror()
  }
  function minimizeBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
  }
  function restoreBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'open'; b.zIndex = takeZ(); persistUpdate(id, { status: 'open' }) }
  }
  function focusBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) b.zIndex = takeZ()
  }

  return { browsers, loadPersisted, openBrowser, closeBrowser, minimizeBrowser, restoreBrowser, focusBrowser }
})
