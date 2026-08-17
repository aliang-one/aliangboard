import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

// vi.hoisted 回调在 imports 解析前运行（此时 reactive 未定义，TDZ），故 reactive() 在外层应用
const { _routeObj, pushMock } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, path: '/cluster', params: {} },
  pushMock: vi.fn(),
}))
const routeRef = reactive(_routeObj)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    cluster: { name: 'prod-cluster', version: 'v1.28.2' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '../layout/SideNavBar.vue'

function mountSideNavBar() {
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

test('ns mode: 集群导航组隐藏、ns 资源组显示', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(true)
})

test('cluster mode: 集群导航组显示、ns 资源组隐藏', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(false)
})

test('ns mode: 顶部收缩为锚点条,无大头部', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-header"]').exists()).toBe(true)
  expect(w.find('[data-test="cluster-anchor"]').exists()).toBe(true)
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(false)
})

test('cluster mode: 顶部为大头部,无锚点条', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-brand"]').exists()).toBe(true)
  expect(w.find('[data-test="cluster-anchor"]').exists()).toBe(false)
})

test('ns mode: 点锚点条 → push /cluster', async () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  pushMock.mockClear()
  const w = mountSideNavBar()
  await w.find('[data-test="cluster-anchor"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/cluster')
})

test('ns mode: 角板存在、cluster-home 已移除,点角板 → push /cluster', async () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  pushMock.mockClear()
  const w = mountSideNavBar()
  const slab = w.find('[data-test="bottom-actions"] [data-test="cluster-slab"]')
  expect(slab.exists()).toBe(true)
  expect(slab.text()).toContain('prod-cluster')
  expect(slab.text()).toContain('集群概览')
  expect(w.find('[data-test="cluster-home"]').exists()).toBe(false)
  await slab.trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/cluster')
})

test('cluster mode: 无角板、底部仅活动+设置', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-slab"]').exists()).toBe(false)
  expect(w.find('[data-test="bottom-events"]').exists()).toBe(false)
  expect(w.find('[data-test="bottom-activity"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-settings"]').exists()).toBe(true)
})

test('ns mode: 部署+集群+3 图标同在单一 dock 板块,dock 内 icon-only(title 提示)', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  // 部署/集群 hero/3 图标同在 .dock 板块内,不单独漂浮
  const dock = w.find('[data-test="bottom-actions"] .dock')
  expect(dock.exists()).toBe(true)
  expect(dock.find('[data-test="deploy-card"]').exists()).toBe(true)
  expect(dock.find('[data-test="cluster-slab"]').exists()).toBe(true)
  const igs = dock.findAll('.dock-ig')
  expect(igs.length).toBe(4)
  igs.forEach(ig => {
    expect(ig.find('.material-symbols-outlined').exists()).toBe(true)
    expect(ig.attributes('title')).toBeTruthy()
    expect(ig.find('.dock-ig__lb').exists()).toBe(false)
  })
  // 部署横跨底行(高频入口最大点击面),设置为普通瓦片
  expect(dock.find('[data-test="deploy-card"]').classes()).toContain('col-span-3')
  expect(dock.find('[data-test="deploy-card"]').text()).toContain('部署')
})

test('集群态: ns-home 内有 ns-enter(进入下层); ns 态无', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  expect(mountSideNavBar().find('[data-test="ns-enter"]').exists()).toBe(true)
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  expect(mountSideNavBar().find('[data-test="ns-enter"]').exists()).toBe(false)
})

test('ns mode: 部署入口(dock 绿瓦片)存在且点击 → NsDeploy', async () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  pushMock.mockClear()
  const w = mountSideNavBar()
  const card = w.find('[data-test="deploy-card"]')
  expect(card.exists()).toBe(true)
  expect(card.find('.material-symbols-outlined').text()).toBe('rocket_launch')
  expect(card.attributes('title')).toBeTruthy()
  await card.trigger('click')
  expect(pushMock).toHaveBeenCalledWith({ name: 'NsDeploy', params: { namespace: 'default' } })
})

test('cluster mode: 无部署入口', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="deploy-card"]').exists()).toBe(false)
})
