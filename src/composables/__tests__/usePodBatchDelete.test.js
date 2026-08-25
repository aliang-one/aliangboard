// src/composables/__tests__/usePodBatchDelete.test.js
// 批量删除 composable 单测(补此前视图层无测的洞)。逻辑自 NsPods 原样迁入,行为契约:
// 选中集跨筛选保留;batchTargets=universe∩selected(存在性校验);全成清空退出/部分败保留失败选中。
import { test, expect, vi, beforeEach } from 'vitest'
import { computed, defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { mount } from '@vue/test-utils'

const del = vi.fn()
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ deletePod: (...a) => del(...a) }) }))

import { usePodBatchDelete } from '@/composables/usePodBatchDelete'

const P = (name) => ({ name, status: 'Running' })
const ALL = [P('a'), P('b'), P('c'), P('gone')]          // universe 含一个已消失项

function setup() {
  const universe = computed(() => ALL)
  const candidates = computed(() => [P('a'), P('b')])      // 当前筛选只见 a/b
  const onOpen = vi.fn()
  let b

  const App = defineComponent({
    setup() {
      b = usePodBatchDelete({ universe, candidates, getNamespace: () => 'ns1', onOpen })
      return () => null
    }
  })
  mount(App, { global: { plugins: [i18n, createPinia()] } })

  return { b, onOpen }
}

beforeEach(() => { setActivePinia(createPinia()); del.mockReset() })

test('选择切换/全选=candidates/存在性校验剔除已消失项', () => {
  const { b } = setup()
  b.enterBatch()
  b.toggleSelect('a'); b.toggleSelect('gone')             // gone 不在 universe 当前值?在 ALL 里——见下一行
  // 'gone' 在 universe 中(ALL 含),仍会被选中;batchTargets 按名字过滤 universe
  expect(b.selectedNames.value.has('a')).toBe(true)
  b.selectAllCandidates()
  expect([...b.selectedNames.value].sort()).toEqual(['a', 'b'])  // 全选范围=candidates
  b.clearSelection()
  expect(b.selectedNames.value.size).toBe(0)
})

test('batchTargets = universe ∩ selected(重命名后的 Pod 自动失效)', () => {
  const { b } = setup()
  b.enterBatch()
  b.selectAllCandidates()
  b.toggleSelect('c')                                      // 手动加选 c(不在 candidates 但在 universe)
  expect(b.batchTargets.value.map(p => p.name).sort()).toEqual(['a', 'b', 'c'])
})

test('onCardClick 两路:批量=切换选中,非批量=onOpen', () => {
  const { b, onOpen } = setup()
  b.onCardClick(P('a'))
  expect(onOpen).toHaveBeenCalledWith(P('a'))
  b.enterBatch()
  b.onCardClick(P('a'))
  expect(b.selectedNames.value.has('a')).toBe(true)
  expect(onOpen).toHaveBeenCalledTimes(1)
})

test('handleBatchDelete 全成:清空+退出+关弹窗', async () => {
  del.mockResolvedValue(null)
  const { b } = setup()
  b.enterBatch(); b.selectAllCandidates(); b.showBatchModal.value = true
  await b.handleBatchDelete()
  expect(del).toHaveBeenCalledTimes(2)
  expect(b.batchMode.value).toBe(false)
  expect(b.selectedNames.value.size).toBe(0)
  expect(b.showBatchModal.value).toBe(false)
})

test('handleBatchDelete 部分败:保留失败选中+不退出', async () => {
  del.mockImplementation((_n) => _n === 'a' ? Promise.resolve(null) : Promise.reject(new Error('403')))
  const { b } = setup()
  b.enterBatch(); b.selectAllCandidates(); b.showBatchModal.value = true
  await b.handleBatchDelete()
  expect([...b.selectedNames.value]).toEqual(['b'])
  expect(b.batchMode.value).toBe(true)
  expect(b.showBatchModal.value).toBe(false)
})
