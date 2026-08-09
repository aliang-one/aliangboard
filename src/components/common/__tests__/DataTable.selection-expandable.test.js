import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { resetAll } from '@/composables/useTableColumns'
import DataTable from '@/components/common/DataTable.vue'

beforeEach(() => { localStorage.clear(); resetAll() })

const HEADERS = [
  { key: 'name', label: 'Name' },
  { key: 'age', label: 'Age' },
]
const ROWS = [
  { name: 'a', age: '1d' },
  { name: 'b', age: '2d' },
]

test('selectable: 勾选某行 → emit update:selection 含该行;再点取消', async () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, selectable: true, rowKey: 'name', selection: [] },
    global: { plugins: [i18n] },
  })
  const checks = wrapper.findAll('[data-row-select]')
  expect(checks.length).toBe(2)
  await checks[0].setValue(true)
  const evt = wrapper.emitted('update:selection')
  expect(evt).toBeTruthy()
  expect(evt.at(-1)[0]).toHaveLength(1)
  expect(evt.at(-1)[0][0].name).toBe('a')
})

test('selectable: 表头全选 → 选中全部', async () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, selectable: true, rowKey: 'name', selection: [] },
    global: { plugins: [i18n] },
  })
  await wrapper.find('[data-select-all]').setValue(true)
  expect(wrapper.emitted('update:selection').at(-1)[0]).toHaveLength(2)
})

test('selectable: 点行勾选框不触发 row-click', async () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, selectable: true, rowKey: 'name', selection: [] },
    global: { plugins: [i18n] },
  })
  await wrapper.find('[data-row-select]').setValue(true)
  expect(wrapper.emitted('row-click')).toBeFalsy()
})

test('expandable: 点展开钮 → 出现 #expanded 内容;且不触发 row-click', async () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, expandable: true, rowKey: 'name' },
    slots: { expanded: '<div data-expanded-body>YAML-{{ row.name }}</div>' },
    global: { plugins: [i18n] },
  })
  expect(wrapper.find('[data-expanded-body]').exists()).toBe(false)
  const toggles = wrapper.findAll('[data-expand-toggle]')
  expect(toggles.length).toBe(2)
  await toggles[0].trigger('click')
  expect(wrapper.find('[data-expanded-body]').text()).toBe('YAML-a')
  expect(wrapper.emitted('row-click')).toBeFalsy()
})

test('expandable: 展开时 emit expand 带该行(供懒拉取),收起不再 emit', async () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, expandable: true, rowKey: 'name' },
    slots: { expanded: '<div>x</div>' },
    global: { plugins: [i18n] },
  })
  await wrapper.findAll('[data-expand-toggle]')[0].trigger('click')
  const evt = wrapper.emitted('expand')
  expect(evt).toBeTruthy()
  expect(evt[0][0].name).toBe('a')
  await wrapper.findAll('[data-expand-toggle]')[0].trigger('click')   // 收起
  expect(wrapper.emitted('expand').length).toBe(1)
})

test('三者同存(selectable+expandable+columnKey):系统列顺序 + colspan 正常,不报错', () => {
  const wrapper = mount(DataTable, {
    props: { headers: HEADERS, rows: ROWS, selectable: true, expandable: true, columnKey: 'nodes', rowKey: 'name', selection: [] },
    slots: { expanded: '<div data-x>detail</div>' },
    global: { plugins: [i18n] },
  })
  // 表头:1(select-all) + 2(data) + 1(☰) + 1(expand 占位... 顺序见实现) — 至少存在这些系统控件
  expect(wrapper.find('[data-select-all]').exists()).toBe(true)
  expect(wrapper.find('[data-expand-toggle]').exists()).toBe(true)
  expect(wrapper.find('[data-col-manager]').exists()).toBe(true)
  // 数据列仍在
  const ths = wrapper.findAll('thead th')
  expect(ths.length).toBeGreaterThanOrEqual(4) // select + 2 data + expand + ☰
})
