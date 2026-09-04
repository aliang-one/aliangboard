// terminals store 弹窗状态对账契约(2026-09-01 状态管理修复):
// ①openExternal 用确定性窗口名(= terminal.id):再点由浏览器复用/聚焦同一标签页,不再 _blank 多开
// ②重入(PodCard/NsWorkloadDetail 再点终端按钮)遇 external → 聚焦弹窗,绝不在本页复活浮窗(同会话双消费)
// ③focusExternal 无 win 引用(opener 刷新过)→ 按名重开:标签页活着 → 聚焦 + 复位 external;
//   被 popup blocker 拦截 → false + 最小化(重入路径据此降级本页恢复,点了必须有反应)
// ④墓碑:立即转最小化(chip 即刻变灰),宽限期后移除记录 + persistDelete;
//   存活信标在宽限期内到达(F5 刷新场景)→ 取消移除 + 复位 external
// ⑤未知 sid 的存活信标(opener 错过创建窗口期)→ 按信标 meta 重建记录
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const termListMock = vi.fn()
const termRemoveMock = vi.fn()
vi.mock('@/api/client', () => ({
  getSessionToken: () => 'test-token',
  terminalApi: {
    list: (...a) => termListMock(...a),
    create: async () => {},
    update: async () => {},
    remove: (...a) => termRemoveMock(...a),
  },
  fileBrowserApi: { list: async () => ({ browsers: [] }), create: async () => {}, update: async () => {}, remove: async () => {} },
}))

import { useTerminalStore } from '@/stores/terminals'
import { POPUP_ALIVE_KEY, POPUP_CLOSED_KEY, GONE_GRACE_MS } from '@/utils/popupSync'

const _open = window.open
beforeEach(() => {
  setActivePinia(createPinia())
  termListMock.mockReset().mockResolvedValue({ terminals: [] })
  termRemoveMock.mockReset().mockResolvedValue({})
  window.open = vi.fn(() => ({ closed: false, focus: vi.fn() }))
})
afterEach(() => { window.open = _open; vi.useRealTimers() })

const fire = (key, payload) => window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ ...payload, at: 1, n: 't' }) }))
const makeTerm = store => store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
// 模拟 opener 整页刷新:全新 pinia + 服务端持久层回放(loadPersisted 把状态压成 minimized)
const reopenStore = async id => {
  termListMock.mockResolvedValue({ terminals: [{ id, name: 'pod-a/main', namespace: 'ns1', podName: 'pod-a', container: 'main' }] })
  setActivePinia(createPinia())
  const store2 = useTerminalStore()
  await store2.loadPersisted()
  return store2
}

test('openExternal:确定性窗口名 = terminal.id;重复调用聚焦既有弹窗不开第二个', () => {
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  expect(window.open).toHaveBeenCalledTimes(1)
  expect(window.open.mock.calls[0][1]).toBe(term.id)
  store.openExternal(term.id)
  expect(window.open).toHaveBeenCalledTimes(1)   // 幂等:已有活引用 → 只聚焦
})

test('重入 openTerminal 遇 external:聚焦弹窗,status 保持 external,不在本页复活浮窗', () => {
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  const again = store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  expect(again.id).toBe(term.id)
  expect(term.status).toBe('external')
})

test('focusExternal 无 win 引用(opener 刷新过):按名重开聚焦 + 复位 external,返回 true', async () => {
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  const store2 = await reopenStore(term.id)
  expect(store2.terminals[0].status).toBe('minimized')
  expect(store2.focusExternal(term.id)).toBe(true)
  expect(store2.terminals[0].status).toBe('external')
  expect(window.open.mock.calls.at(-1)[1]).toBe(term.id)
})

test('focusExternal 被 popup blocker 拦截(window.open → null):返回 false 并回最小化', async () => {
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  setActivePinia(createPinia())
  window.open = vi.fn(() => null)
  const store2 = await reopenStore(term.id)
  expect(store2.focusExternal(term.id)).toBe(false)
  expect(store2.terminals[0].status).toBe('minimized')
  // 重入路径据此降级:点了必须有反应 → 本页恢复浮窗
  const again = store2.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  expect(again.status).toBe('open')
})

test('墓碑:立即转最小化,宽限期后移除记录并 persistDelete', async () => {
  vi.useFakeTimers()
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  fire(POPUP_CLOSED_KEY, { kind: 'pod', sid: term.id })
  expect(term.status).toBe('minimized')   // 即刻视觉反馈
  await vi.advanceTimersByTimeAsync(GONE_GRACE_MS + 10)
  expect(store.terminals.length).toBe(0)
  expect(termRemoveMock).toHaveBeenCalledWith(term.id)
})

test('墓碑后存活信标在宽限期内到达(F5 刷新):取消移除,复位 external', async () => {
  vi.useFakeTimers()
  const store = useTerminalStore()
  const term = makeTerm(store)
  store.openExternal(term.id)
  fire(POPUP_CLOSED_KEY, { kind: 'pod', sid: term.id })
  fire(POPUP_ALIVE_KEY, { kind: 'pod', sid: term.id, meta: { namespace: 'ns1', podName: 'pod-a', container: 'main', name: 'pod-a/main' } })
  await vi.advanceTimersByTimeAsync(GONE_GRACE_MS + 10)
  expect(store.terminals.length).toBe(1)
  expect(term.status).toBe('external')
  expect(termRemoveMock).not.toHaveBeenCalled()
})

test('未知 sid 的存活信标:按 meta 重建记录(opener 错过创建也不失明)', () => {
  const store = useTerminalStore()
  fire(POPUP_ALIVE_KEY, { kind: 'pod', sid: 'term-ghost', meta: { namespace: 'ns2', podName: 'pod-b', container: 'c1', name: 'n1' } })
  const ghost = store.terminals.find(t => t.id === 'term-ghost')
  expect(ghost).toMatchObject({ namespace: 'ns2', podName: 'pod-b', container: 'c1', status: 'external' })
})

test('kind 分发(2026-09-04):ssh 弹窗的信标不得在 pod store 重建记录(此前靠 id 前缀/meta 形状巧合)', () => {
  const store = useTerminalStore()
  fire(POPUP_ALIVE_KEY, { kind: 'ssh', sid: 'ssh-x', meta: { serverId: 'sv9', name: 'gw-9' } })
  expect(store.terminals).toHaveLength(0)
})
