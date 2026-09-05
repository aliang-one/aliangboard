import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusChip from '../StatusChip.vue'

test('默认渲染状态点(Running 时呼吸)', () => {
  const w = mount(StatusChip, { props: { status: 'Running' } })
  expect(w.find('.animate-pulse-status').exists()).toBe(true)
})

test('dot=false 关闭内置点——宿主(PodCard 行首)已有状态点时防双呼吸点', () => {
  const w = mount(StatusChip, { props: { status: 'Running', dot: false } })
  expect(w.find('.w-2.h-2').exists()).toBe(false)
  expect(w.text()).toContain('Running')
})
