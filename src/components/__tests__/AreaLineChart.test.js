import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import AreaLineChart from '../common/AreaLineChart.vue'

function mountChart(props) {
  return mount(AreaLineChart, { props, global: { plugins: [i18n] } })
}

test('series≥2: setOption 收到渐变/线色(token→hex 已解析)', () => {
  setOptionMock.mockClear()
  const w = mountChart({ series: [1, 2, 3], color: 'secondary', height: 48 })
  expect(setOptionMock).toHaveBeenCalledTimes(1)
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.series[0].lineStyle.color).toBe('#4648d4')
  expect(opt.series[0].areaStyle.color.colorStops[0].color).toBe('rgba(70,72,212,0.35)')
  w.unmount()
})

test('series<2: 空态文案 common.noData,不渲染图表', () => {
  const w = mountChart({ series: [1], height: 48 })
  expect(w.text()).toContain(i18n.global.t('common.noData'))
})

test('refLines footer: label + value + unit,chip 背景为 token 色', () => {
  const w = mountChart({ series: [1, 2], refLines: [{ label: 'requests', value: 250, color: 'secondary' }], unit: 'm' })
  expect(w.text()).toContain('requests 250m')
  // DOM 可能把 hex 序列化为 rgb(),两者都接受
  const chip = w.findAll('span').find(s => (s.attributes('style') || '').includes('background'))
  expect(chip.attributes('style')).toMatch(/background:\s*(#4648d4|rgb\(70,\s*72,\s*212\))/)
})
