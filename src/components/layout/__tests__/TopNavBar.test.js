// src/components/layout/__tests__/TopNavBar.test.js
// issue #3 顶栏溢出回归:整行可收缩链(搜索框优先缩)+ 名字截断后 title 兜底。
import { test, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/cluster' }), useRouter: () => ({ push: vi.fn() }) }))

import TopNavBar from '@/components/layout/TopNavBar.vue'
import { useClusterStore } from '@/stores/cluster'
import { useShellStore } from '@/stores/shell'

// 统一清场:防 spyOn/mockImplementation 跨文件泄漏(与既有单点 mockRestore 幂等共存)
afterEach(() => { vi.restoreAllMocks() })

function mountNav() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(TopNavBar, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

test('收缩链:搜索框包裹层 min-w-0,集群/ns 按钮包裹层 shrink-0', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  const searchWrap = w.find('header div.max-w-xs')
  expect(searchWrap.classes()).toContain('min-w-0')
  const clusterWrap = searchWrap.element.nextElementSibling
  expect(clusterWrap.className).toContain('shrink-0')
  const nsWrap = clusterWrap.nextElementSibling
  expect(nsWrap.className).toContain('shrink-0')
})

test('集群名截断后 title 可见全名;用户名 span truncate+max-w', () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useClusterStore()
  const longName = 'a-very-long-cluster-name-that-exceeds-180px-for-sure'
  store.savedClusters = [{ name: longName, apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = longName
  const w = mountNav()
  const clusterBtn = w.findAll('header button').find(b => b.text().includes('CLUSTER'))
  const nameSpan = clusterBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(nameSpan.attributes('title')).toBe(longName)
  const logoutBtn = w.findAll('header button').at(-1)
  const userSpan = logoutBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(userSpan.classes()).toContain('xl:max-w-[120px]')
})

test('紧凑档:集群/命名空间标签行 <xl 隐藏,值宽三级收缩', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  expect(w.html()).toContain('hidden xl:block')       // CLUSTER/NAMESPACE 标签行
  expect(w.html()).toContain('max-w-[80px] lg:max-w-[110px]')
})

test('集群下拉面板 Teleport 到 body 且带 data-testid', async () => {
  setActivePinia(createPinia())
  const w = mountNav()
  await w.find('[data-test="cluster-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]')).toBeTruthy()
  expect(w.find('[data-testid="cluster-dropdown-panel"]').exists()).toBe(false) // 不在组件树内
})

test('ns 下拉面板 Teleport 到 body 且带 data-testid', async () => {
  setActivePinia(createPinia())
  const w = mountNav()
  await w.find('[data-test="ns-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-testid="ns-dropdown-panel"]')).toBeTruthy()
  expect(w.find('[data-testid="ns-dropdown-panel"]').exists()).toBe(false) // 不在组件树内
})

test('手机档:顶栏左端汉堡可见,点击开抽屉;桌面档无汉堡', async () => {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  setActivePinia(createPinia())
  const w = mountNav()
  const btn = w.find('[data-test="menu-trigger"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  expect(useShellStore().drawerOpen).toBe(true)
  w.unmount()
  spy.mockRestore()

  const spy2 = vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  setActivePinia(createPinia())
  const w2 = mountNav()
  expect(w2.find('[data-test="menu-trigger"]').exists()).toBe(false)
  w2.unmount()
  spy2.mockRestore()
})

// === 手机档 Wave 4:单颗上下文胶囊 + 选择器 bottom sheet ===
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

function mountTopNav() {
  setActivePinia(createPinia())
  const store = useClusterStore()
  store.savedClusters = [{ name: 'kind-local', apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = 'kind-local'
  store.currentNamespace = 'default'
  return mountNav()
}

test('手机档:双 chip 不渲染,单颗上下文胶囊在场(ns 主/集群副);面板为底部面板', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(false)
  const cap = w.find('[data-test="context-capsule"]')
  expect(cap.exists()).toBe(true)
  expect(cap.text()).toContain('default')            // ns 主文本
  expect(cap.text()).toContain('kind-local')         // 集群副文本
  await cap.trigger('click')
  expect(w.vm.showNsDropdown).toBe(true)
  await flushPromises()
  // 既有 Teleport 用例不 unmount 会遗留桌面面板在 body,取最后一个(本用例的面板)
  const panel = Array.from(document.querySelectorAll('[data-testid="ns-dropdown-panel"]')).pop()
  expect(panel.getAttribute('data-bottom-sheet')).toBe('true')
  expect(panel.style.bottom).toBe('0px')
  w.unmount(); spy.mockRestore()
})

test('桌面档:双 chip 现状,胶囊不渲染,面板非底部面板', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="context-capsule"]').exists()).toBe(false)
  await w.find('[data-test="ns-trigger"]').trigger('click')
  await flushPromises()
  expect(Array.from(document.querySelectorAll('[data-testid="ns-dropdown-panel"]')).pop().getAttribute('data-bottom-sheet')).toBe('false')
  w.unmount(); spy.mockRestore()
})

test('<lg 档:搜索收成图标触发钮,弹层 Teleport 到 body 且开启时 enabled 查询', async () => {
  const mqSpy = vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {} }))
  setActivePinia(createPinia())
  const w = mountNav()
  expect(w.find('[data-test="search-trigger"]').exists()).toBe(true)
  expect(w.find('input[type="text"]').exists()).toBe(false) // 内联输入框不渲染
  await w.find('[data-test="search-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-test="search-modal"]')).toBeTruthy()
  mqSpy.mockRestore()
})

test('手机档:shell 通道请求 → 集群面板打开(bottom sheet)', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  useShellStore().requestClusterSelect()
  await nextTick()
  expect(w.vm.showClusterDropdown).toBe(true)
  await nextTick()
  // 既有 Teleport 用例不 unmount 会遗留桌面面板在 body,取最后一个(本用例的面板;同 ns 例注释)
  expect(Array.from(document.querySelectorAll('[data-testid="cluster-dropdown-panel"]')).pop().getAttribute('data-bottom-sheet')).toBe('true')
  w.unmount(); spy.mockRestore()
})
