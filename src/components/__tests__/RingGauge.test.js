import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import RingGauge from '../common/RingGauge.vue'

test('value 有值: option value 夹取 + 中心显示 N% 与 label', () => {
  setOptionMock.mockClear()
  const w = mount(RingGauge, { props: { value: 42, label: 'CPU' } })
  expect(setOptionMock.mock.calls[0][0].series[0].data[0].value).toBe(42)
  expect(w.text()).toContain('42%')
  expect(w.text()).toContain('CPU')
})

test('value=null: 空态 —(图表 value=0)且仍渲染 label', () => {
  setOptionMock.mockClear()
  const w = mount(RingGauge, { props: { value: null } })
  expect(setOptionMock.mock.calls[0][0].series[0].data[0].value).toBe(0)
  expect(w.text()).toContain('—')
  expect(w.text()).toContain('CPU')
})

test('容器 pointer-events:none(不挡外层 router-link 点击)', () => {
  const w = mount(RingGauge, { props: { value: 10 } })
  expect(w.find('.pointer-events-none').exists()).toBe(true)
})
