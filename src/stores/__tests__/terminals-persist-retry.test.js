// 终端记录服务端写失败补偿队列(2026-09-06 评审#5):persistCreate/Update/Delete 此前直接
// catch 吞掉——INSERT 失败时终端已开、刷新即丢记录。改为失败入队有界重试(3 次×30s),
// 成功出队;期间成功的主路径不再重复入队。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const createMock = vi.fn()
const updateMock = vi.fn()
const removeMock = vi.fn()
const listMock = vi.fn()
vi.mock('@/api/client', () => ({
  getSessionToken: () => 'test-token',
  terminalApi: {
    list: (...a) => listMock(...a),
    create: (...a) => createMock(...a),
    update: (...a) => updateMock(...a),
    remove: (...a) => removeMock(...a),
  },
  fileBrowserApi: { list: async () => ({ browsers: [] }), create: async () => {}, update: async () => {}, remove: async () => {} },
}))

import { useTerminalStore } from '@/stores/terminals'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  listMock.mockReset().mockResolvedValue({ terminals: [] })
  createMock.mockReset().mockResolvedValue({})
  updateMock.mockReset().mockResolvedValue({})
  removeMock.mockReset().mockResolvedValue({})
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

test('create 失败入补偿队列,重试成功后服务端收到 create(记录不再静默丢失)', async () => {
  createMock.mockRejectedValueOnce(new Error('db busy'))     // 首次写失败
  const store = useTerminalStore()
  store.openTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  expect(createMock).toHaveBeenCalledTimes(1)               // 主路径已试过一次
  await vi.advanceTimersByTimeAsync(30_000)                  // 补偿轮 1:成功
  expect(createMock).toHaveBeenCalledTimes(2)
  expect(createMock.mock.calls[1][0].podName).toBe('pod-a')
})

test('持续失败有界重试:3 次后放弃并不再无限轮询', async () => {
  createMock.mockRejectedValue(new Error('db down'))
  const store = useTerminalStore()
  store.openTerminal({ namespace: 'ns', podName: 'pod-a', container: 'main' })
  await vi.advanceTimersByTimeAsync(30_000 * 5)              // 远超重试上限
  const calls = createMock.mock.calls.length
  expect(calls).toBeLessThanOrEqual(4)                       // 主路径 1 + 补偿 ≤3
  await vi.advanceTimersByTimeAsync(30_000 * 5)
  expect(createMock.mock.calls.length).toBe(calls)           // 放弃后不再重试
})
