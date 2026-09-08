// SSH 终端组件契约(Task 8):
// ① 回放帧(CH_REPLAY=6)先于直播写入 xterm,replayed 徽标亮起,不触发重连;
// ② onError → 状态 error,重连按钮用同一 sid 重建流(网关回放续跑)。
// mock 策略照 InteractiveTerminal.auto.test.js:@/api/client 捕获 sshTerminalStream 入参;xterm 三件套桩掉。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const calls = vi.hoisted(() => [])
const writes = vi.hoisted(() => [])
vi.mock('@/api/client', () => ({
  sshTerminalStream: vi.fn(opts => { calls.push(opts); return { send() {}, resize() {}, close() {}, isOpen: true } }),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() { this.cols = 80; this.rows = 24 }
    open() {}
    write(d) { writes.push(typeof d === 'string' ? d : new TextDecoder().decode(d)) }
    writeln(d) { writes.push((typeof d === 'string' || d == null ? d ?? '' : new TextDecoder().decode(d)) + '\n') }
    onData() {} onResize() {} loadAddon() {} focus() {} dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

import SshTerminal from '../SshTerminal.vue'

const mountTerm = () => mount(SshTerminal, {
  props: { serverId: 'sv1', serverName: 'web-1', sid: 'sid-1', autoConnect: true },
  global: { plugins: [i18n] },
})
beforeEach(() => { calls.length = 0; writes.length = 0 })

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

// —— 断线自动重连(2026-09-08 线上事故:WS 瞬断被显示成「会话结束」,用户被迫手动刷新)——
// 契约:曾成功 open 的流断开 → reconnecting 态 + 指数退避(1s 起)同 sid 自动重连;
// CH_ERROR 终态与从未 open 的握手失败不自动重连;重连成功(onOpen)重置退避并提示已恢复。
test('断开自动重连:onOpen 后 onClose → reconnecting,1s 后同 sid 二连', async () => {
  vi.useFakeTimers()
  try {
    const w = mountTerm()
    await flushPromises()
    calls[0].onOpen()
    calls[0].onClose()
    await flushPromises()
    expect(w.vm.status).toBe('reconnecting')
    expect(calls.length).toBe(1)
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(calls.length).toBe(2)
    expect(calls[1].sid).toBe('sid-1')
  } finally { vi.useRealTimers() }
})

test('指数退避:连续失败第二次等待翻倍(1s → 2s)', async () => {
  vi.useFakeTimers()
  try {
    mountTerm()
    await flushPromises()
    calls[0].onOpen()
    // 第一次断开 → 1s 后重连
    calls[0].onClose(); await flushPromises()
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(2)
    // 重连尝试握手失败(未 onOpen 即 close,如 502 闪断)→ 计入退避,2s 后再连(1s 时点不应连)
    calls[1].onClose(); await flushPromises()
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(2)
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(3)
  } finally { vi.useRealTimers() }
})

test('重连成功提示「已重新连接」;退避须过稳定窗(15s)才清零', async () => {
  vi.useFakeTimers()
  try {
    const w = mountTerm()
    await flushPromises()
    calls[0].onOpen(); calls[0].onClose(); await flushPromises()
    vi.advanceTimersByTime(1000); await flushPromises()
    calls[1].onOpen(); await flushPromises()
    expect(w.vm.status).toBe('open')
    expect(writes.some(x => x.includes(i18n.global.t('terminal.reconnected')))).toBe(true, '终端应写入「已重新连接」')
    // 稳定窗内闪断:退避不清零(attempts 累计到 2)→ 下一轮等 2s 而非 1s
    calls[1].onClose(); await flushPromises()
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(2, '1s 时点不应连(退避已升级)')
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(3)
    // 熬过稳定窗后退避清零:新断开又从 1s 起
    calls[2].onOpen(); await flushPromises()
    vi.advanceTimersByTime(15000); await flushPromises()
    calls[2].onClose(); await flushPromises()
    vi.advanceTimersByTime(1000); await flushPromises()
    expect(calls.length).toBe(4, '稳定窗后清零:新断开仍 1s 起')
  } finally { vi.useRealTimers() }
})

test('CH_ERROR 终态不自动重连;从未 open 的握手失败同样不重连', async () => {
  vi.useFakeTimers()
  try {
    const w = mountTerm()
    await flushPromises()
    calls[0].onOpen()
    calls[0].onError('channel closed')
    await flushPromises()
    expect(w.vm.status).toBe('error')
    vi.advanceTimersByTime(60000)
    await flushPromises()
    expect(calls.length).toBe(1, 'error 态不自动重连')

    await w.find('[data-test="btnReconnect"]').trigger('click')   // 手动重连回到 connecting
    await flushPromises()
    expect(calls.length).toBe(2)
    calls[1].onClose()   // 从未 onOpen(握手失败,如 401/502)
    await flushPromises()
    expect(w.vm.status).toBe('closed')
    vi.advanceTimersByTime(60000)
    await flushPromises()
    expect(calls.length).toBe(2, '握手失败不自动重连')
  } finally { vi.useRealTimers() }
})
