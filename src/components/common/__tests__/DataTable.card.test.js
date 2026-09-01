import { test, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import DataTable from '@/components/common/DataTable.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

afterEach(() => { vi.restoreAllMocks() })
const headers = [
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态' },
  { key: 'age', label: '年龄', align: 'right' },
]
const rows = [{ name: 'web-0', status: 'Running', age: '2d' }]

async function mountTable(props = {}, slots = {}) {
  const w = mount(DataTable, { props: { headers, rows, ...props }, slots, global: { plugins: [i18n] } })
  await nextTick()
  return w
}

test('手机档:渲染卡片不渲染 table;首列 slot 作标题,其余列键值行复用同一 slot', async () => {
  mockViewport(true)
  const w = await mountTable({}, {
    name: '<b class="slot-name">{{ params.row.name }}</b>',
    status: '<i class="slot-status">{{ params.row.status }}</i>',
  })
  expect(w.find('table').exists()).toBe(false)
  expect(w.findAll('[data-card-row]')).toHaveLength(1)
  expect(w.find('.slot-name').text()).toBe('web-0')
  expect(w.find('.slot-status').text()).toBe('Running')
  // 键值行:非首列渲染「列名+slot 值」;首列不得重复出现在键值区
  const labels = w.findAll('[data-kv-label]').map(x => x.text())
  expect(labels).toEqual(['状态', '年龄'])
  w.unmount()
})

test('手机档:无自定义 slot 的列走 fallback 文本;fallback 缺失时首列仍在标题', async () => {
  mockViewport(true)
  const w = await mountTable()
  expect(w.find('[data-card-title]').text()).toBe('web-0')
  const kv = w.findAll('[data-kv-row]').map(x => x.text())
  expect(kv[0]).toContain('状态')
  expect(kv[0]).toContain('Running')
  w.unmount()
})

test('手机档:row-click 点卡片主体触发;checkbox/expand 点击 .stop 不触发 row-click', async () => {
  mockViewport(true)
  const w = await mountTable({ selectable: true, expandable: true, rowKey: 'name' }, {
    expanded: '<div class="expanded-body">详情</div>',
  })
  await w.find('[data-card-row]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  await w.find('input[data-card-select]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  expect(w.emitted('update:selection')[0][0]).toEqual([rows[0]])
  await w.find('[data-card-expand]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  expect(w.find('.expanded-body').exists()).toBe(true)
  w.unmount()
})

test('手机档:分页 slot 与空状态照常;桌面档无任何卡片 DOM', async () => {
  mockViewport(true)
  const w = await mountTable({}, { pagination: '<div class="pager">1 / 1</div>' })
  expect(w.find('.pager').exists()).toBe(true)
  w.unmount()
  const empty = await mountTable({ rows: [] })
  expect(empty.text()).toContain('暂无数据')
  empty.unmount()

  mockViewport(false)
  const d = await mountTable({ selectable: true }, {
    name: '<b class="slot-name">x</b>',
    pagination: '<div class="pager">1 / 1</div>',
  })
  expect(d.find('table').exists()).toBe(true)
  expect(d.find('[data-card-row]').exists()).toBe(false)
  expect(d.find('.pager').exists()).toBe(true)
  d.unmount()
})

test('手机档:checkbox 有 40px 命中区(w-5 h-5 + p-2 包裹);点 hit 区不触发 row-click', async () => {
  mockViewport(true)
  const w = await mountTable({ selectable: true, rowKey: 'name' })
  const hit = w.find('[data-card-select-hit]')
  expect(hit.classes()).toContain('p-2.5')
  const box = hit.find('input[data-card-select]')
  expect(box.classes()).toEqual(expect.arrayContaining(['w-5', 'h-5']))
  await hit.trigger('click')
  expect(w.emitted('row-click')).toBeUndefined()
  w.unmount()
})
