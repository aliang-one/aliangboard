// sshTerminals store 契约(2026-08-29 任务栏化改造;2026-09-01 弹窗状态对账):
// ①openOrFocus:无窗开新(状态 open),有窗聚焦——服务器行按钮语义,不误触多开
// ②openNew:总是新窗新 sid——任务栏分组「+」语义,同服务器可多开
// ③窗口元数据持久化 localStorage aliangboard.ssh.windows;重建 store(模拟刷新)恢复为最小化
// ④closeWindow 移除并同步持久化 + 网关会话一并回收(best-effort killSession)。杀会话收敛为
//   「显式关闭按钮」专属(浮窗×/任务栏×/会话菜单×/全部关闭);其余生命周期(F5/墓碑收尾/最小化)
//   一律不杀——未附着会话由网关 detachedIdle 10min 兜底回收,多开场景不再被别处关闭误杀。
// ⑤groups computed:同 serverId 聚合(任务栏分组 chip 数据源)
// ⑥genSid 三级降级(非安全上下文无 randomUUID 仍可用,2026-08-28 真机事故)
// ⑦openExternal 确定性窗口名(= sid);重入/focusExternal 无 win 引用时按名重开(聚焦真实标签页),
//   绝不在本页复活浮窗;弹窗墓碑→最小化+宽限后仅移除本地记录(不杀会话);存活信标→复位/重建
import { test, expect, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSshTerminalStore } from '../sshTerminals'
import { sshApi } from '@/api/client'
import { POPUP_ALIVE_KEY, POPUP_CLOSED_KEY, GONE_GRACE_MS } from '@/utils/popupSync'

const LS_KEY = 'aliangboard.ssh.windows'
const _open = window.open
const fresh = () => { localStorage.removeItem(LS_KEY); setActivePinia(createPinia()) }
const firePopup = (key, payload) => window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify({ ...payload, at: 1, n: 't' }) }))

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

test('closeWindow:移除并同步持久化 + 网关会话一并回收 + recentlyClosed 短窗内可查', async () => {
  fresh()
  const kill = vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.closeWindow(w.id)
    expect(store.windows.length).toBe(0)
    expect(JSON.parse(localStorage.getItem(LS_KEY)).length).toBe(0)
    await Promise.resolve()   // kill 是 best-effort 异步
    expect(kill).toHaveBeenCalledWith(w.id)
    expect(store.isRecentlyClosed(w.id)).toBe(true)
  } finally { vi.restoreAllMocks() }
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

test('openExternal:状态转 external 且不入浮动宿主(attachedWindows 排除);确定性窗口名 = sid;重复调用只聚焦', () => {
  fresh()
  const fakeWin = { closed: false, focus: vi.fn() }
  window.open = vi.fn(() => fakeWin)
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    expect(w.status).toBe('external')
    expect(store.attachedWindows.length).toBe(0)   // 浮动宿主不挂载(WS 随卸载断开)
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open.mock.calls[0][1]).toBe(w.id)
    store.openExternal(w.id)                       // 再点:幂等聚焦,不开第二个标签页
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(fakeWin.focus).toHaveBeenCalled()
  } finally { window.open = _open }
})

test('重入 openOrFocus 遇 external:聚焦弹窗,不在本页复活浮窗', () => {
  fresh()
  window.open = vi.fn(() => ({ closed: false, focus: () => {} }))
  try {
    const store = useSshTerminalStore()
    const w = store.openOrFocus({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    store.openOrFocus({ id: 'sv1', name: 'web' })
    expect(store.windows.length).toBe(1)
    expect(w.status).toBe('external')
  } finally { window.open = _open }
})

test('focusExternal 无 win 引用(opener 刷新过):按名重开 → true + 复位 external;被拦截 → false + 最小化', () => {
  fresh()
  window.open = vi.fn(() => ({ closed: false, focus: () => {} }))
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    // 模拟 opener 整页刷新:全新 pinia(localStorage 元数据恢复为最小化,win 引用已丢)
    setActivePinia(createPinia())
    const store2 = useSshTerminalStore()
    expect(store2.windows[0].status).toBe('minimized')
    expect(store2.focusExternal(w.id)).toBe(true)          // 标签页活着 → 浏览器按名复用聚焦
    expect(store2.windows[0].status).toBe('external')      // 复位(不再失明为最小化)
    expect(window.open.mock.calls.at(-1)[1]).toBe(w.id)
    window.open = vi.fn(() => null)                        // popup blocker 拦截
    setActivePinia(createPinia())
    const store3 = useSshTerminalStore()
    expect(store3.focusExternal(w.id)).toBe(false)
    expect(store3.windows[0].status).toBe('minimized')
  } finally { window.open = _open }
})

test('弹窗墓碑:立即最小化,宽限期后仅移除本地记录(不杀网关会话);存活信标(F5)取消收尾', async () => {
  fresh()
  vi.useFakeTimers()
  const kill = vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    firePopup(POPUP_CLOSED_KEY, { kind: 'ssh', sid: w.id })
    expect(w.status).toBe('minimized')   // 即刻视觉反馈
    firePopup(POPUP_ALIVE_KEY, { kind: 'ssh', sid: w.id, meta: { serverId: 'sv1', name: 'web' } })
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS + 10)
    expect(store.windows.length).toBe(1)   // 信标复活 → 不收尾(F5 刷新场景)
    expect(w.status).toBe('external')
    // 标签页没了:墓碑后无信标 → 宽限到 → 仅摘本地记录;杀会话是弹窗「关闭窗口」按钮专属
    // (2026-09-04 关闭语义收敛:pagehide ≠ 关闭意图,F5/标签页丢弃绝不误杀多开中的会话)
    firePopup(POPUP_CLOSED_KEY, { kind: 'ssh', sid: w.id })
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS + 10)
    expect(store.windows.length).toBe(0)
    expect(kill).not.toHaveBeenCalled()
    expect(store.isRecentlyClosed(w.id)).toBe(true)   // 仍降噪:会话活着到 reap 前,任务栏不标红
  } finally { vi.restoreAllMocks(); vi.useRealTimers() }
})

test('存活信标:未知 sid 按 meta 重建记录(opener 错过创建窗口期不失明)', () => {
  fresh()
  const store = useSshTerminalStore()
  firePopup(POPUP_ALIVE_KEY, { kind: 'ssh', sid: 'ssh-ghost', meta: { serverId: 'sv9', name: 'gw-9' } })
  expect(store.windows.find(w => w.id === 'ssh-ghost')).toMatchObject({ serverId: 'sv9', name: 'gw-9', status: 'external' })
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

test('kind 分发(2026-09-04):pod 弹窗的信标不得在 ssh store 重建窗口(此前靠 id 前缀/meta 形状巧合)', () => {
  fresh()
  const store = useSshTerminalStore()
  firePopup(POPUP_ALIVE_KEY, { kind: 'pod', sid: 'term-x', meta: { namespace: 'ns', podName: 'pod-a', container: 'main', name: 'pod-a/main' } })
  expect(store.windows).toHaveLength(0)
})
