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
  // 列管理弹层 Teleport 到 body + fixed(2026-09-01):表格根 overflow-hidden +
  // overflow-x-auto(overflow-y 计算为 auto)会裁切就地 absolute 弹层
  const panel = document.body.querySelector('[data-testid="col-manager-panel"]')
  expect(panel, '弹层应传送至 document.body').toBeTruthy()
  expect(wrapper.element.contains(panel)).toBe(false)
  expect(panel.style.position).toBe('fixed')
  expect(panel.style.zIndex).toBe('110')
  expect(panel.textContent).toContain('列管理') // ColumnManager 标题
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

test('DataTable: 拖拽途中卸载 → onBeforeUnmount 清理 window 监听(无泄漏)', async () => {
  // 复现 I1: pointerdown 启动拖拽 → window 上挂 pointermove/pointerup → 组件卸载。
  // 修复前:onUp 仅在 pointerup 触发,卸载时 listener 泄漏,后续 pointermove 仍调 setWidth。
  // 修复后:onBeforeUnmount(() => onUp()) 清理,pointermove 不再触发 setWidth。
  const wrapper = mount(DataTable, {
    props: { headers: [{ key: 'name', label: '名称' }, { key: 'status', label: '状态' }], rows: [], columnKey: 'nodes' },
    global: { plugins: [i18n] },
  })
  const handle = wrapper.find('th span.cursor-col-resize')
  expect(handle.exists()).toBe(true)
  // 启动拖拽:挂 window pointermove/pointerup
  await handle.trigger('pointerdown', { clientX: 100 })
  // 卸载(模拟路由切换 / v-if toggle):onBeforeUnmount 应清理监听
  wrapper.unmount()
  // 模拟卸载后的 pointermove:若监听已泄漏,setWidth 会被调用 → localStorage 出现 width 条目
  window.dispatchEvent(new Event('pointermove'))
  const raw = localStorage.getItem('aliangboard.tableColumns.v2')
  const persisted = raw ? JSON.parse(raw) : {}
  // 修复后:nodes 表无 width 条目(监听已移除,setWidth 未被调用)
  expect(persisted.nodes?.width).toBeUndefined()
})
