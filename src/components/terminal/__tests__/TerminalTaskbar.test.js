// TerminalTaskbar 任务栏化契约(2026-08-29):
// ①SSH 分组 chip:dns 图标+服务器名,同服多窗 ×N 计数;②chip「+」→ openNew(多开入口);
// ③count=1 点击 → 恢复/聚焦;④count>1 点击 → 会话菜单列出各窗+菜单内「新开终端」;
// ⑤closeAll/会话计数涵盖 SSH 窗口。折叠 refit 依赖真实布局,happy-dom 下 scrollWidth=0
// → nextFitStep 判 done(不折叠),溢出路径由 taskbarFit 用例表覆盖。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import TerminalTaskbar from '../TerminalTaskbar.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { useTerminalStore } from '@/stores/terminals'
import { sshApi } from '@/api/client'

const mountBar = () => {
  setActivePinia(createPinia())
  return mount(TerminalTaskbar, { global: { plugins: [i18n] } })
}
const findSshChip = w => w.findAll('button[title*="SSH"]')
const localStorageClear = () => localStorage.clear()

beforeEach(() => { localStorageClear(); vi.restoreAllMocks() })

test('SSH 分组 chip:dns 图标+服务器名;同服多窗 ×N;点「+」新开', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  ssh.openNew({ id: 'sv1', name: 'web-1' })
  ssh.openNew({ id: 'sv1', name: 'web-1' })
  await bar.vm.$nextTick()
  const chip = findSshChip(bar)[0]
  expect(chip.exists()).toBe(true)
  expect(chip.text()).toContain('web-1')
  expect(chip.text()).toContain('×2')
  const plus = chip.find('span[title="新开终端"]')
  await plus.trigger('click')
  expect(ssh.windows.length).toBe(3)
})

test('count=1 且最小化:点 chip → restore(open)', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  const w = ssh.openNew({ id: 'sv1', name: 'db-1' })
  ssh.minimizeWindow(w.id)
  await bar.vm.$nextTick()
  await findSshChip(bar)[0].trigger('click')
  expect(ssh.windows[0].status).toBe('open')
})

test('count>1:点 chip 弹会话菜单(任务栏根部渲染,列出各窗+新开终端入口)', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  ssh.openNew({ id: 'sv1', name: 'web-1' })
  ssh.openNew({ id: 'sv1', name: 'web-1' })
  await bar.vm.$nextTick()
  await findSshChip(bar)[0].trigger('click')
  const menu = bar.find('[data-test="ssh-session-menu"]')
  expect(menu.exists()).toBe(true)
  expect(menu.text()).toContain('#1')
  expect(menu.text()).toContain('#2')
  expect(menu.text()).toContain('新开终端')
  const before = ssh.windows.length
  const newBtn = menu.findAll('button').at(-1)
  await newBtn.trigger('click')
  expect(ssh.windows.length).toBe(before + 1)
  expect(bar.find('[data-test="ssh-session-menu"]').exists()).toBe(false)
})

test('closeAll 与会话计数涵盖 SSH 窗口', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  const term = useTerminalStore()
  ssh.openNew({ id: 'sv1', name: 'web-1' })
  term.openTerminal({ namespace: 'default', podName: 'p1', container: 'main' })
  await bar.vm.$nextTick()
  expect(bar.text()).toContain('2')
  vi.stubGlobal('confirm', () => true)
  try {
    const closeAll = bar.findAll('button')[0]
    await closeAll.trigger('click')
    expect(ssh.windows.length).toBe(0)
    expect(term.terminals.length).toBe(0)
  } finally { vi.unstubAllGlobals() }
})

// —— 网关真值对账(2026-08-29 泄漏审计)——

// 2026-09-06:chip 点击=重附(重建记录+弹窗重开同 sid,恢复历史——不再点即杀);
// × 保留确认后终止。
test('未跟踪会话:chip 点击 → 重附(重建记录,不杀会话);× → 确认后终止', async () => {
  vi.spyOn(sshApi, 'listSessions').mockResolvedValue({
    sessions: [{ sid: 'ssh-orph', serverId: 'sv9', userId: 'bob', browserCount: 1, idleMs: 120000 }],
  })
  const kill = vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  const bar = mountBar()
  await flushPromises()
  const chip = bar.find('[data-test="orphan-chip"]')
  expect(chip.exists()).toBe(true)
  expect(chip.attributes('title')).toContain('sv9')
  const reattach = vi.spyOn(useSshTerminalStore(), 'reattachOrphan')
  await chip.trigger('click')                     // 本体点击 = 重附
  expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-orph', serverId: 'sv9' }))
  expect(kill).not.toHaveBeenCalled()             // 不再点即杀
  await flushPromises()
  expect(bar.find('[data-test="orphan-chip"]').exists()).toBe(false)   // 重附后摘警示
  // × 路径:确认后终止(独立挂载;清存储模拟「记录真丢」——重附已把窗口写入 LS)
  localStorage.clear()
  const bar2 = mountBar()
  await flushPromises()
  const chip3 = bar2.find('[data-test="orphan-chip"]')
  expect(chip3.exists()).toBe(true)
  vi.stubGlobal('confirm', () => true)
  try {
    await chip3.find('span[title]').trigger('click')   // × span(closeThisTitle)
    expect(kill).toHaveBeenCalledWith('ssh-orph')
  } finally { vi.unstubAllGlobals() }
})

test('本地已登记的 sid 不算未跟踪;listSessions 失败(非 admin)静默降级', async () => {
  const ssh = useSshTerminalStore()
  const w = ssh.openNew({ id: 'sv1', name: 'web-1' })
  vi.spyOn(sshApi, 'listSessions').mockResolvedValue({
    sessions: [{ sid: w.id, serverId: 'sv1', userId: 'me', browserCount: 1, idleMs: 0 }],
  })
  const bar = mountBar()
  await flushPromises()
  expect(bar.find('[data-test="orphan-chip"]').exists()).toBe(false)

  vi.restoreAllMocks()
  vi.spyOn(sshApi, 'listSessions').mockRejectedValue(Object.assign(new Error('403'), { status: 403 }))
  const bar2 = mountBar()
  await flushPromises()
  expect(bar2.find('[data-test="orphan-chip"]').exists()).toBe(false)
})

test('刚被本地显式关闭的会话不算「未跟踪」(关闭与网关 reap 之间的窗口期降噪)', async () => {
  vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  const ssh = useSshTerminalStore()
  const w = ssh.openNew({ id: 'sv1', name: 'web-1' })
  ssh.closeWindow(w.id)   // 显式关闭 → recentlyClosed(网关侧默认 10min 才 reap,期间不该标红)
  vi.spyOn(sshApi, 'listSessions').mockResolvedValue({
    sessions: [{ sid: w.id, serverId: 'sv1', userId: 'me', browserCount: 0, idleMs: 1000 }],
  })
  const bar = mountBar()
  await flushPromises()
  expect(bar.find('[data-test="orphan-chip"]').exists()).toBe(false)
})

test('死 chip 标记(事故④):本地窗口连续两轮不在网关列表 → 提示「已回收」;重现即恢复', async () => {
  vi.useFakeTimers()
  const mock = vi.spyOn(sshApi, 'listSessions').mockResolvedValue({ sessions: [] })
  const bar = mountBar()                     // 先 mount(fresh pinia),再取 store 开窗
  const ssh = useSshTerminalStore()
  const w = ssh.openNew({ id: 'sv1', name: 'web-1' })
  try {
    mock.mockResolvedValue({ sessions: [{ sid: w.id, serverId: 'sv1', userId: 'me', browserCount: 1, idleMs: 0 }] })
    await vi.advanceTimersByTimeAsync(30000)
    await flushPromises()
    let chip = findSshChip(bar)[0]
    expect(chip.attributes('title')).not.toContain('空闲回收')   // 网关还活着:正常

    mock.mockResolvedValue({ sessions: [] })
    await vi.advanceTimersByTimeAsync(30000)                    // 第 1 轮缺失:宽限(建连窗口期)
    await flushPromises()
    chip = findSshChip(bar)[0]
    expect(chip.attributes('title')).not.toContain('空闲回收')

    await vi.advanceTimersByTimeAsync(30000)                    // 第 2 轮缺失:判死
    await flushPromises()
    chip = findSshChip(bar)[0]
    expect(chip.attributes('title')).toContain('空闲回收')

    mock.mockResolvedValue({ sessions: [{ sid: w.id, serverId: 'sv1', userId: 'me', browserCount: 1, idleMs: 0 }] })
    await vi.advanceTimersByTimeAsync(30000)                    // 重现:恢复常态
    await flushPromises()
    chip = findSshChip(bar)[0]
    expect(chip.attributes('title')).not.toContain('空闲回收')
  } finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

test('死 chip 点击(复审 F3):已打开的死窗口强制 minimize→restore 翻转触发重连', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  const w = ssh.openNew({ id: 'sv1', name: 'web-1' })
  ssh.markDeadSids([w.id])
  await bar.vm.$nextTick()
  const chip = findSshChip(bar)[0]
  const minSpy = vi.spyOn(ssh, 'minimizeWindow')
  const resSpy = vi.spyOn(ssh, 'restoreWindow')
  await chip.trigger('click')              // status=open + dead → 翻转而非 focus
  expect(minSpy).toHaveBeenCalledWith(w.id)
  expect(resSpy).toHaveBeenCalledWith(w.id)  // 翻转完成 → SshTerminalWindow watcher 的 connectIfIdle 重连
  expect(w.status).toBe('open')
})

// —— 同 pod 多终端(2026-09-05):pod chip「+」= openNewTerminal 恒新建,与 SSH 分组 chip 同款 ——

test('pod chip「+」:点击 → openNewTerminal 新建同 pod 终端,命名 #2', async () => {
  const bar = mountBar()
  const term = useTerminalStore()
  term.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  await bar.vm.$nextTick()
  const chip = bar.find('[data-test^="pod-chip-"]')
  expect(chip.exists()).toBe(true)
  const plus = chip.find('span[title="新开终端"]')
  expect(plus.exists()).toBe(true)
  await plus.trigger('click')
  expect(term.terminals).toHaveLength(2)
  expect(term.terminals[1].podName).toBe('pod-a')
  expect(term.terminals[1].name).toBe('pod-a/main #2')
  expect(term.terminals[1].status).toBe('open')
})

test('pod chip 点击本体仍是聚焦语义:多实例时点 chip 不新建', async () => {
  const bar = mountBar()
  const term = useTerminalStore()
  term.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  term.openNewTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  await bar.vm.$nextTick()
  expect(term.terminals).toHaveLength(2)
  const chips = bar.findAll('[data-test^="pod-chip-"]')
  expect(chips.length).toBe(2)
  await chips[0].trigger('click')
  expect(term.terminals).toHaveLength(2)   // 点击 chip 本体不新建(openOrFocus 语义不变)
})

// —— 会话标签(2026-09-08):同服多会话菜单行显示 label||name;✏️ → PromptDialog → renameWindow ——
test('会话菜单行显示 label(有标签时);✏️ 改名 → PromptDialog → renameWindow 落库', async () => {
  const bar = mountBar()
  const ssh = useSshTerminalStore()
  const a = ssh.openNew({ id: 'sv1', name: 'web-1' })
  const b = ssh.openNew({ id: 'sv1', name: 'web-1' })
  ssh.renameWindow(b.id, '日志排查')
  await bar.vm.$nextTick()
  await findSshChip(bar)[0].trigger('click')
  const menu = bar.find('[data-test="ssh-session-menu"]')
  expect(menu.text()).toContain('日志排查')
  expect(menu.text()).toContain('web-1')          // a 未改标签 → 服务器名回退
  // ✏️(第二行)→ PromptDialog 初值=当前标签 → 改名确认
  const editBtns = menu.findAll('[title="重命名会话"]')
  expect(editBtns.length).toBe(2)
  await editBtns[1].trigger('click')
  await bar.vm.$nextTick()
  const dlg = document.querySelector('[data-testid="prompt-input"]')   // Modal Teleport body
  expect(dlg?.value).toBe('日志排查')
  dlg.value = '数据库维护'
  dlg.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('[data-testid="prompt-ok"]').click()
  await bar.vm.$nextTick()
  expect(ssh.windows.find(w => w.id === b.id).label).toBe('数据库维护')
  expect(ssh.windows.find(w => w.id === a.id).label).toBe('')          // 只改了目标行
  expect(JSON.parse(localStorage.getItem('aliangboard.ssh.windows')).find(r => r.id === b.id).label).toBe('数据库维护')
})
