// openExternal 新标签页 URL 必须携带稳定 sid(= terminal.id):
// 网关 planExec 以 sid 判持久性(tmux 会话名 = label(token)-sid),弹窗页此前不传 sid
// → 网关降级一次性 exec,角标恒「⚠ 刷新不保留」——与浮动窗口(传 terminal.id,tmux 承载)
// 行为劈叉。修复:openExternal 把 sid 写进 URL,TerminalPopup 回传给 InteractiveTerminal。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const termListMock = vi.fn()
vi.mock('@/api/client', () => ({
  getSessionToken: () => 'test-token',
  terminalApi: { list: (...a) => termListMock(...a), create: async () => {}, update: async () => {}, remove: async () => {} },
  fileBrowserApi: { list: async () => ({ browsers: [] }), create: async () => {}, update: async () => {}, remove: async () => {} },
}))

import { useTerminalStore } from '@/stores/terminals'

const _open = window.open
beforeEach(() => {
  setActivePinia(createPinia())
  termListMock.mockReset().mockResolvedValue({ terminals: [] })
  window.open = vi.fn(() => ({ closed: true, focus: () => {} }))
})
afterEach(() => { window.open = _open })

test('openExternal:弹窗 URL 携带 sid=<terminal.id>,刷新/重开可 attach 回同一 tmux 会话', () => {
  const store = useTerminalStore()
  const term = store.openTerminal({ namespace: 'ns1', podName: 'pod-a', container: 'main' })
  store.openExternal(term.id)
  expect(window.open).toHaveBeenCalledTimes(1)
  const url = window.open.mock.calls[0][0]
  expect(url).toContain('/terminal-popup?')
  expect(url).toContain(`sid=${term.id}`)
})
