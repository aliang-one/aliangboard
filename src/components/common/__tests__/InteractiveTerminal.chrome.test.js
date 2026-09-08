// chrome 模式契约(2026-09-08 单行头部收编):
// false(默认,PodDetail 内嵌)= 现状装饰圆点、无窗口控制;
// 'window'(浮窗)= ●●● 变真按钮(红关/黄最小化/绿最大化)+ 头部即拖拽把手(data-window-drag)
//   + open_in_new 迁入 + 双击改名;idle 态也渲染头部(否则未连接浮窗无窗口钮可点);
// 'page'(独立标签页)= 仅红点(关窗),黄绿不渲染,不可拖。
import { test, expect, vi, describe, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  execStream: vi.fn(() => ({ send() {}, resize() {}, close() {}, isOpen: true })),
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({}) }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class { constructor() { this.cols = 80; this.rows = 24 } open() {} write() {} writeln() {} onData() {} onResize() {} loadAddon() {} focus() {} dispose() {} },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

import InteractiveTerminal from '../InteractiveTerminal.vue'

function mountTerm(props = {}) {
  setActivePinia(createPinia())
  return mount(InteractiveTerminal, {
    props: { podName: 'web-1', namespace: 'default', container: 'main', sessionId: 't1', ...props },
    global: { plugins: [i18n] },
  })
}

beforeEach(() => { vi.clearAllMocks() })

describe('chrome=false(默认,PodDetail 内嵌)', () => {
  test('圆点仍是装饰 span,无窗口按钮/拖拽标记/新标签页钮', async () => {
    const w = mountTerm({ autoConnect: true })
    await flushPromises()
    expect(w.find('[data-test="dot-close"]').exists()).toBe(false)
    expect(w.find('[data-test="dot-minimize"]').exists()).toBe(false)
    expect(w.find('[data-test="dot-maximize"]').exists()).toBe(false)
    expect(w.find('[data-test="btn-open-external"]').exists()).toBe(false)
    expect(w.find('[data-window-drag]').exists()).toBe(false)
    // 装饰圆点仍在(w-2.5 纯色点)
    expect(w.findAll('.w-2\\.5').length).toBe(3)
  })
})

describe("chrome='window'(浮窗)", () => {
  test('三圆点变按钮,emit win-close/win-minimize/win-maximize', async () => {
    const w = mountTerm({ chrome: 'window', title: 'web-1/main #2' })
    await w.find('[data-test="dot-close"]').trigger('click')
    await w.find('[data-test="dot-minimize"]').trigger('click')
    await w.find('[data-test="dot-maximize"]').trigger('click')
    expect(w.emitted('win-close')).toHaveLength(1)
    expect(w.emitted('win-minimize')).toHaveLength(1)
    expect(w.emitted('win-maximize')).toHaveLength(1)
  })
  test('头部即拖拽把手(data-window-drag)+ idle 态也渲染头部(未连接浮窗仍可关/最小化)', () => {
    const w = mountTerm({ chrome: 'window', title: 'web-1/main' })
    expect(w.find('[data-window-drag]').exists()).toBe(true)
    expect(w.find('[data-test="dot-close"]').exists()).toBe(true)   // idle(autoConnect 未给)下也在
  })
  test('open_in_new 迁入头部,emit open-external', async () => {
    const w = mountTerm({ chrome: 'window' })
    await w.find('[data-test="btn-open-external"]').trigger('click')
    expect(w.emitted('open-external')).toHaveLength(1)
  })
  test('title 显示 + 双击改名:输入回车 emit rename;Esc 取消', async () => {
    const w = mountTerm({ chrome: 'window', title: 'web-1/main #2' })
    expect(w.html()).toContain('web-1/main #2')
    await w.find('[data-test="term-title"]').trigger('dblclick')
    const input = w.find('input[data-test="term-title-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('renamed')
    await input.trigger('keydown.enter')
    expect(w.emitted('rename')).toEqual([['renamed']])
    // Esc 分支:改名框出现后取消,不再 emit
    await w.find('[data-test="term-title"]').trigger('dblclick')
    await w.find('input[data-test="term-title-input"]').trigger('keydown.esc')
    expect(w.emitted('rename')).toHaveLength(1)
  })
  test('maximized 透传:绿点字形切换 fullscreen/fullscreen_exit', async () => {
    const w = mountTerm({ chrome: 'window', maximized: false })
    expect(w.find('[data-test="dot-maximize"]').text()).toContain('fullscreen')
    await w.setProps({ maximized: true })
    expect(w.find('[data-test="dot-maximize"]').text()).toContain('fullscreen_exit')
  })
})

describe("chrome='page'(独立标签页)", () => {
  test('仅红点,黄绿/拖拽/open_in_new 均无;红点 emit win-close', async () => {
    const w = mountTerm({ chrome: 'page' })
    expect(w.find('[data-test="dot-close"]').exists()).toBe(true)
    expect(w.find('[data-test="dot-minimize"]').exists()).toBe(false)
    expect(w.find('[data-test="dot-maximize"]').exists()).toBe(false)
    expect(w.find('[data-window-drag]').exists()).toBe(false)
    expect(w.find('[data-test="btn-open-external"]').exists()).toBe(false)
    await w.find('[data-test="dot-close"]').trigger('click')
    expect(w.emitted('win-close')).toHaveLength(1)
  })
})
