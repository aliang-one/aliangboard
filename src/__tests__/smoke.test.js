import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { classifyResource } from '../composables/useLayering.js'

// T6 冒烟测试：证明 vitest + happy-dom + @vue/test-utils + Vue 运行时 + 真实 src 模块导入全链路可用。
// 后续 T9 会在 http 原语 / cache / applyWatchEvent / ns 索引 / mapper 上补真实逻辑测试。
describe('vitest harness smoke', () => {
  it('runs pure assertions', () => {
    expect(1 + 1).toBe(2)
  })

  it('mounts a Vue component via @vue/test-utils + happy-dom', () => {
    const Hello = defineComponent({
      props: { name: { type: String, required: true } },
      setup: (props) => () => h('div', { class: 'greeting' }, `Hello, ${props.name}`),
    })
    const wrapper = mount(Hello, { props: { name: 'AliangBoard' } })
    expect(wrapper.classes()).toContain('greeting')
    expect(wrapper.text()).toBe('Hello, AliangBoard')
  })

  it('imports + exercises a real src module (useLayering.classifyResource)', () => {
    expect(typeof classifyResource).toBe('function')
    const r = classifyResource({ type: 'Deployment', name: 'web', image: 'nginx' })
    expect(typeof r).toBe('string')
  })
})
