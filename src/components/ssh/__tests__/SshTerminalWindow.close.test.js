import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// 2026-09-08 单行头部收编集成:壳层(FloatingWindow)标题栏整体退役(headerless),
// 窗口控制收敛到终端头部 ●●●;红点点击走 sshStore.closeWindow(杀网关会话=显式关闭
// 按钮专属语义)。2026-09-04 关闭钮迁移的升级版。

const state = vi.hoisted(() => ({}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: k => k }) }))
// vue-i18n 全 mock 会使 store→client→http→i18n 链拿到残缺模块,client 必须一并局部 mock
vi.mock('@/api/client', () => ({ sshApi: { killSession: vi.fn(() => Promise.resolve({ ok: true })) } }))
vi.mock('@/components/ssh/SshTerminal.vue', () => ({
  default: {
    name: 'SshTerminal',
    props: { chrome: [Boolean, String], autoConnect: Boolean, maximized: Boolean },
    template: '<div data-test="term-stub" @click="$emit(\'win-close\')" />',
    emits: ['win-close', 'win-minimize', 'win-maximize', 'open-external'],
  },
}))

import SshTerminalWindow from '../SshTerminalWindow.vue'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { sshApi } from '@/api/client'

describe('SshTerminalWindow 单行头部收编', () => {
  it('壳层标题栏整体退役(headerless);终端 chrome=window;红点 → closeWindow(杀会话+摘记录)', async () => {
    setActivePinia(createPinia())
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web-1' })
    const wrapper = mount(SshTerminalWindow, { props: { window: w } })

    // 壳层:标题栏/最小化/关闭钮全部不渲染(无头)
    expect(wrapper.find('[data-test="titlebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="btn-minimize"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="btn-close"]').exists()).toBe(false)
    // 终端:chrome='window'
    expect(wrapper.findComponent({ name: 'SshTerminal' }).props('chrome')).toBe('window')

    // 点终端头部红点(win-close)→ closeWindow:记录摘除 + 网关会话回收(显式关闭)
    await wrapper.find('[data-test="term-stub"]').trigger('click')
    expect(store.windows.length).toBe(0)
    await Promise.resolve()
    expect(sshApi.killSession).toHaveBeenCalledWith(w.id)
  })

  it('黄点(win-minimize)→ minimizeWindow:记录留在任务栏', async () => {
    setActivePinia(createPinia())
    const store = useSshTerminalStore()
    const w = store.openNew({ id: 'sv1', name: 'web-1' })
    const wrapper = mount(SshTerminalWindow, { props: { window: w } })
    wrapper.findComponent({ name: 'SshTerminal' }).vm.$emit('win-minimize')
    await Promise.resolve()
    expect(store.windows.length).toBe(1)
    expect(store.windows[0].status).toBe('minimized')
  })
})

describe('SshTerminalWindow 挂载即连门控(2026-09-04 事故③)', () => {
  it('open 挂载建连(true);minimized 挂载不建连(false)', () => {
    setActivePinia(createPinia())
    const store = useSshTerminalStore()
    const open = store.openNew({ id: 'sv1', name: 'web' })
    const wOpen = mount(SshTerminalWindow, { props: { window: open } })
    expect(wOpen.findComponent({ name: 'SshTerminal' }).props('autoConnect')).toBe(true)
    wOpen.unmount()
    const min = store.openNew({ id: 'sv2', name: 'db' })
    min.status = 'minimized'
    const wMin = mount(SshTerminalWindow, { props: { window: min } })
    expect(wMin.findComponent({ name: 'SshTerminal' }).props('autoConnect')).toBe(false)
    wMin.unmount()
  })
})
