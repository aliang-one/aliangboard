import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 2026-09-04 关闭语义收敛 + 2026-09-08 单行头部收编:外部顶条退役,终端头部红点
// (chrome='page')成为该标签页唯一杀会话入口——点击 = 杀网关会话 + 关标签页;
// F5/标签页丢弃(pagehide)只发墓碑摘本地记录,绝不杀会话。
// 2026-10-04 补完:红点显式关闭还须摘全端记录(store.closeWindow 跨页墓碑+merge-on-write
// persist → 主页面 storage 对账摘 chip)——此前弹窗只杀会话+关窗,任务栏 chip 永挂,
// 点开才知已死(v2 收敛注释「记录移除唯一入口=显式关闭(弹窗『关闭窗口』…)」一直没接线)。

const state = vi.hoisted(() => ({ query: { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' } }))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: state.query }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
// vue-i18n 全 mock 会使 client→http→i18n 链拿到残缺模块,client 必须一并局部 mock;
// 2026-10-04 popup 增 import genSid(@/stores/sshTerminals) → store 链同样会被残缺 mock 炸,一并局部 mock
vi.mock('@/api/client', () => ({ sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })) } }))
vi.mock('@/stores/sshTerminals', () => ({
  genSid: vi.fn(() => 'ssh-x'),
  useSshTerminalStore: vi.fn(() => ({ closeWindow: state.closeWindow })),
}))
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { chrome: [Boolean, String] },
    template: '<div data-test="term-stub" @click="$emit(\'win-close\')" />',
    emits: ['win-close'],
  },
}))

import SshTerminalPopup from '../SshTerminalPopup.vue'

state.closeWindow = vi.fn()

describe('SshTerminalPopup 红点关窗(单行头部收编)', () => {
  it('终端 chrome=page;红点(win-close):走 store.closeWindow(杀网关会话+跨页摘记录)再关标签页', async () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
    const realClose = window.close
    window.close = vi.fn()
    try {
      const w = mount(SshTerminalPopup)
      expect(w.findComponent({ name: 'SshTerminal' }).props('chrome')).toBe('page')
      await w.find('[data-test="term-stub"]').trigger('click')
      expect(state.closeWindow).toHaveBeenCalledWith('ssh-abc')
      expect(window.close).toHaveBeenCalled()
    } finally {
      window.close = realClose
      vi.clearAllMocks()
    }
  })

  it('缺 sid(错误态)点红点:绝不调 store.closeWindow(守卫在 handler),仅尝试关标签页', async () => {
    state.query = { serverId: 'sv1', sid: '', name: 'gw-1' }
    const realClose = window.close
    window.close = vi.fn()
    try {
      const w = mount(SshTerminalPopup)
      // sid 缺失:错误态屏替代终端,无红点可点;守卫仍在 handler(防未来接线回归),直接调用路径已不可达
      expect(w.find('[data-test="sid-missing"]').exists()).toBe(true)
      expect(w.find('[data-test="term-stub"]').exists()).toBe(false)
      expect(state.closeWindow).not.toHaveBeenCalled()
    } finally {
      window.close = realClose
      vi.clearAllMocks()
    }
  })
})
