import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { resetAll } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'

// 每用例前清 localStorage + 重置模块单例(mutators 为模块级导出,无需 setup 上下文)。
beforeEach(() => { localStorage.clear(); resetAll() })

const mountMgr = () => mount(ColumnManager, { props: { tableKey: 'nodes' }, global: { plugins: [i18n] } })

test('ColumnManager: 勾掉 CPU → toggle 落库', async () => {
  const wrapper = mountMgr()
  const cpu = wrapper.findAll('label').find(l => l.text().includes('CPU'))
  expect(cpu).toBeTruthy()
  await cpu.find('input[type=checkbox]').setValue(false)
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2'))
  expect(persisted.nodes.hidden.cpu).toBe(true)
})

test('ColumnManager: 点击下移 → setOrder 落库,顺序改变', async () => {
  const wrapper = mountMgr()
  const moveDown = wrapper.findAll('button').find(b => b.attributes('title') === '下移')
  expect(moveDown).toBeTruthy()
  await moveDown.trigger('click')
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2'))
  expect(Array.isArray(persisted.nodes.order)).toBe(true)
  expect(persisted.nodes.order[0]).toBe('status') // name 下移一位 → status 升到首位
})

test('ColumnManager: 先隐藏再点重置 → 清空该表 overrides', async () => {
  const wrapper = mountMgr()
  const cpu = wrapper.findAll('label').find(l => l.text().includes('CPU'))
  await cpu.find('input[type=checkbox]').setValue(false)
  expect(JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2')).nodes.hidden.cpu).toBe(true)
  await wrapper.find('button.border-outline-variant').trigger('click') // 重置按钮(唯一带该类)
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2') || '{}')
  expect(persisted.nodes).toBeUndefined()
})
