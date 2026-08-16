// 文件浏览窗口管理:照 terminals 平行(浮动窗口/最小化任务栏/SQLite 持久化刷新恢复)。
// 窗口体(FileBrowserBody)经 AppLayout v-show 挂载,最小化不销毁 → 树展开/选中状态天然同步。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fileBrowserApi } from '@/api/client'

export const useFileBrowserStore = defineStore('fileBrowsers', () => {
  const browsers = ref([])   // [{id, name, namespace, podName, container, status, zIndex, createdAt}]
  let nextZ = 40             // 与终端同一层级:内容之上、模态框(z-100)之下

  async function persistCreate(b) { try { await fileBrowserApi.create(b) } catch { /* 离线静默 */ } }
  async function persistUpdate(id, patch) { try { await fileBrowserApi.update(id, patch) } catch { /* noop */ } }
  async function persistDelete(id) { try { await fileBrowserApi.remove(id) } catch { /* noop */ } }

  async function loadPersisted() {
    try {
      const res = await fileBrowserApi.list()
      const loaded = (res?.browsers || []).map(b => ({ ...b, status: 'minimized', zIndex: 0 }))  // 刷新后全最小化
      browsers.value = loaded
      if (loaded.length) nextZ = 100 + loaded.length
    } catch { /* 离线静默 */ }
  }

  // 打开(同 pod+container 去重聚焦)
  function openBrowser({ namespace, podName, container }) {
    const existing = browsers.value.find(b =>
      b.namespace === namespace && b.podName === podName && (b.container || '') === (container || ''))
    if (existing) {
      existing.status = 'open'
      existing.zIndex = ++nextZ
      persistUpdate(existing.id, { status: 'open' })
      return existing
    }
    const b = {
      id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${podName}/${container || 'main'}`,
      namespace, podName, container: container || '',
      status: 'open', zIndex: ++nextZ, createdAt: Date.now(),
    }
    browsers.value.push(b)
    persistCreate(b)
    return b
  }

  function closeBrowser(id) {
    const idx = browsers.value.findIndex(b => b.id === id)
    if (idx !== -1) { browsers.value.splice(idx, 1); persistDelete(id) }
  }
  function minimizeBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'minimized'; persistUpdate(id, { status: 'minimized' }) }
  }
  function restoreBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) { b.status = 'open'; b.zIndex = ++nextZ; persistUpdate(id, { status: 'open' }) }
  }
  function focusBrowser(id) {
    const b = browsers.value.find(b => b.id === id)
    if (b) b.zIndex = ++nextZ
  }

  return { browsers, loadPersisted, openBrowser, closeBrowser, minimizeBrowser, restoreBrowser, focusBrowser }
})
