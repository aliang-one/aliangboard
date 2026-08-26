import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WatchStateChip from '../WatchStateChip.vue'

// 组件内部 useI18n()，挂载须提供 i18n 插件（默认 zh，断言中文文案）
const mountIt = (props) => mount(WatchStateChip, { props, global: { plugins: [i18n] } })

describe('WatchStateChip', () => {
  it('live/reconnecting/degraded 渲染对应文案;off 不渲染', () => {
    expect(mountIt({ state: 'live' }).text()).toContain('实时')
    expect(mountIt({ state: 'reconnecting' }).text()).toContain('重连中')
    expect(mountIt({ state: 'degraded' }).text()).toContain('已降级轮询')
    expect(mountIt({ state: 'off' }).find('*').exists()).toBe(false)
  })
})
