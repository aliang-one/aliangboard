import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 2026-09-04 关闭语义收敛 + 2026-09-08 单行头部收编:外部顶条退役,终端头部红点
// (chrome='page')成为该标签页唯一杀会话入口——点击 = 杀网关会话 + 关标签页;
// F5/标签页丢弃(pagehide)只发墓碑摘本地记录,绝不杀会话。

const state = vi.hoisted(() => ({ query: { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' } }))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: state.query }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
// vue-i18n 全 mock 会使 client→http→i18n 链拿到残缺模块,client 必须一并局部 mock
vi.mock('@/api/client', () => ({ sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })) } }))
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { chrome: [Boolean, String] },
    template: '<div data-test="term-stub" @click="$emit(\'win-close\')" />',
    emits: ['win-close'],
  },
}))

import SshTerminalPopup from '../SshTerminalPopup.vue'
import { sshApi } from '@/api/client'

describe('SshTerminalPopup 红点关窗(单行头部收编)', () => {
  it('终端 chrome=page;红点(win-close):先杀网关会话(带 sid)再关标签页', async () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
    const realClose = window.close
    window.close = vi.fn()
    try {
      const w = mount(SshTerminalPopup)
      expect(w.findComponent({ name: 'SshTerminal' }).props('chrome')).toBe('page')
      await w.find('[data-test="term-stub"]').trigger('click')
      expect(sshApi.killSession).toHaveBeenCalledWith('ssh-abc')
      expect(window.close).toHaveBeenCalled()
    } finally {
      window.close = realClose
      vi.clearAllMocks()
    }
  })

  it('缺 sid(错误态)点红点:绝不发 kill(守卫在 handler),仅尝试关标签页', async () => {
    state.query = { serverId: 'sv1', sid: '', name: 'gw-1' }
    const realClose = window.close
    window.close = vi.fn()
    try {
      const w = mount(SshTerminalPopup)
      // sid 缺失:错误态屏替代终端,无红点可点;守卫仍在 handler(防未来接线回归),直接调用路径已不可达
      expect(w.find('[data-test="sid-missing"]').exists()).toBe(true)
      expect(w.find('[data-test="term-stub"]').exists()).toBe(false)
      expect(sshApi.killSession).not.toHaveBeenCalled()
    } finally {
      window.close = realClose
      vi.clearAllMocks()
    }
  })
})
