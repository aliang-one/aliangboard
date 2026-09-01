// FilterBar 手机折叠面板测试:手机档筛选条件默认收起,点筛选钮展开;桌面档恒展开
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

// 照 SideNavBar.drawer.test.js 模式 mock matchMedia
let matchMediaSpy
const mqListeners = new Map()
function fireChange(query, matches) {
  const cb = mqListeners.get(query)
  if (cb) cb({ matches })
}
function mockBelowSm(below) {
  matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? below : false,
    addEventListener: (_ev, cb) => { mqListeners.set(q, cb) },
    removeEventListener: () => { mqListeners.delete(q) },
  }))
}

import FilterBar from '@/components/common/FilterBar.vue'

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { matchMediaSpy?.mockRestore(); document.body.innerHTML = '' })

async function mountFilterBar(props = {}) {
  const defaultFilters = [
    { key: 'status', label: 'Status', options: ['All', 'Running', 'Pending'] },
  ]
  return mount(FilterBar, {
    props: { filters: defaultFilters, resultCount: 0, resultLabel: 'results', ...props },
    global: { plugins: [i18n] },
  })
}

test('手机档:筛选条件默认收起,点筛选钮展开;结果计数恒可见', async () => {
  mockBelowSm(true)
  const w = await mountFilterBar()
  const filterFields = w.find('[data-filter-fields]')
  expect(filterFields.exists()).toBe(true)
  expect(filterFields.attributes().style).toContain('display: none')
  expect(w.text()).toContain('0') // resultCount 恒可见
  await w.find('[data-test="filter-toggle"]').trigger('click')
  expect(filterFields.attributes().style).toBeFalsy()
  w.unmount()
})

test('桌面档:筛选条件恒展开,无筛选钮', async () => {
  mockBelowSm(false)
  const w = await mountFilterBar()
  const filterFields = w.find('[data-filter-fields]')
  expect(filterFields.exists()).toBe(true)
  expect(filterFields.attributes().style).toBeUndefined()
  expect(w.find('[data-test="filter-toggle"]').exists()).toBe(false)
  w.unmount()
})
