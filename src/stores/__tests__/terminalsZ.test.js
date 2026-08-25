// 窗口带不变式回归(terminals + fileBrowsers 同型):
// 旧代码 rehydrate 时 nextZ = 100 + loaded.length,刷新后浮窗 z 直接越到
// modal 层(Z.modal)之上,浮窗盖住弹窗;且 ++nextZ 无上界,长会话穿透窗口带。
import { test, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { Z } from '@/styles/zScale'

const termListMock = vi.fn()
const fbListMock = vi.fn()
vi.mock('@/api/client', () => ({
  getSessionToken: () => 'test-token',
  terminalApi: { list: (...a) => termListMock(...a), create: async () => {}, update: async () => {}, remove: async () => {} },
  fileBrowserApi: { list: (...a) => fbListMock(...a), create: async () => {}, update: async () => {}, remove: async () => {} },
}))

import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'

beforeEach(() => {
  setActivePinia(createPinia())
  termListMock.mockReset()
  fbListMock.mockReset()
})

test('terminals: rehydrate 3 条后开新窗,z 恒在窗口带内(modal 之下)', async () => {
  termListMock.mockResolvedValue({ terminals: [
    { id: 't1', namespace: 'ns', podName: 'p1', container: 'main' },
    { id: 't2', namespace: 'ns', podName: 'p2', container: 'main' },
    { id: 't3', namespace: 'ns', podName: 'p3', container: 'main' },
  ] })
  const store = useTerminalStore()
  await store.loadPersisted()
  const term = store.openTerminal({ namespace: 'ns', podName: 'p-new', container: 'main' })
  expect(term.zIndex).toBeGreaterThan(Z.windowBase)
  expect(term.zIndex).toBeLessThanOrEqual(Z.windowMax) // 旧代码此处 = 104,越界
})

test('terminals: 反复置顶越过带上限后 renumber,全部窗口仍恒在带内且保序', async () => {
  termListMock.mockResolvedValue({ terminals: [] })
  const store = useTerminalStore()
  await store.loadPersisted()
  const a = store.openTerminal({ namespace: 'ns', podName: 'pa', container: 'main' })
  const b = store.openTerminal({ namespace: 'ns', podName: 'pb', container: 'main' })
  const c = store.openTerminal({ namespace: 'ns', podName: 'pc', container: 'main' })
  expect(b.zIndex).toBeGreaterThan(a.zIndex)
  // 连续置顶 50 次,远超带上限(99-60=39 个槽位)
  for (let i = 0; i < 50; i++) store.focusTerminal(a.id)
  store.focusTerminal(c.id)
  const zs = store.terminals.map(t => t.zIndex)
  expect(Math.max(...zs)).toBeLessThanOrEqual(Z.windowMax)
  // 保序:重排只压缩间距,层叠次序 a<b<c(最后 focus c 置顶)
  expect(a.zIndex).toBeGreaterThan(b.zIndex)
  expect(c.zIndex).toBeGreaterThan(a.zIndex)
  expect(c.zIndex).toBe(Math.max(...zs))
})

test('fileBrowsers: rehydrate 后开新窗,z 恒在窗口带内', async () => {
  fbListMock.mockResolvedValue({ browsers: [
    { id: 'f1', namespace: 'ns', podName: 'p1', container: 'main' },
  ] })
  const store = useFileBrowserStore()
  await store.loadPersisted()
  const b = store.openBrowser({ namespace: 'ns', podName: 'p-new', container: 'main' })
  expect(b.zIndex).toBeGreaterThan(Z.windowBase)
  expect(b.zIndex).toBeLessThanOrEqual(Z.windowMax) // 旧代码此处 = 102,越界
})
