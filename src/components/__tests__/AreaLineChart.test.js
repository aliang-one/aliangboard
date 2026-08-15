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
  setOptionMock.mockClear() // 上一例的 mock 调用持久,先清再断言负向
  const w = mountChart({ series: [1], height: 48 })
  expect(w.text()).toContain(i18n.global.t('common.noData'))
  expect(setOptionMock).not.toHaveBeenCalled()
})

test('refLines footer: label + value + unit,chip 背景为 token 色', () => {
  const w = mountChart({ series: [1, 2], refLines: [{ label: 'requests', value: 250, color: 'secondary' }], unit: 'm' })
  expect(w.text()).toContain('requests 250m')
  // DOM 可能把 hex 序列化为 rgb(),两者都接受
  const chip = w.findAll('span').find(s => (s.attributes('style') || '').includes('background'))
  expect(chip.attributes('style')).toMatch(/background:\s*(#4648d4|rgb\(70,\s*72,\s*212\))/)
})

test('samples 优先:传 samples 走 time 轴 option,[t,v] 数据', () => {
  setOptionMock.mockClear()
  const w = mountChart({
    samples: [{ t: 1000, v: 10 }, { t: 2000, v: 20 }],
    color: 'primary', unit: '%', height: 128,
  })
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.xAxis.type).toBe('time')
  expect(opt.series[0].data).toEqual([[1000, 10], [2000, 20]])
  w.unmount()
})

test('samples 不足 2 个有效样本:空态,不渲染图表', () => {
  setOptionMock.mockClear()
  const w = mountChart({ samples: [{ t: 1000, v: 10 }, { t: 'bad', v: 1 }] })
  expect(w.text()).toContain(i18n.global.t('common.noData'))
  expect(setOptionMock).not.toHaveBeenCalled()
})

test('series 路径不受影响:不传 samples 时仍走 interval 轴', () => {
  setOptionMock.mockClear()
  mountChart({ series: [1, 2, 3] })
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.xAxis.type).toBe('category')
})
