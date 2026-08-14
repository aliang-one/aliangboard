import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import StatusSummaryCard from '../common/StatusSummaryCard.vue'

const PODS = [
  { status: 'Running' }, { status: 'Running' }, { status: 'Running' },
  { status: 'Pending' }, { status: 'Failed' }, { status: 'Succeeded' },
]

function mountCard(props = {}) {
  return mount(StatusSummaryCard, { props: { pods: PODS, ...props }, global: { plugins: [i18n] } })
}

test('donut option: 分段 = Running3/Pending1/Failed1/Other1;中心总数 6', () => {
  setOptionMock.mockClear()
  const w = mountCard()
  const data = setOptionMock.mock.calls[0][0].series[0].data
  expect(data.map(d => [d.name, d.value])).toEqual([['Running', 3], ['Pending', 1], ['Failed', 1], ['Other', 1]])
  expect(w.text()).toContain('6')
})

test('图例计数可见,点击 Running → emit filter Running;statusFilter=Running 再点 → All', async () => {
  const w = mountCard()
  expect(w.text()).toContain('Running')
  await w.findAll('button').find(b => b.text().includes('Running')).trigger('click')
  expect(w.emitted('filter')).toEqual([['Running']])
  await w.setProps({ statusFilter: 'Running' })
  await w.findAll('button').find(b => b.text().includes('Running')).trigger('click')
  expect(w.emitted('filter')).toEqual([['Running'], ['All']])
})

test('选中态:statusFilter=Running 的按钮带 primary 边框类', () => {
  const w = mountCard({ statusFilter: 'Running' })
  const active = w.findAll('button').find(b => b.text().includes('Running'))
  expect(active.classes().some(c => c.includes('border-primary'))).toBe(true)
})

test('空 pods: 不渲染 EChart,总数 0,图例为空', () => {
  setOptionMock.mockClear()
  const w = mountCard({ pods: [] })
  expect(setOptionMock).not.toHaveBeenCalled()
  expect(w.text()).toContain('0')
  expect(w.findAll('button').length).toBe(0)
})

test('Other 段非交互: 不渲染为 button(cursor-default),点击不 emit filter', async () => {
  const w = mountCard()
  // Other 是归并桶,真实状态才有按钮
  expect(w.findAll('button').some(b => b.text().includes('Other'))).toBe(false)
  expect(w.findAll('button').map(b => b.text()).join('|')).toContain('Running')
  expect(w.findAll('button').map(b => b.text()).join('|')).toContain('Pending')
  expect(w.findAll('button').map(b => b.text()).join('|')).toContain('Failed')
  // Other 段为非交互展示容器,展示 dot/名称/计数
  const otherSeg = w.findAll('span').find(s => s.classes().includes('cursor-default'))
  expect(otherSeg.text()).toContain('Other')
  expect(otherSeg.text()).toContain('1')
  await otherSeg.trigger('click')
  expect(w.emitted('filter')).toBeUndefined()
})
