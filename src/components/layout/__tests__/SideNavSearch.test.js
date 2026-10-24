// src/components/layout/__tests__/SideNavSearch.test.js
// 顶栏退役 Task 6:SideNavSearch 搜索宿主三态自适应(desktop 内联+Teleport 下拉 /
// rail 图标钮+弹层 / drawer 抽屉内联+贴底 sheet)。本文件钉住:
//  - 惰性查询门控(Review Focus 4):focus 前惰性组 enabled=false(namespaces 常驻组除外),
//    focus 后同批 computed 引用翻转 true——开框才发请求,关框零请求;
//  - ⌘K 三态(desktop 聚焦内联框 / rail 开弹层 / 焦点在 textarea 内不抢,Review Focus 3);
//  - 三形态互斥(rail 无内联框、drawer 无 rail 钮)+ 结果面随查询显隐。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ push: vi.fn(), useResourceList: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }), useRoute: () => ({ path: '/cluster', fullPath: '/cluster' }) }))
vi.mock('@/composables/useK8sQuery', () => ({ useResourceList: mocks.useResourceList }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', cluster: { name: 't', version: 'v1' },
    nodeList: [], namespaceList: [], fetchNamespaces: vi.fn(),
    fetchPods: vi.fn(), fetchWorkloads: vi.fn(), fetchServices: vi.fn(), fetchIngresses: vi.fn(),
    fetchConfigMaps: vi.fn(), fetchSecrets: vi.fn(), fetchPVCs: vi.fn(), fetchHPAs: vi.fn(),
    fetchRoles: vi.fn(), fetchRoleBindings: vi.fn(), fetchClusterRoleBindings: vi.fn(),
    fetchServiceAccounts: vi.fn(), fetchNetworkPolicies: vi.fn(), fetchResourceQuotas: vi.fn(),
    fetchLimitRanges: vi.fn(), fetchPDBs: vi.fn(), fetchStorageClasses: vi.fn(),
    fetchPVs: vi.fn(), fetchCRDs: vi.fn(), fetchEvents: vi.fn(),
  }),
}))
vi.mock('@/api/client', async (importOriginal) => {
  const orig = await importOriginal()
  return { ...orig, getSession: () => 'sess' }
})

import SideNavSearch from '../SideNavSearch.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
// 双断点 mock(rail=belowLg && !belowSm;desktop=两者皆 false;drawer=两者皆 true)
const mockBp = (belowLg, belowSm) => vi.spyOn(window, 'matchMedia').mockImplementation(q => ({
  matches: q === '(max-width: 1023.98px)' ? belowLg : q === '(max-width: 639.98px)' ? belowSm : false,
  addEventListener: () => {}, removeEventListener: () => {},
}))

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  mocks.push.mockReset()
  // enabled 以 ref 形态被消费,记录每次调用(真实形态:全部惰性组共享同一 searchEnabled computed 引用)
  mocks.useResourceList.mockImplementation(({ options }) => {
    return { data: { value: [] }, __enabled: options?.enabled }
  })
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

function mountSearch({ attach = false } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(SideNavSearch, {
    ...(attach ? { attachTo: document.body } : {}),
    global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] },
  })
}

// 惰性组 = key[2] 非 'namespaces' 的 useResourceList 调用(namespaces 为常驻组,选择器需要)
const lazyCalls = () => mocks.useResourceList.mock.calls.filter(c => c[0].key?.[2] !== 'namespaces')
const nsCall = () => mocks.useResourceList.mock.calls.find(c => c[0].key?.[2] === 'namespaces')

test('桌面:开框才 enabled,关框零请求(Review Focus 4)', async () => {
  mockBp(false, false)
  const w = mountSearch()
  expect(lazyCalls().length).toBeGreaterThanOrEqual(20) // 20 类惰性资源组
  // focus 前:惰性组 enabled 全 false(ref 形态,关框零请求)
  expect(lazyCalls().every(c => { const e = c[0].options?.enabled; return e === false || e?.value === false })).toBe(true)
  // namespaces 常驻组除外:恒 enabled(getSession 桩 'sess' → truthy)
  expect(nsCall()[0].options.enabled.value).toBe(true)
  await w.find('[data-test="search-input"]').trigger('focus')
  await nextTick()
  // 惰性组 enabled 全部翻转 true(实现细节:同一 computed 引用,无需新调用)
  expect(lazyCalls().every(c => c[0].options?.enabled?.value === true)).toBe(true)
  w.unmount()
})

test('⌘K 桌面:聚焦内联输入框', async () => {
  mockBp(false, false)
  // attachTo:focus() 只在元素挂进 document 时才会改写 activeElement
  const w = mountSearch({ attach: true })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await nextTick()
  expect(document.activeElement).toBe(w.find('[data-test="search-input"]').element)
  w.unmount()
})

test('⌘K rail:打开弹层', async () => {
  mockBp(true, false)
  const w = mountSearch()
  expect(w.find('[data-test="search-trigger"]').exists()).toBe(true) // rail 形态:图标钮取代内联框
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="search-modal"]')).toBeTruthy()
  w.unmount()
})

test('⌘K 焦点在 textarea 内不抢(Review Focus 3)', async () => {
  mockBp(false, false)
  const w = mountSearch({ attach: true })
  // 事件必须从 textarea 派发(真实路径 target=可编辑元素,冒泡到 window)
  const ta = document.createElement('textarea')
  document.body.appendChild(ta)
  ta.focus()
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await nextTick()
  expect(document.activeElement).toBe(ta) // 焦点未被夺走
  ta.remove()
  w.unmount()
})

test('drawer(手机):内联框在场无 rail 钮;⌘K no-op 不开弹层;有词出贴底 sheet', async () => {
  mockBp(true, true)
  const w = mountSearch({ attach: true })
  expect(w.find('[data-test="search-trigger"]').exists()).toBe(false)
  const input = w.find('[data-test="search-input"]')
  expect(input.exists()).toBe(true)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="search-modal"]')).toBeFalsy() // ⌘K drawer no-op
  await input.trigger('focus')
  await input.setValue('monitor')
  await flushPromises()
  expect(document.body.querySelector('[data-test="search-sheet"]')).toBeTruthy() // 贴底 sheet
  expect(document.body.querySelector('[data-test="search-row"]')).toBeTruthy() // 页面条目命中(/monitoring)
  w.unmount()
})

test('桌面:有结果才开 Teleport 下拉(resultsOpen),清词收起', async () => {
  mockBp(false, false)
  const w = mountSearch({ attach: true })
  const input = w.find('[data-test="search-input"]')
  await input.trigger('focus')
  expect(document.body.querySelector('[data-test="search-dropdown"]')).toBeFalsy() // 无词不开面板
  await input.setValue('monitor')
  await flushPromises()
  expect(document.body.querySelector('[data-test="search-dropdown"]')).toBeTruthy()
  await input.setValue('')
  await flushPromises()
  expect(document.body.querySelector('[data-test="search-dropdown"]')).toBeFalsy()
  w.unmount()
})
