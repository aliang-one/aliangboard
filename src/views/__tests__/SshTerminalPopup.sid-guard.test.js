import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 回归:弹窗页此前 `sid = route.query.sid || ''` 兜底 → 空 sid 一路传到网关,旧网关
// 现场随机补位造出「客户端永远不知 sid」的孤儿会话(2026-08-29 泄漏审计出生通道之一)。
// 现在:组件侧缺 sid 渲染错误态不建连;网关侧缺 sid 硬拒绝(ws-handshake.test.mjs 钉住)。

const state = vi.hoisted(() => ({ query: { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' } }))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: state.query }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: { name: 'SshTerminal', template: '<div data-test="term-stub" />' },
}))

import SshTerminalPopup from '../SshTerminalPopup.vue'

describe('SshTerminalPopup sid 守卫', () => {
  it('URL 带 sid → 正常挂载 SshTerminal', () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
    const w = mount(SshTerminalPopup)
    expect(w.findComponent({ name: 'SshTerminal' }).exists()).toBe(true)
  })

  it('URL 缺 sid → 错误态,绝不挂载 SshTerminal(防静默建连)', () => {
    state.query = { serverId: 'sv1', sid: '', name: 'gw-1' }
    const w = mount(SshTerminalPopup)
    expect(w.findComponent({ name: 'SshTerminal' }).exists()).toBe(false)
    expect(w.find('[data-test="sid-missing"]').exists()).toBe(true)
  })
})
