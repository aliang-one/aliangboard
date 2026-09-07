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
//   绝不在本页复活浮窗;弹窗墓碑→最小化且保留记录(2026-09-06 v2,不杀会话);存活信标→复位/重建
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

// 2026-09-06 收敛 v2:pagehide 三态(F5/浏览器丢弃/真关闭)不可分 → 墓碑只降最小化、
// **保留记录**(discard 标签也发 pagehide,摘记录=「离开一会 chip 少一个」生产事故);
// 移除唯一入口=显式关闭(closeWindow);未附着会话由网关 detachedIdle 兜底(sweep 状态修复)。
test('弹窗墓碑:立即最小化且记录保留(宽限后也不摘);不杀网关会话;信标到达复位 external', async () => {
  fresh()
  vi.useFakeTimers()
  const kill = vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  try {
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web' })
    store.openExternal(w.id)
    firePopup(POPUP_CLOSED_KEY, { kind: 'ssh', sid: w.id })
    expect(w.status).toBe('minimized')   // 即刻视觉反馈
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS + 10)
    expect(store.windows.length).toBe(1) // 记录保留:丢弃的标签被点开即由信标复位
    expect(kill).not.toHaveBeenCalled()  // 杀会话是弹窗「关闭窗口」按钮专属
    // 标签重载(F5/丢弃后再点开):存活信标 → 复位 external
    firePopup(POPUP_ALIVE_KEY, { kind: 'ssh', sid: w.id, meta: { serverId: 'sv1', name: 'web' } })
    expect(w.status).toBe('external')
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

test('死 chip 标记(事故④):markDeadSids/markAliveSid/isDead——网关已回收的 sid 置灰,重现即摘标', () => {
  fresh()
  const store = useSshTerminalStore()
  expect(store.isDead('ssh-a')).toBe(false)
  store.markDeadSids(['ssh-a', 'ssh-b'])
  expect(store.isDead('ssh-a')).toBe(true)
  expect(store.isDead('ssh-b')).toBe(true)
  store.markAliveSid('ssh-a')
  expect(store.isDead('ssh-a')).toBe(false)
  expect(store.isDead('ssh-b')).toBe(true)
  store.markDeadSids(['ssh-c'])          // 整表替换:上一轮死集不残留
  expect(store.isDead('ssh-b')).toBe(false)
  expect(store.isDead('ssh-c')).toBe(true)
})

test('镜像 merge-on-write(事故⑤):冻结标签页醒来后 persist 不抹掉他页新增;本页显式移除的不复活', () => {
  fresh()
  const store = useSshTerminalStore()
  const w1 = store.openNew({ id: 'sv1', name: 'web' })
  // 他页新增 W2 并落盘;本页被冻结收不到 storage 事件
  localStorage.setItem(LS_KEY, JSON.stringify([
    { id: w1.id, serverId: 'sv1', name: 'web' },
    { id: 'ssh-w2', serverId: 'sv2', name: 'db' },
  ]))
  expect(store.windows.length).toBe(1)                     // 本页确实不知情
  const w3 = store.openNew({ id: 'sv3', name: 'cache' })   // 醒来后新增 → persist
  const ids = JSON.parse(localStorage.getItem(LS_KEY)).map(r => r.id).sort()
  expect(ids).toEqual([w1.id, 'ssh-w2', w3.id].sort())     // 他页的 W2 不被抹掉
  store.closeWindow(w1.id)                                 // 本页显式关闭 → 磁盘基线也不得复活
  const ids2 = JSON.parse(localStorage.getItem(LS_KEY)).map(r => r.id).sort()
  expect(ids2).toEqual(['ssh-w2', w3.id].sort())
})

test('删除墓碑(复审 F4):closeWindow 落跨页墓碑;冻结页醒来 persist/装载都不复活已删 sid', () => {
  fresh()
  const tombKey = 'aliangboard.ssh.removedTombstones'
  const storeA = useSshTerminalStore()
  const w1 = storeA.openNew({ id: 'sv1', name: 'web' })
  storeA.closeWindow(w1.id)
  expect(typeof JSON.parse(localStorage.getItem(tombKey))[w1.id]).toBe('number')   // 墓碑落盘

  // 模拟:磁盘上有人把已删 sid 写回(他页/外部)
  localStorage.setItem(LS_KEY, JSON.stringify([{ id: w1.id, serverId: 'sv1', name: 'web' }]))
  storeA.openNew({ id: 'sv2', name: 'db' })              // A 页再次 persist
  expect(JSON.parse(localStorage.getItem(LS_KEY)).map(r => r.id)).not.toContain(w1.id)   // 墓碑过滤,不复活

  setActivePinia(createPinia())                          // 模拟刷新:全新 pinia 装载
  const storeB = useSshTerminalStore()
  expect(storeB.windows.find(w => w.id === w1.id)).toBeUndefined()   // 装载同样被墓碑过滤
})

// 孤儿重附(2026-09-06):网关有会话而本地记录已丢 → 重建窗口记录+弹窗重开同 sid(回放历史)。
test('reattachOrphan:记录缺失时按快照重建并 openExternal;已有记录则直接重开', async () => {
  fresh()
  const fakeWin = { closed: false, focus: vi.fn() }
  window.open = vi.fn(() => fakeWin)
  try {
    const store = useSshTerminalStore()
    // 记录缺失(孤儿):重建 + external + 弹窗重开(确定性窗口名 = sid)
    store.reattachOrphan({ id: 'ssh-lost', serverId: 'sv1', name: 'web-1' })
    const w = store.windows.find(x => x.id === 'ssh-lost')
    expect(w).toBeTruthy()
    expect(w.serverId).toBe('sv1')
    expect(w.status).toBe('external')
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(window.open.mock.calls[0][1]).toBe('ssh-lost')
    expect(JSON.parse(localStorage.getItem(LS_KEY)).map(r => r.id)).toContain('ssh-lost')   // 记录落盘,刷新不再失明
    // 记录已存在:不重复建;弹窗已在 → 幂等聚焦,不再 window.open
    w.status = 'minimized'
    store.reattachOrphan({ id: 'ssh-lost', serverId: 'sv1', name: 'web-1' })
    expect(store.windows.filter(x => x.id === 'ssh-lost')).toHaveLength(1)
    expect(window.open).toHaveBeenCalledTimes(1)   // 幂等:已开的弹窗只聚焦
    expect(fakeWin.focus).toHaveBeenCalled()
  } finally { window.open = _open }
})

// 重附撤销旧墓碑(2026-09-07 外评#2):旧版本删除记录时落的墓碑若残留,重附后
// persist/loadPersisted 会再次滤掉该窗口(内存里在、刷新又消失)——重附必须清墓碑。
test('reattachOrphan:清除历史墓碑,重附后刷新(loadPersisted)窗口仍在', async () => {
  fresh()
  // 模拟旧版残留:sid 已在删除墓碑日志中
  localStorage.setItem('aliangboard.ssh.removedTombstones', JSON.stringify({ 'ssh-stale': Date.now() }))
  const fakeWin = { closed: false, focus: vi.fn() }
  window.open = vi.fn(() => fakeWin)
  try {
    const store = useSshTerminalStore()
    store.reattachOrphan({ id: 'ssh-stale', serverId: 'sv1', name: 'web' })
    expect(JSON.parse(localStorage.getItem(LS_KEY)).map(r => r.id)).toContain('ssh-stale')   // 墓碑已清,persist 不再滤
    expect(JSON.parse(localStorage.getItem('aliangboard.ssh.removedTombstones'))).toEqual({})
    // 刷新模拟:新 store 从 LS 装载,窗口仍在
    const reloaded = useSshTerminalStore()
    expect(reloaded.windows.map(w => w.id)).toContain('ssh-stale')
  } finally { window.open = _open }
})
