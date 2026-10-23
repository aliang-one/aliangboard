// SSH 终端 page 档居中会话名(2026-10-23):弹窗页头部三段式——左=ssh://服务器,中=会话名
// (双击/✏️ 改名,emit rename 由宿主落 store+网关),右=状态钮。浮窗档行为不变(无改名 UI)。
// mock 策略照 SshTerminal.test.js:xterm 三件套桩掉,sshTerminalStream 捕获入参。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  sshTerminalStream: vi.fn(() => ({ send() {}, resize() {}, close() {}, isOpen: true })),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() { this.cols = 80; this.rows = 24 }
    open() {} write() {} writeln() {} onData() {} onResize() {} loadAddon() {} attachCustomKeyEventHandler() {} hasSelection() { return false } focus() {} dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

import SshTerminal from '../SshTerminal.vue'

const mountTerm = props => mount(SshTerminal, {
  props: { serverId: 'sv1', serverName: 'gw-1', sid: 'sid-1', autoConnect: true, ...props },
  global: { plugins: [i18n] },
})
beforeEach(() => { vi.clearAllMocks() })

test("chrome='page' + title:中段渲染会话名;双击进编辑,回车 emit rename;Esc 取消", async () => {
  const w = mountTerm({ chrome: 'page', title: '生产机' })
  await flushPromises()
  const ttl = w.find('[data-test="ssh-title"]')
  expect(ttl.exists()).toBe(true)
  expect(ttl.text()).toBe('生产机')
  // 左段身份信息仍在:ssh://服务器名(非会话名)
  expect(w.html()).toContain('ssh://gw-1')
  await ttl.trigger('dblclick')
  const input = w.find('input[data-test="ssh-title-input"]')
  expect(input.exists()).toBe(true)
  await input.setValue('跳板机')
  await input.trigger('keydown.enter')
  expect(w.emitted('rename')).toEqual([['跳板机']])
  // Esc 分支:取消不 emit
  await w.find('[data-test="ssh-title"]').trigger('dblclick')
  await w.find('input[data-test="ssh-title-input"]').trigger('keydown.esc')
  expect(w.emitted('rename')).toHaveLength(1)
})

test('✏️ 钮点击进入编辑;hover 显隐配方(max-sm 常显过 V4)', async () => {
  const w = mountTerm({ chrome: 'page', title: '生产机' })
  await flushPromises()
  const btn = w.find('[data-test="btnRename"]')
  expect(btn.exists()).toBe(true)
  expect(btn.classes().join(' ')).toContain('max-sm:opacity-100')
  await btn.trigger('click')
  expect(w.find('input[data-test="ssh-title-input"]').exists()).toBe(true)
})

test('无 title 不渲染中段(回退现状);浮窗档恒无改名 UI', async () => {
  const w = mountTerm({ chrome: 'page' })
  await flushPromises()
  expect(w.find('[data-test="ssh-title"]').exists()).toBe(false)
  expect(w.find('[data-test="btnRename"]').exists()).toBe(false)
  const win = mountTerm({ chrome: 'window', title: '生产机' })
  await flushPromises()
  expect(win.find('[data-test="ssh-title"]').exists()).toBe(false)
  expect(win.find('[data-test="btnRename"]').exists()).toBe(false)
})

test('page 档头部右轨道 max-content(右段永不压缩,手机重连态不叠压中段)', async () => {
  const w = mountTerm({ chrome: 'page', title: '生产机' })
  await flushPromises()
  expect(w.find('.grid').classes().join(' ')).toContain('max-content')
})

test('editable=false(无本地记录):✏️ 不渲染,双击不进编辑', async () => {
  const w = mountTerm({ chrome: 'page', title: '生产机', editable: false })
  await flushPromises()
  expect(w.find('[data-test="btnRename"]').exists()).toBe(false)
  expect(w.find('[data-test="ssh-title"]').exists()).toBe(true)
  await w.find('[data-test="ssh-title"]').trigger('dblclick')
  expect(w.find('input[data-test="ssh-title-input"]').exists()).toBe(false)
  expect(w.emitted('rename')).toBeUndefined()
})
