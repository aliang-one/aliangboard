// 壳组件契约:按钮 emits/最大化切换/拖拽位移/slot 透传。
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'

const props = { title: 'T', zIndex: 42 }

describe('FloatingWindow', () => {
  it('最小化/关闭按钮 emit;mousedown emit focus', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    await w.find('[data-test="btn-minimize"]').trigger('click')
    await w.find('[data-test="btn-close"]').trigger('click')
    await w.find('[data-test="window"]').trigger('mousedown')
    expect(w.emitted('minimize')).toHaveLength(1)
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('focus')).toHaveLength(1)
    w.unmount()
  })
  it('最大化切换:winStyle 从定位尺寸变为 inset 铺满', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    expect(w.vm.winStyle).toMatchObject({ left: '80px', width: '720px' })
    await w.find('[data-test="btn-maximize"]').trigger('click')
    // 2026-08-17:最大化避让应用骨架——侧栏 260/顶栏 64(sticky z-50,标题栏不再被压)/任务栏 32
    expect(w.vm.winStyle).toMatchObject({ left: '268px', top: '72px', right: '8px', bottom: '44px', zIndex: 42 })
    w.unmount()
  })
  it('拖拽:标题栏 mousedown + document mousemove 改 left/top', async () => {
    const w = mount(FloatingWindow, { props, attachTo: document.body })
    await w.find('[data-test="titlebar"]').trigger('mousedown', { clientX: 100, clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '140px', top: '120px' })
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })
  it('slots:default 与 title-actions 渲染', () => {
    const w = mount(FloatingWindow, {
      props,
      slots: { default: '<div id="body">BODY</div>', 'title-actions': '<button id="x">X</button>' },
    })
    expect(w.find('#body').exists()).toBe(true)
    expect(w.find('#x').exists()).toBe(true)
  })
})
