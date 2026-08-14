// EChart 基座生命周期:init(md3+svg)/setOption/watch/dispose 全部经 mock 的 echarts 断言,
// 不在 happy-dom 里真渲染(真实渲染由 build + 手工 QA 覆盖)。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { setOptionMock, resizeMock, disposeMock } = vi.hoisted(() => ({
  setOptionMock: vi.fn(), resizeMock: vi.fn(), disposeMock: vi.fn(),
}))
vi.mock('@/lib/echarts', () => ({
  echarts: {
    use: vi.fn(), registerTheme: vi.fn(),
    init: vi.fn(() => ({ setOption: setOptionMock, resize: resizeMock, dispose: disposeMock })),
  },
}))
import { echarts } from '@/lib/echarts'
import EChart from '../common/EChart.vue'

test('挂载: init(el, md3, svg) + setOption(option);容器高度 = height', () => {
  setOptionMock.mockClear()
  const w = mount(EChart, { props: { option: { series: [] }, height: 64 } })
  expect(echarts.init).toHaveBeenCalledTimes(1)
  const [, theme, cfg] = echarts.init.mock.calls[0]
  expect(theme).toBe('md3')
  expect(cfg).toEqual({ renderer: 'svg' })
  expect(setOptionMock).toHaveBeenCalledWith({ series: [] })
  expect(w.element.style.height).toBe('64px')
})

test('option 变更 → 增量 setOption;卸载 → dispose', async () => {
  setOptionMock.mockClear(); disposeMock.mockClear()
  const w = mount(EChart, { props: { option: { a: 1 }, height: 32 } })
  await w.setProps({ option: { a: 2 } })
  expect(setOptionMock).toHaveBeenLastCalledWith({ a: 2 })
  w.unmount()
  expect(disposeMock).toHaveBeenCalledTimes(1)
})
