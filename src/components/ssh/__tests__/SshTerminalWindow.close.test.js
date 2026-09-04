import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// 2026-09-04 关闭钮迁移集成:壳层(FloatingWindow)关闭钮隐藏,关闭入口收敛到终端头部,
// 点击走 sshStore.closeWindow(杀网关会话=显式关闭按钮专属语义)。

const state = vi.hoisted(() => ({}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
// vue-i18n 全 mock 会使 store→client→http→i18n 链拿到残缺模块,client 必须一并局部 mock
vi.mock('@/api/client', () => ({ sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })) } }))
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { closable: Boolean },   // Boolean 声明:裸属性 closable 经布尔转型应为 true
    template: '<div data-test="term-stub" @click="$emit(\'close\')" />',
    emits: ['close'],
  },
}))

import SshTerminalWindow from '../SshTerminalWindow.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { sshApi } from '@/api/client'

describe('SshTerminalWindow 关闭钮迁移', () => {
  it('壳层关闭钮隐藏;终端头部关闭钮打开并接 closeWindow;标题不再重复 ssh://名', async () => {
    setActivePinia(createPinia())
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web-1' })
    const wrapper = mount(SshTerminalWindow, { props: { window: w } })

    // 壳层:close 钮不渲染;minimize/focus 保留
    expect(wrapper.find('[data-test="btn-close"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="btn-minimize"]').exists()).toBe(true)
    // 标题去重:titlebar 文本不再含 ssh:// 前缀(终端头部自带)
    expect(wrapper.find('[data-test="titlebar"]').text()).not.toContain('ssh://')
    // 终端组件:closable 打开
    expect(wrapper.findComponent({ name: 'SshTerminal' }).props('closable')).toBe(true)

    // 点终端头部的关闭钮 → closeWindow:记录摘除 + 网关会话回收(显式关闭)
    await wrapper.find('[data-test="term-stub"]').trigger('click')
    expect(store.windows.length).toBe(0)
    await Promise.resolve()
    expect(sshApi.killSession).toHaveBeenCalledWith(w.id)
  })
})
