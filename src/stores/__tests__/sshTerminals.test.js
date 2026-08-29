// sshTerminals store 契约(2026-08-29 任务栏化改造):
// ①openOrFocus:无窗开新(状态 open),有窗聚焦——服务器行按钮语义,不误触多开
// ②openNew:总是新窗新 sid——任务栏分组「+」语义,同服务器可多开
// ③窗口元数据持久化 localStorage aliangboard.ssh.windows;重建 store(模拟刷新)恢复为最小化
// ④closeWindow 移除并同步持久化
// ⑤groups computed:同 serverId 聚合(任务栏分组 chip 数据源)
// ⑥genSid 三级降级(非安全上下文无 randomUUID 仍可用,2026-08-28 真机事故)
import { test, expect, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSshTerminalStore } from '../sshTerminals'

const LS_KEY = 'aliangboard.ssh.windows'
const fresh = () => { localStorage.removeItem(LS_KEY); setActivePinia(createPinia()) }

test('openOrFocus:首次开新窗,再次聚焦同一窗(不多开)', () => {
  fresh()
  const store = useSshTerminalStore()
  const w1 = store.openOrFocus({ id: 'sv1', name: 'web' })
  expect(store.windows.length).toBe(1)
  const w2 = store.openOrFocus({ id: 'sv1', name: 'web' })
  expect(store.windows.length).toBe(1)
  expect(w2.id).toBe(w1.id)
})

test('openNew:同服务器多开——每次新窗新 sid,groups 聚合 count=2', () => {
  fresh()
  const store = useSshTerminalStore()
  const a = store.openNew({ id: 'sv1', name: 'web' })
  const b = store.openNew({ id: 'sv1', name: 'web' })
  expect(store.windows.length).toBe(2)
  expect(b.id).not.toBe(a.id)
  const g = store.groups.find(x => x.serverId === 'sv1')
  expect(g.count).toBe(2)
  expect(g.name).toBe('web')
})

test('持久化:开窗后写入 localStorage;重建 store(刷新)恢复为最小化且 sid 不变', () => {
  fresh()
  const store = useSshTerminalStore()
  const a = store.openNew({ id: 'sv1', name: 'web' })
  store.openNew({ id: 'sv2', name: 'db' })
  const saved = JSON.parse(localStorage.getItem(LS_KEY))
  expect(saved.length).toBe(2)
  expect(saved.map(r => r.id)).toContain(a.id)
  // 模拟刷新:全新 pinia
  setActivePinia(createPinia())
  const store2 = useSshTerminalStore()
  expect(store2.windows.length).toBe(2)
  expect(store2.windows.every(w => w.status === 'minimized')).toBe(true)
  expect(store2.windows.map(w => w.id).sort()).toEqual(saved.map(r => r.id).sort())
  // 恢复后可 restore → open
  store2.restoreWindow(store2.windows[0].id)
  expect(store2.openWindows.length).toBe(1)
})

test('closeWindow:移除并同步持久化', () => {
  fresh()
  const store = useSshTerminalStore()
  const w = store.openNew({ id: 'sv1', name: 'web' })
  store.closeWindow(w.id)
  expect(store.windows.length).toBe(0)
  expect(JSON.parse(localStorage.getItem(LS_KEY)).length).toBe(0)
})

test('genSid 非安全上下文(无 randomUUID)仍可用', () => {
  fresh()
  vi.stubGlobal('crypto', { getRandomValues: arr => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 11) % 256; return arr } })
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    expect(w.id).toMatch(/^ssh-/)
  } finally { vi.unstubAllGlobals() }
})

test('openExternal:状态转 external 且不入浮动宿主(attachedWindows 排除);focusExternal 无弹窗 → 回最小化', () => {
  fresh()
  const fakeWin = { closed: false, focus: () => {} }
  vi.spyOn(window, 'open').mockReturnValue(fakeWin)
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    expect(w.status).toBe('external')
    expect(store.attachedWindows.length).toBe(0)   // 浮动宿主不挂载(WS 随卸载断开)
    fakeWin.closed = true                          // 模拟用户关掉弹窗标签页
    expect(store.focusExternal(w.id)).toBe(false)  // 弹窗已关 → 回最小化
    expect(w.status).toBe('minimized')
  } finally { vi.restoreAllMocks() }
})

test('跨标签页 storage 同步:他页新增收编为最小化;他页关闭摘除;本地 status 不被覆盖', () => {
  fresh()
  const store = useSshTerminalStore()
  const mine = store.openNew({ id: 'sv1', name: 'web' })
  store.restoreWindow(mine.id)   // status=open
  // 他页 persist 了 [mine(元数据), other(新增)]:other 以最小化收编,mine 本地状态保留
  const other = { id: 'ssh-other', serverId: 'sv2', name: 'db' }
  localStorage.setItem(LS_KEY, JSON.stringify([{ id: mine.id, serverId: 'sv1', name: 'web' }, other]))
  window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY }))
  expect(store.windows.length).toBe(2)
  expect(store.windows.find(w => w.id === 'ssh-other').status).toBe('minimized')
  expect(store.windows.find(w => w.id === mine.id).status).toBe('open')
  // 他页关掉了 mine → 摘除(浮动窗随之卸载,符合他页的关闭意图)
  localStorage.setItem(LS_KEY, JSON.stringify([other]))
  window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY }))
  expect(store.windows.map(w => w.id)).toEqual(['ssh-other'])
  // 他页 clear() → 全摘
  localStorage.removeItem(LS_KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: LS_KEY }))
  expect(store.windows.length).toBe(0)
})
