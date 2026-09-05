// 同 pod 多终端(2026-09-05):openNewTerminal 恒新建(任务栏 pod chip「+」入口),
// openTerminal(点击=聚焦/恢复)的 pod+container 去重语义保持不变——那是 2026-09-04
// 跨标签页重复 chip 的防线,多开只能走显式入口。
import { test, expect, vi, beforeEach } from 'vitest'
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
  localStorage.clear()
  setActivePinia(createPinia())
  termListMock.mockReset().mockResolvedValue({ terminals: [] })
})

test('openNewTerminal 恒新建:同 pod+container 连开三次 → 三条独立记录,全部 open', () => {
  const store = useTerminalStore()
  const a = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  const b = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  const c = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(store.terminals).toHaveLength(3)
  expect(new Set([a.id, b.id, c.id]).size).toBe(3)
  for (const t of [a, b, c]) expect(t.status).toBe('open')
})

test('缺省命名自动 #N 后缀:#2、#3;首个实例保持无后缀', () => {
  const store = useTerminalStore()
  const a = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  const b = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  const c = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(a.name).toBe('pod-a/main')
  expect(b.name).toBe('pod-a/main #2')
  expect(c.name).toBe('pod-a/main #3')
})

test('显式 name 不加后缀;重命名过的兄弟实例仍计入序号', () => {
  const store = useTerminalStore()
  const a = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  store.renameTerminal(a.id, 'my-shell')            // 重命名不改变它是「第 1 个实例」的事实
  const b = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(b.name).toBe('pod-a/main #2')              // 序号按实例数,不按名字文本
  const c = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main', name: 'debug-shell' })
  expect(c.name).toBe('debug-shell')                // 显式名不加后缀
})

test('不同 container/不同 pod 互不计数:各自首个实例无后缀', () => {
  const store = useTerminalStore()
  store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  const side = store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'sidecar' })
  const other = store.openNewTerminal({ namespace: 'ns', podName: 'pod-b', container: 'main' })
  expect(side.name).toBe('pod-a/sidecar')
  expect(other.name).toBe('pod-b/main')
})

test('openTerminal 点击语义不回归:同 pod+container 已有多实例,点击仍聚焦第一条不新建', () => {
  const store = useTerminalStore()
  const first = store.openTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  first.status = 'minimized'
  store.openNewTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(store.terminals).toHaveLength(2)
  const hit = store.openTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(hit.id).toBe(first.id)                     // 命中第一个实例聚焦
  expect(store.terminals).toHaveLength(2)           // 不新建
  expect(hit.status).toBe('open')
})
