// headerless 模式契约(2026-09-08 单行头部收编):无标题栏;拖拽走事件委托
// ([data-window-drag] 区域,交互控件豁免);toggleMaximize 暴露 + maximize-change 同步。
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'

// 模拟无头宿主内容:头部带 data-window-drag,内含按钮;身体普通内容
const slots = {
  default: `<div class="h-full">
    <div data-window-drag class="cursor-move" data-test="drag-head">
      header-text
      <button data-test="head-btn">btn</button>
    </div>
    <div data-test="plain-body">body</div>
  </div>`,
}

function dragFrom(w, selector, ev = { clientX: 100, clientY: 100 }) {
  return w.find(selector).trigger('mousedown', ev)
}

describe('FloatingWindow headerless', () => {
  it('不渲染标题栏与壳层按钮;内容透传', () => {
    const w = mount(FloatingWindow, { props: { title: 'T', headerless: true }, slots })
    expect(w.find('[data-test="titlebar"]').exists()).toBe(false)
    expect(w.find('[data-test="btn-maximize"]').exists()).toBe(false)
    expect(w.find('[data-test="btn-minimize"]').exists()).toBe(false)
    expect(w.find('[data-test="btn-close"]').exists()).toBe(false)
    expect(w.find('[data-test="drag-head"]').exists()).toBe(true)
    w.unmount()
  })

  it('委托拖拽:[data-window-drag] 上 mousedown + mousemove 改 left/top', async () => {
    const w = mount(FloatingWindow, { props: { headerless: true }, slots, attachTo: document.body })
    await dragFrom(w, '[data-test="drag-head"]')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 160, clientY: 140 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '140px', top: '120px' })
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })

  it('拖拽区内按钮 mousedown 不启动拖拽(交互控件豁免)', async () => {
    const w = mount(FloatingWindow, { props: { headerless: true }, slots, attachTo: document.body })
    await dragFrom(w, '[data-test="head-btn"]')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 260, clientY: 240 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '80px' })   // 未移动
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })

  it('无标记的普通内容区 mousedown 不启动拖拽', async () => {
    const w = mount(FloatingWindow, { props: { headerless: true }, slots, attachTo: document.body })
    await dragFrom(w, '[data-test="plain-body"]')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 260, clientY: 240 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '80px' })
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })

  it('toggleMaximize 暴露:翻转 winStyle 并 emit maximize-change', async () => {
    const w = mount(FloatingWindow, { props: { headerless: true, zIndex: 7 }, slots, attachTo: document.body })
    expect(w.vm.winStyle).toMatchObject({ width: '720px' })
    w.vm.toggleMaximize()
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '268px', top: '72px', right: '8px', bottom: '44px', zIndex: 7 })
    const evts = w.emitted('maximize-change')
    expect(evts).toHaveLength(1)
    expect(evts[0]).toEqual([true])
    w.vm.toggleMaximize()
    await Promise.resolve()
    expect(w.emitted('maximize-change')[1]).toEqual([false])
    w.unmount()
  })

  it('最大化态下委托拖拽无效(isMax 守卫)', async () => {
    const w = mount(FloatingWindow, { props: { headerless: true }, slots, attachTo: document.body })
    w.vm.toggleMaximize()
    await Promise.resolve()
    await dragFrom(w, '[data-test="drag-head"]')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 400 }))
    await Promise.resolve()
    expect(w.vm.winStyle).toMatchObject({ left: '268px' })   // 仍铺满
    document.dispatchEvent(new MouseEvent('mouseup'))
    w.unmount()
  })
})
