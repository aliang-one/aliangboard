// terminals store 跨标签页对账(2026-09-04):记录本体在服务端,镜像只存身份字段——
// 他页新增收编为最小化(openTerminal 据此可去重,堵双开标签页产生同 pod 重复记录的缺口)、
// 他页已关摘除、本页 status/zIndex 恒不被覆盖。与 sshTerminals 同款 storage 对账语义。
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

const LS_KEY = 'aliangboard.termWindows'
const _open = window.open
const fireMirror = () => window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY }))
const mirrorOf = () => JSON.parse(localStorage.getItem(LS_KEY) || '[]')

beforeEach(() => {
  localStorage.removeItem(LS_KEY)
  setActivePinia(createPinia())
  termListMock.mockReset().mockResolvedValue({ terminals: [] })
  termRemoveMock.mockReset().mockResolvedValue({})
  window.open = vi.fn(() => ({ closed: false, focus: vi.fn() }))
})
afterEach(() => { window.open = _open })

test('开终端写镜像:仅身份字段(无 status/zIndex),他页可凭 namespace/pod/container 去重', () => {
  const store = useTerminalStore()
  const t = store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  expect(mirrorOf()).toEqual([{ id: t.id, namespace: 'ns1', podName: 'pod-a', container: 'main', name: t.name }])
})

test('他页新增:以最小化收编;身份字段齐 → 本页 openTerminal 去重聚焦不重复建;他页已关:摘除 + persistDelete', () => {
  const store = useTerminalStore()
  const mine = store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  // 他页 persist 了 [mine(元数据), other(新增)]
  localStorage.setItem(LS_KEY, JSON.stringify([
    { id: mine.id, namespace: 'ns1', podName: 'pod-a', container: 'main', name: mine.name },
    { id: 'term-other', namespace: 'ns2', podName: 'pod-b', container: 'c1', name: 'pod-b/c1' },
  ]))
  fireMirror()
  expect(store.terminals).toHaveLength(2)
  expect(store.terminals.find(t => t.id === 'term-other').status).toBe('minimized')   // 收编为最小化
  expect(store.terminals.find(t => t.id === mine.id).status).toBe('open')             // 本页状态不被覆盖
  // 他页新增的记录身份字段齐 → 同 pod+container 去重生效:不再建重复记录
  const again = store.openTerminal({ namespace: 'ns2', podName: 'pod-b', container: 'c1' })
  expect(again.id).toBe('term-other')
  expect(store.terminals).toHaveLength(2)
  // 他页关掉 mine → 本页摘除 + 服务端删除幂等补一刀
  localStorage.setItem(LS_KEY, JSON.stringify([{ id: 'term-other', namespace: 'ns2', podName: 'pod-b', container: 'c1', name: 'pod-b/c1' }]))
  fireMirror()
  expect(store.terminals.map(t => t.id)).toEqual(['term-other'])
  expect(termRemoveMock).toHaveBeenCalledWith(mine.id)
})

// 弹窗页改名缺口根修(2026-10-23):弹窗独立标签页里 renameTerminal → persistMirror 落盘,
// opener 的 syncFromStorage 此前对已知 id 原样保留内存对象 → 任务栏 chip 恒显旧名直至刷新。
// 现身份字段(namespace/podName/container/name)跟随镜像(与 sshTerminals.syncFromStorage 同款),
// status/zIndex/command 仍本页权威不被覆盖。
test('他页/弹窗页改名:已知 id 身份字段跟随镜像(status/zIndex 仍本页权威)', () => {
  const store = useTerminalStore()
  const t = store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  store.renameTerminal(t.id, '本地名')   // 本页先改名(会同步写镜像)
  // 他页(弹窗页)改名后落盘的镜像行
  localStorage.setItem(LS_KEY, JSON.stringify([
    { id: t.id, namespace: 'ns1', podName: 'pod-a', container: 'main', name: '他页新名' },
  ]))
  fireMirror()
  const cur = store.terminals.find(x => x.id === t.id)
  expect(cur.name).toBe('他页新名')
  expect(cur.status).toBe('open')          // 本页状态不被镜像覆盖
  expect(cur.id).toBe(t.id)
})
