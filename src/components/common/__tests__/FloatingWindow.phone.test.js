// src/components/common/__tests__/FloatingWindow.phone.test.js
// Wave5 W1 Task1(R1):浮窗手机铺满——390px 下不再出屏/不可控。
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

function styleOf(w) { return w.find('[data-test="window"]').attributes('style') || '' }

// happy-dom 的 CSS 解析器拒绝任何含 var() 的属性值(style.left= / setProperty / cssText 三路
// 全部静默丢弃,calc(260px+8px) 纯数字反而收)→ style attribute 读不回 calc 表达式。
// 这里借 CSSStyleDeclaration 原型访问器捕获 Vue 实际赋给 left 的原始字符串再断言;
// 断言内容不变(仍锚 calc(var(--sb-width, 260px) + 8px)),只换观测通道。
async function captureLeft(fn) {
  const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'left')
  const seen = []
  Object.defineProperty(CSSStyleDeclaration.prototype, 'left', {
    ...desc,
    set(v) { seen.push(String(v)); desc.set.call(this, v) },
  })
  try {
    await fn()
    return seen
  } finally {
    Object.defineProperty(CSSStyleDeclaration.prototype, 'left', desc)
  }
}

describe('FloatingWindow 手机铺满(R1)', () => {
  it('桌面档:常规定位/尺寸/最大化 left 消费 --sb-width(回归锚)', () => {
    const w = mount(FloatingWindow, { props: { width: '720px', height: '460px' } })
    expect(styleOf(w)).toContain('width: 720px')
    expect(styleOf(w)).toContain('left: 80px')
    w.unmount()
  })

  it('桌面档最大化:left 用 calc(var(--sb-width,260px)+8px) 取代硬编码 268px', async () => {
    let w
    const seen = await captureLeft(async () => {
      w = mount(FloatingWindow, { props: {} })
      await w.find('[data-test="btn-maximize"]').trigger('click')
    })
    expect(seen).toContain('calc(var(--sb-width, 260px) + 8px)')
    expect(seen).not.toContain('268px')
    w.unmount()
  })

  it('手机档:忽略 width/pos,inset 8px 铺满;最大化同款', async () => {
    const spy = mockViewport(true)
    try {
      const w = mount(FloatingWindow, { props: { width: '720px' } })
      const s = styleOf(w)
      expect(s).toContain('left: 8px'); expect(s).toContain('right: 8px')
      expect(s).toContain('top: 8px'); expect(s).toContain('bottom: 44px')
      expect(s).not.toContain('width')
      await w.find('[data-test="btn-maximize"]').trigger('click')
      expect(styleOf(w)).toContain('left: 8px')   // 最大化不再锚 268px
      w.unmount(); document.body.innerHTML = ''
    } finally { spy.mockRestore() }
  })
})
