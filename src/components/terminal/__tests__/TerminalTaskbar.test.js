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

test('未跟踪会话:网关有而本地无 → 警示 chip 置首,点击确认后手杀', async () => {
  vi.spyOn(sshApi, 'listSessions').mockResolvedValue({
    sessions: [{ sid: 'ssh-orph', serverId: 'sv9', userId: 'bob', browserCount: 1, idleMs: 120000 }],
  })
  const kill = vi.spyOn(sshApi, 'killSession').mockResolvedValue({ ok: true })
  const bar = mountBar()
  await flushPromises()
  const chip = bar.find('[data-test="orphan-chip"]')
  expect(chip.exists()).toBe(true)
  expect(chip.attributes('title')).toContain('sv9')
  vi.stubGlobal('confirm', () => true)
  try {
    await chip.trigger('click')
    expect(kill).toHaveBeenCalledWith('ssh-orph')
    await flushPromises()
    expect(bar.find('[data-test="orphan-chip"]').exists()).toBe(false)
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
