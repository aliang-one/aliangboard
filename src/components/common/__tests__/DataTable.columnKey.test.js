import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { resetAll } from '@/composables/useTableColumns'
import DataTable from '@/components/common/DataTable.vue'

beforeEach(() => { localStorage.clear(); resetAll() })

const HEADERS = [
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态' },
]

test('DataTable: 不传 columnKey → 无列管理按钮(向后兼容)', () => {
  const wrapper = mount(DataTable, { props: { headers: HEADERS, rows: [{ name: 'a', status: 'ok' }] }, global: { plugins: [i18n] } })
  expect(wrapper.find('[data-col-manager]').exists()).toBe(false)
  expect(wrapper.findAll('th').length).toBe(2) // 仅两列,无额外 ☰ th
})

test('DataTable: 传 columnKey → 出现 ☰ 按钮,点击展开 ColumnManager 弹层', async () => {
  const wrapper = mount(DataTable, { props: { headers: HEADERS, rows: [{ name: 'a', status: 'ok' }], columnKey: 'nodes' }, global: { plugins: [i18n] } })
  expect(wrapper.find('[data-col-manager]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('列管理')
  await wrapper.find('[data-col-manager]').trigger('click')
  expect(wrapper.text()).toContain('列管理') // ColumnManager 标题
})

test('DataTable: header.width 被应用到 th style', () => {
  const wrapper = mount(DataTable, {
    props: { headers: [{ key: 'name', label: '名称', width: 200 }, { key: 'status', label: '状态' }], rows: [] },
    global: { plugins: [i18n] },
  })
  const ths = wrapper.findAll('th')
  expect(ths[0].attributes('style')).toContain('width: 200px')
  expect(ths[1].attributes('style') || '').not.toContain('width:')
})

test('DataTable: 可见列为 0 → 渲染空状态而非空表', () => {
  const wrapper = mount(DataTable, { props: { headers: [], rows: [{ name: 'a' }] }, global: { plugins: [i18n] } })
  expect(wrapper.text()).toContain('暂无数据') // common.noData 的 zh 文案
})
