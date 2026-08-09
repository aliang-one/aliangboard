import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { i18n } from '@/i18n'
import {
  useTableColumns, resetAll, toggle, setOrder, setWidth,
  resetTable, isHidden, loadAndMigrate,
} from '../useTableColumns.js'

// tableColumns/allColumns 依赖 useI18n,须在组件 setup 内经 useTableColumns() 调用。
// mutators / loadAndMigrate 是模块级导出(不依赖 i18n),可在用例中直接调,
// 操作的是与 useTableColumns() 同一份模块单例 config。
function readers() {
  let captured
  mount(defineComponent({
    setup() { captured = useTableColumns(); return () => h('div') },
  }), { global: { plugins: [i18n] } })
  return captured
}

describe('useTableColumns', () => {
  beforeEach(() => { localStorage.clear(); resetAll() })

  it('tableColumns: 默认全部可见且 label 已翻译(zh)', () => {
    const r = readers()
    expect(r.tableColumns('nodes').map(x => x.key)).toEqual(['name', 'status', 'roles', 'system', 'cpu', 'memory', 'pods', 'age', 'actions'])
    expect(r.tableColumns('nodes')[0].label).toBe('名称') // cols._c.name → zh
  })

  it('toggle: 隐藏/显示,tableColumns 即时反映(同一模块单例)', () => {
    toggle('nodes', 'cpu')
    const r = readers()
    expect(r.tableColumns('nodes').map(x => x.key)).not.toContain('cpu')
    expect(r.allColumns('nodes').find(x => x.key === 'cpu').hidden).toBe(true)
    toggle('nodes', 'cpu')
    expect(readers().tableColumns('nodes').map(x => x.key)).toContain('cpu')
  })

  it('setOrder: 重排后 tableColumns 顺序变化', () => {
    setOrder('nodes', ['actions', 'name'])
    expect(readers().tableColumns('nodes').map(x => x.key).slice(0, 2)).toEqual(['actions', 'name'])
  })

  it('setWidth: 限幅 60–600 并合并到列上,且持久化', () => {
    setWidth('nodes', 'name', 9999)
    expect(readers().tableColumns('nodes').find(x => x.key === 'name').width).toBe(600)
    expect(JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2')).nodes.width.name).toBe(600)
  })

  it('resetTable / resetAll: 清回默认', () => {
    toggle('nodes', 'cpu'); toggle('workloads', 'type')
    resetTable('nodes')
    expect(isHidden('nodes', 'cpu')).toBe(false)
    expect(isHidden('workloads', 'type')).toBe(true)
    resetAll()
    expect(isHidden('workloads', 'type')).toBe(false)
  })

  it('v1→v2 迁移: loadAndMigrate 读 v1 写 v2', () => {
    localStorage.setItem('aliangboard.tableColumns.v1', JSON.stringify({ nodes: { cpu: false } }))
    localStorage.removeItem('aliangboard.tableColumns.v2')
    const cfg = loadAndMigrate()
    expect(cfg.nodes.hidden.cpu).toBe(true)
    expect(JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2')).nodes.hidden.cpu).toBe(true)
  })
})
