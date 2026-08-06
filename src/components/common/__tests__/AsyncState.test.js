import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import AsyncState from '../AsyncState.vue'

// AsyncState 内部使用 useI18n()，挂载须提供 i18n 插件
const mountIt = (options) => mount(AsyncState, { global: { plugins: [i18n] }, ...options })

describe('AsyncState', () => {
  it('renders default slot content when idle', () => {
    const w = mountIt({ slots: { default: '<div class="data">rows here</div>' } })
    expect(w.find('.data').exists()).toBe(true)
    expect(w.text()).toContain('rows here')
  })

  it('shows spinner text when loading (slot hidden)', () => {
    const w = mountIt({ props: { loading: true }, slots: { default: 'never' } })
    expect(w.text()).toContain('加载中')
    expect(w.text()).not.toContain('never')
  })

  it('shows error.message + retry button; retry fires on click', async () => {
    const retry = vi.fn()
    const w = mountIt({ props: { error: new Error('boom'), retry } })
    expect(w.text()).toContain('boom')
    expect(w.find('button').exists()).toBe(true)
    await w.find('button').trigger('click')
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('no retry button when retry not provided', () => {
    const w = mountIt({ props: { error: 'oops' } })
    expect(w.find('button').exists()).toBe(false)
    expect(w.text()).toContain('oops')
  })

  it('errorText overrides derived message', () => {
    const w = mountIt({ props: { error: new Error('x'), errorText: '自定义文案' } })
    expect(w.text()).toContain('自定义文案')
    expect(w.text()).not.toContain(':x') // 原始 message 被覆盖
  })

  it('shows emptyText when empty', () => {
    const w = mountIt({ props: { empty: true, emptyText: '没有事件' } })
    expect(w.text()).toContain('没有事件')
  })

  it('prefers loading over error/empty', () => {
    const w = mountIt({ props: { loading: true, error: 'e', empty: true } })
    expect(w.text()).toContain('加载中')
  })
})
