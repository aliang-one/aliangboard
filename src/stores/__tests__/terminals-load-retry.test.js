// loadPersisted 有界重试(2026-09-03「终端记录消失」排查):网络差时页面加载 list() 失败,
// 旧实现静默放弃 → 任务栏空到下次手动刷新。修复:5×3s 有界重试;期间用户已开新终端(本地
// 非空)则停,避免成功回包覆盖用户本地新建。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const termListMock = vi.fn()
vi.mock('@/api/client', () => ({
  getSessionToken: () => 'test-token',
  terminalApi: {
    list: (...a) => termListMock(...a),
    create: async () => {},
    update: async () => {},
    remove: async () => {},
  },
  fileBrowserApi: { list: async () => ({ browsers: [] }), create: async () => {}, update: async () => {}, remove: async () => {} },
}))

import { useTerminalStore } from '@/stores/terminals'

beforeEach(() => {
  setActivePinia(createPinia())
  termListMock.mockReset().mockResolvedValue({ terminals: [] })
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

test('list 失败后有界重试,网络恢复即回填记录', async () => {
  termListMock.mockRejectedValueOnce(new Error('network down'))
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValueOnce({ terminals: [{ id: 't1', name: 'pod-a/main', namespace: 'ns', podName: 'pod-a', container: 'main', command: 'sh' }] })
  const store = useTerminalStore()
  await store.loadPersisted()
  expect(store.terminals).toHaveLength(0) // 首次失败
  await vi.advanceTimersByTimeAsync(3000)
  expect(termListMock).toHaveBeenCalledTimes(2) // 第 1 次重试仍失败
  expect(store.terminals).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(3000)
  expect(termListMock).toHaveBeenCalledTimes(3) // 第 2 次重试成功
  expect(store.terminals).toHaveLength(1)
  // 成功后重试计数清零,后续失败重新计 5 次
  expect(store.terminals[0].status).toBe('minimized')
})

test('重试上限 5 次,不再无限轮询', async () => {
  termListMock.mockRejectedValue(new Error('network down'))
  const store = useTerminalStore()
  await store.loadPersisted()
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(3000)
  expect(termListMock).toHaveBeenCalledTimes(1 + 5) // 首次 + 5 次重试
})

test('期间用户已开新终端(本地非空)→ 已排程的那次重试仍执行,但不再续排', async () => {
  termListMock.mockRejectedValue(new Error('network down'))
  const store = useTerminalStore()
  await store.loadPersisted()
  await vi.advanceTimersByTimeAsync(3000) // 触发一次重试排程
  store.openTerminal({ namespace: 'ns', podName: 'pod-b', container: 'main' })
  expect(store.terminals).toHaveLength(1) // 本地新建
  await vi.advanceTimersByTimeAsync(3000) // 已排程的重试执行(此刻本地已非空)
  const calls = termListMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(30000)
  expect(termListMock.mock.calls.length).toBe(calls) // 不再续排,本地状态未被覆盖
  expect(store.terminals).toHaveLength(1)
})

test('loadPersisted 成功回包与本地 merge:在途 list 旧快照不抹掉用户已开的终端,服务端新记录补入', async () => {
  // 2026-09-04 竞态修复:旧实现 terminals.value = loaded 整表覆盖——启动窗口期(慢网 list 在途)
  // 用户开的终端被旧快照从 UI 抹掉(浮窗随之卸载断 WS),下次刷新又复活成幽灵 chip。
  let resolveList
  termListMock.mockReturnValueOnce(new Promise(r => { resolveList = r }))
  const store = useTerminalStore()
  const p = store.loadPersisted()
  store.openTerminal({ namespace: 'ns', podName: 'pod-b', container: 'main' })   // 本地 T1(list 仍在途)
  resolveList({ terminals: [{ id: 't0', name: 'pod-a/main', namespace: 'ns', podName: 'pod-a', container: 'main', command: 'sh' }] })
  await p
  expect(store.terminals).toHaveLength(2)
  const local = store.terminals.find(t => t.id !== 't0')
  expect(local.status).toBe('open')                                     // 本地新建连状态带 zIndex 原样保留
  expect(store.terminals.find(t => t.id === 't0').status).toBe('minimized')   // 服务端记录补入
})

test('本页已显式关闭的记录不被迟到的 list 回包复活', async () => {
  let resolveList
  termListMock.mockReturnValueOnce(new Promise(r => { resolveList = r }))
  const store = useTerminalStore()
  const p = store.loadPersisted()
  const t = store.openTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  store.closeTerminal(t.id)
  resolveList({ terminals: [{ id: t.id, name: 'x', namespace: 'ns', podName: 'pod-a', container: 'main', command: 'sh' }] })
  await p
  expect(store.terminals).toHaveLength(0)
})
