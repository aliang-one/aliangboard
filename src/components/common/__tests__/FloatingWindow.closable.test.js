import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'

// 2026-09-04 关闭语义收敛:SSH 浮窗的关闭钮迁入终端头部后,壳层关闭钮要能按需隐藏
// (closable=false),其余消费方(pod 终端/文件窗口)默认 true 零回归。

const mountWin = (props = {}) => mount(FloatingWindow, { props, slots: { default: '<div>body</div>' } })

describe('FloatingWindow closable', () => {
  it('默认可关:btn-close 存在(壳层既有行为零回归)', () => {
    const w = mountWin()
    expect(w.find('[data-test="btn-close"]').exists()).toBe(true)
  })

  it('closable=false:btn-close 不渲染,最小化/最大化不受影响', async () => {
    const w = mountWin({ closable: false })
    expect(w.find('[data-test="btn-close"]').exists()).toBe(false)
    expect(w.find('[data-test="btn-minimize"]').exists()).toBe(true)
    expect(w.find('[data-test="btn-maximize"]').exists()).toBe(true)
    await w.find('[data-test="btn-minimize"]').trigger('click')
    expect(w.emitted('minimize')).toHaveLength(1)
  })
})
