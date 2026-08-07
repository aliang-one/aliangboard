import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref, nextTick } from 'vue'
import { useEscClose } from '../useEscClose.js'

// 把 composable 包进一个空渲染组件里挂载(composable 依赖 setup 上下文的 watch/onBeforeUnmount)。
const mounted = []
function mountWithEsc(setup) {
  const Test = defineComponent({ setup, render() { return h('div') } })
  const wrapper = mount(Test)
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => { while (mounted.length) mounted.pop().unmount() })

function esc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
}

describe('useEscClose', () => {
  it('calls onClose when Escape pressed and open', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(true), onClose))
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(true), onClose))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not fire when isOpenRef is false', () => {
    const onClose = vi.fn()
    mountWithEsc(() => useEscClose(ref(false), onClose))
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('only closes the top modal when stacked', async () => {
    let closedA = 0, closedB = 0
    const openA = ref(true)
    const openB = ref(true)
    mountWithEsc(() => {
      useEscClose(openA, () => { closedA++; openA.value = false })
      useEscClose(openB, () => { closedB++; openB.value = false })
    })
    esc()
    await nextTick()
    expect(closedB).toBe(1)   // 栈顶 B 先关
    expect(closedA).toBe(0)
    esc()
    await nextTick()
    expect(closedA).toBe(1)   // B 关闭出栈后,轮到 A
  })

  it('stops firing after isOpenRef turns false', async () => {
    const onClose = vi.fn()
    const open = ref(true)
    mountWithEsc(() => useEscClose(open, onClose))
    open.value = false
    await nextTick()
    esc()
    expect(onClose).not.toHaveBeenCalled()   // 关闭后已移除监听
  })

  it('removes listener on unmount', () => {
    const onClose = vi.fn()
    const wrapper = mountWithEsc(() => useEscClose(ref(true), onClose))
    wrapper.unmount()
    esc()
    expect(onClose).not.toHaveBeenCalled()
  })
})
