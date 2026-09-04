// SearchResults:搜索结果列表(内联下拉与 <lg 弹层共用一份渲染,消灭原复制粘贴)。
// 页面条(labelKey 文案 + 页面图标)与资源条(kind 图标 + name + kind · ns)统一 emit select。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SearchResults from '@/components/layout/SearchResults.vue'

const RESULTS = [
  { page: true, path: '/monitoring', labelKey: 'nav.monitoring', icon: 'monitoring' },
  { kind: 'Pod', name: 'api-7d9x', namespace: 'web' },
]

const mountList = (results = RESULTS) => mount(SearchResults, {
  props: { results },
  global: { mocks: { $t: k => k } },
})

test('渲染页面条:图标 + $t(labelKey) 文案,资源条:图标 + name + kind · ns', () => {
  const w = mountList()
  const rows = w.findAll('[data-test="search-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[0].text()).toContain('nav.monitoring')
  expect(rows[0].text()).toContain('monitoring')          // 页面图标
  expect(rows[1].text()).toContain('api-7d9x')
  expect(rows[1].text()).toContain('Pod')
  expect(rows[1].text()).toContain('web')
})

test('资源条无 namespace 不渲染 ns 段', () => {
  const w = mountList([{ kind: 'Node', name: 'worker-2', namespace: '' }])
  expect(w.find('[data-test="search-row"]').text()).not.toContain('undefined')
  expect(w.text()).not.toContain('·')                     // 无 ns 则无分隔点
})

test('点击行 emit select(item)', async () => {
  const w = mountList()
  await w.findAll('[data-test="search-row"]')[1].trigger('click')
  expect(w.emitted('select')[0][0]).toEqual(RESULTS[1])
})

test('空结果不渲染列表', () => {
  const w = mountList([])
  expect(w.find('[data-test="search-row"]').exists()).toBe(false)
})
