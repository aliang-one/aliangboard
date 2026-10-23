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
  Terminal: class { constructor() { this.cols = 80; this.rows = 24 } open() {} write() {} writeln() {} onData() {} onResize() {} loadAddon() {} attachCustomKeyEventHandler() {} hasSelection() { return false } focus() {} dispose() {} },
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

// 居中会话名(2026-10-23):弹窗页头部三段式——左=身份信息,中=会话名(双击/✏️ 改名),右=状态钮。
// 会话名来自宿主(弹窗页按 store 记录解析后传 title),改名 emit rename 由宿主落 store。
describe("chrome='page' 居中会话名+改名", () => {
  test('title 渲染在中段(term-title);双击进编辑,回车 emit rename;Esc 取消', async () => {
    const w = mountTerm({ chrome: 'page', title: '我的终端' })
    const ttl = w.find('[data-test="term-title"]')
    expect(ttl.exists()).toBe(true)
    expect(ttl.text()).toBe('我的终端')
    await ttl.trigger('dblclick')
    const input = w.find('input[data-test="term-title-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('新名')
    await input.trigger('keydown.enter')
    expect(w.emitted('rename')).toEqual([['新名']])
    // Esc 分支:进编辑后取消,不 emit
    await w.find('[data-test="term-title"]').trigger('dblclick')
    await w.find('input[data-test="term-title-input"]').trigger('keydown.esc')
    expect(w.emitted('rename')).toHaveLength(1)
  })
  test('✏️ 钮点击同样进入编辑(hover 显隐配方,max-sm 常显)', async () => {
    const w = mountTerm({ chrome: 'page', title: '我的终端' })
    const btn = w.find('[data-test="btn-rename"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes().join(' ')).toContain('max-sm:opacity-100')
    await btn.trigger('click')
    expect(w.find('input[data-test="term-title-input"]').exists()).toBe(true)
  })
  test('编辑态输入框在中段(左段身份信息不被顶替);无 title 不渲染中段', async () => {
    const w = mountTerm({ chrome: 'page', title: '我的终端' })
    await w.find('[data-test="term-title"]').trigger('dblclick')
    // 输入框在中段容器内,左段 pod:container 信息仍可见
    const centerInputs = w.findAll('input[data-test="term-title-input"]')
    expect(centerInputs).toHaveLength(1)
    expect(w.html()).toContain('web-1:main')
    const w2 = mountTerm({ chrome: 'page' })
    expect(w2.find('[data-test="term-title"]').exists()).toBe(false)
    expect(w2.find('[data-test="btn-rename"]').exists()).toBe(false)
    expect(w2.html()).toContain('web-1:main')
  })
  test('浮窗档不变:title 仍在左段且只有一个 term-title', () => {
    const w = mountTerm({ chrome: 'window', title: 'web-1/main #2' })
    expect(w.find('[data-test="term-title"]').exists()).toBe(true)
    expect(w.find('[data-test="btn-rename"]').exists()).toBe(false)
  })
  test('page 档头部三段 grid:右轨道 max-content(右段永不压缩,挤压由左/中 truncate 吸收)', () => {
    const w = mountTerm({ chrome: 'page', title: '我的终端' })
    expect(w.find('[data-window-drag]').exists()).toBe(false)
    expect(w.find('.grid').classes().join(' ')).toContain('max-content')
  })
  test('editable=false(无本地记录):✏️ 不渲染,双击不进编辑(防「能看不能改还无声失败」)', async () => {
    const w = mountTerm({ chrome: 'page', title: '我的终端', editable: false })
    expect(w.find('[data-test="btn-rename"]').exists()).toBe(false)
    expect(w.find('[data-test="term-title"]').exists()).toBe(true)   // 名字仍展示
    await w.find('[data-test="term-title"]').trigger('dblclick')
    expect(w.find('input[data-test="term-title-input"]').exists()).toBe(false)
    expect(w.emitted('rename')).toBeUndefined()
  })
})
