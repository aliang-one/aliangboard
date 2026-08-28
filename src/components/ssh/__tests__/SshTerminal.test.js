// SSH 终端组件契约(Task 8):
// ① 回放帧(CH_REPLAY=6)先于直播写入 xterm,replayed 徽标亮起,不触发重连;
// ② onError → 状态 error,重连按钮用同一 sid 重建流(网关回放续跑)。
// mock 策略照 InteractiveTerminal.auto.test.js:@/api/client 捕获 sshTerminalStream 入参;xterm 三件套桩掉。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => [])
vi.mock('@/api/client', () => ({
  sshTerminalStream: vi.fn(opts => { calls.push(opts); return { send() {}, resize() {}, close() {}, isOpen: true } }),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class { constructor() { this.cols = 80; this.rows = 24 } open() {} write() {} writeln() {} onData() {} onResize() {} loadAddon() {} focus() {} dispose() {} },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

import SshTerminal from '../SshTerminal.vue'

const mountTerm = () => mount(SshTerminal, {
  props: { serverId: 'sv1', serverName: 'web-1', sid: 'sid-1', autoConnect: true },
  global: { plugins: [i18n] },
})
beforeEach(() => { calls.length = 0 })

test('回放先于直播:CH_REPLAY 写入 xterm、徽标亮起、不产生第二次连接', async () => {
  const w = mountTerm()
  await flushPromises()
  expect(calls.length).toBe(1)
  calls[0].onReplay(new TextEncoder().encode('old line\n'))
  calls[0].onStdout(new TextEncoder().encode('live\n'))
  await flushPromises()
  expect(calls.length).toBe(1)                       // 回放不触发重连
  expect(w.find('[data-test="replayBadge"]').exists()).toBe(true)
  expect(w.vm.replayed).toBe(true)
})

test('onError → 状态 error 展示重连按钮;重连同 sid(网关回放续跑)', async () => {
  const w = mountTerm()
  await flushPromises()
  calls[0].onError('boom')
  await flushPromises()
  expect(w.find('[data-test="btnReconnect"]').exists()).toBe(true)
  expect(w.html()).toContain(i18n.global.t('ssh.reconnect'))
  await w.find('[data-test="btnReconnect"]').trigger('click')
  await flushPromises()
  expect(calls.length).toBe(2)
  expect(calls[1].sid).toBe('sid-1')                  // sid 不变 → 网关保活会话回放续跑
})
