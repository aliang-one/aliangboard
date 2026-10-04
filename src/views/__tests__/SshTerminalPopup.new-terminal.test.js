import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// 2026-10-04「+」新建终端:独立标签页顶栏按钮 → window.open 新标签页,继承当前服务器 +
// SshTerminal 旁路维护的 lastCwd(拿不到就不带 cwd,新终端降级默认登录目录)。

const state = vi.hoisted(() => ({ query: {}, lastCwd: '' }))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: state.query }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
// vue-i18n 全 mock 会使 client→http→i18n 链拿到残缺模块,client 一并局部 mock
vi.mock('@/api/client', () => ({ sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })) } }))
vi.mock('@/stores/sshTerminals', () => ({ genSid: vi.fn(() => 'ssh-fixed-new') }))

// stub:透传 props 供断言;点击模拟「+」;expose lastCwd 供弹窗读取
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { serverId: String, serverName: String, sid: String, autoConnect: Boolean, chrome: [Boolean, String], cwd: String },
    emits: ['win-close', 'new-terminal'],
    setup(_, { expose }) {
      const lastCwd = ref(state.lastCwd)
      expose({ lastCwd })
      return { lastCwd }
    },
    template: `<div data-test="term-stub" @click="$emit('new-terminal')" />`,
  },
}))

import SshTerminalPopup from '../SshTerminalPopup.vue'

const withSpiedOpen = async fn => {
  const realOpen = window.open
  window.open = vi.fn(() => ({}))
  try {
    const w = mount(SshTerminalPopup)
    await w.find('[data-test="term-stub"]').trigger('click')
    await Promise.resolve()
    fn(w)
  } finally {
    window.open = realOpen
    vi.clearAllMocks()
  }
}

describe('SshTerminalPopup「+」新建终端', () => {
  it('点击「+」→ window.open 新标签页:同服务器 + 新 sid + cwd=lastCwd(窗口名=新 sid)', async () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
    state.lastCwd = '/srv/app'
    await withSpiedOpen(() => {
      const [url, name] = window.open.mock.calls[0]
      expect(url).toContain('/ssh-terminal-popup?')
      expect(url).toContain('serverId=sv1')
      expect(url).toContain('sid=ssh-fixed-new')
      expect(url).not.toContain('sid=ssh-abc')          // 恒新 sid,绝不含本会话
      expect(url).toContain('cwd=%2Fsrv%2Fapp')         // 当前目录继承
      expect(name).toBe('ssh-fixed-new')                // 确定性窗口名(浏览器复用/聚焦语义)
    })
  })

  it('lastCwd 未知(远端未上报标题)→ URL 不带 cwd:新终端降级默认登录目录,按钮照常可用', async () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1' }
    state.lastCwd = ''
    await withSpiedOpen(() => {
      const [url] = window.open.mock.calls[0]
      expect(url).toContain('sid=ssh-fixed-new')
      expect(url).not.toContain('cwd=')
    })
  })

  it('URL 带 cwd query → 作为起始目录透传给 SshTerminal(服务端属主首建时注入 cd)', async () => {
    state.query = { serverId: 'sv1', sid: 'ssh-abc', name: 'gw-1', cwd: '/srv/app' }
    state.lastCwd = ''
    const realOpen = window.open
    window.open = vi.fn()
    try {
      const w = mount(SshTerminalPopup)
      expect(w.findComponent({ name: 'SshTerminal' }).props('cwd')).toBe('/srv/app')
    } finally {
      window.open = realOpen
      vi.clearAllMocks()
    }
  })
})
